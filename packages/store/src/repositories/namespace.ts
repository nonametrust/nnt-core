import { randomUUID } from "node:crypto";
import type { NamespaceRef } from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { newDataKey, type KeyRing } from "../crypto.js";
import { NamespaceShredded } from "../errors.js";

export interface StoredNamespace {
  namespaceId: string;
  kind: string;
  nsId: string;
  shreddedAt: Date | null;
}

export class NamespaceRepository {
  constructor(
    private readonly db: Db,
    private readonly ring: KeyRing,
    private readonly clock: Clock,
  ) {}

  /**
   * Returns the namespace for this reference, creating it with a fresh data
   * key on first sight.
   *
   * Insert-then-select rather than an upsert on purpose: an upsert that wrote
   * `data_key_wrapped` on conflict would mint a new key for a shredded
   * namespace and quietly undo the erasure. `do nothing` leaves a shredded row
   * exactly as it was.
   */
  async ensure(ref: NamespaceRef): Promise<StoredNamespace> {
    // The identifier is generated before the wrap because it is the wrap's
    // associated data. On conflict the row and this key are both discarded,
    // which is what keeps a shredded namespace shredded.
    //
    // The wrap is bound to the UTF-8 of this exact string, and `dataKey`
    // unwraps under the string Postgres reports for the `uuid` column. Both
    // are the lowercase canonical form, `randomUUID()` by RFC 4122 and
    // Postgres by its uuid output function, and namespace.test.ts pins that
    // they agree, because the failure if they ever stopped agreeing is every
    // unwrap in the store refusing with an error that mentions neither.
    const namespaceId = randomUUID();
    await this.db
      .insertInto("namespace")
      .values({
        namespace_id: namespaceId,
        kind: ref.kind,
        ns_id: ref.id,
        data_key_wrapped: this.ring.wrap(newDataKey(), namespaceId),
        key_shredded_at: null,
        created_at: this.clock.now(),
      })
      .onConflict((oc) => oc.constraint("namespace_identity").doNothing())
      .execute();
    const found = await this.find(ref.kind, ref.id);
    if (!found) throw new Error(`namespace ${ref.kind} disappeared after insert`);
    return found;
  }

  async find(kind: string, id: string): Promise<StoredNamespace | null> {
    const row = await this.db
      .selectFrom("namespace")
      .select(["namespace_id", "kind", "ns_id", "key_shredded_at"])
      .where("kind", "=", kind)
      .where("ns_id", "=", id)
      .executeTakeFirst();
    return row
      ? {
          namespaceId: row.namespace_id,
          kind: row.kind,
          nsId: row.ns_id,
          shreddedAt: row.key_shredded_at,
        }
      : null;
  }

  async dataKey(namespaceId: string): Promise<Buffer> {
    const row = await this.db
      .selectFrom("namespace")
      .select(["namespace_id", "data_key_wrapped"])
      .where("namespace_id", "=", namespaceId)
      .executeTakeFirst();
    if (!row) throw new Error(`no namespace ${namespaceId}`);
    if (row.data_key_wrapped === null) {
      throw new NamespaceShredded(
        `namespace ${namespaceId} was shredded; its payloads are unreadable`,
      );
    }
    // Unwrapped under the spelling the database reports, not the caller's.
    // The uuid column locates the row whatever case the caller spelled it in,
    // but the wrap's associated data is bytes, and the bytes it was bound to
    // are the canonical form the database hands back.
    return this.ring.unwrap(row.data_key_wrapped, row.namespace_id);
  }

  /**
   * Crypto-shredding. Dropping the wrapped key makes every payload for this
   * namespace permanently unreadable while the rows stay in place, so counts,
   * timestamps and the audit chain remain intact and verifiable. That is the
   * correct shape for an erasure request against an append-only ledger.
   *
   * Idempotent: a repeated erasure request is not an error.
   */
  async shred(namespaceId: string): Promise<void> {
    await this.db
      .updateTable("namespace")
      .set({ data_key_wrapped: null, key_shredded_at: this.clock.now() })
      .where("namespace_id", "=", namespaceId)
      .where("data_key_wrapped", "is not", null)
      .execute();
  }
}
