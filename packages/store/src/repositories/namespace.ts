import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { NamespaceRef } from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { newDataKey, periodKeyAad, unwrapUnder, wrapUnder, type KeyRing } from "../crypto.js";
import { NamespaceNotFound, NamespaceShredded, PayloadExpired } from "../errors.js";
import { expiresAt, type RetentionPolicy } from "../retention.js";

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
    // Needed at mint and nowhere else: expires_at is fixed on the row from
    // the period and the policy in force (R2). Required rather than
    // defaulted, for the reason the key ring has no default master key -- a
    // fallback policy is a policy that reaches production.
    private readonly policy: RetentionPolicy,
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
    if (!row) throw new NamespaceNotFound(`no namespace ${namespaceId}`);
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
   * A repeated erasure request is not an error, and the first erasure's
   * timestamp is the one that survives it: that timestamp is the compliance
   * record, so the `coalesce` keeps it rather than moving it to the latest
   * request. An erasure request for an identifier with no row is an error,
   * and a named one. Resolving it as success would tell an operator the data
   * is gone when nothing was examined.
   *
   * One statement for all three cases, and the affected row count tells the
   * missing row apart from the repeat.
   */
  async shred(namespaceId: string): Promise<void> {
    const result = await this.db
      .updateTable("namespace")
      .set({
        data_key_wrapped: null,
        key_shredded_at: sql<Date>`coalesce(key_shredded_at, ${this.clock.now()})`,
      })
      .where("namespace_id", "=", namespaceId)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new NamespaceNotFound(`no namespace ${namespaceId} to shred`);
    }
  }

  /**
   * Mints the month key for this (namespace, period) if it does not exist.
   *
   * Insert-on-conflict-do-nothing, the same shape and for the same reason as
   * `ensure`: an upsert that wrote `key_wrapped` on conflict would re-key a
   * month, stranding every payload already sealed under the first key, and
   * would mint a fresh key for a month that had been expired, quietly undoing
   * the erasure. `do nothing` leaves an expired row exactly as it is.
   *
   * `dataKey` is read first, so a shredded namespace refuses before any row is
   * written: there is no inner key to mint under a null outer one. That is
   * also the restatement M1's re-key argument needed once period keys existed
   * (F9): a namespace shred is total because the outer key is gone, not
   * because readable and unreadable rows may not sit behind one marker --
   * under period keys, that is the designed normal state.
   */
  async periodKey(namespaceId: string, period: string): Promise<void> {
    const dataKey = await this.dataKey(namespaceId);
    await this.db
      .insertInto("namespace_key")
      .values({
        namespace_id: namespaceId,
        period,
        key_wrapped: wrapUnder(dataKey, newDataKey(), periodKeyAad(namespaceId, period)),
        expires_at: expiresAt(period, this.policy),
        shredded_at: null,
        created_at: this.clock.now(),
      })
      .onConflict((oc) => oc.columns(["namespace_id", "period"]).doNothing())
      .execute();
  }

  /**
   * The month key, or a named refusal saying which of the two erasures
   * happened.
   *
   * `dataKey` first, so a shredded namespace raises NamespaceShredded and
   * never PayloadExpired. The order is the whole point: an operator told a
   * month expired, when the counterparty space was erased on request, would
   * go looking for a retention sweep instead of the erasure that actually
   * happened. The namespace is the outer key and its refusal wins.
   *
   * A period with no row is a caller defect rather than a store condition --
   * the only reader is a path whose row already exists - so it is a plain
   * Error, as `ensure` does for a namespace that vanished after its insert.
   */
  async openPeriodKey(namespaceId: string, period: string): Promise<Buffer> {
    const dataKey = await this.dataKey(namespaceId);
    const row = await this.db
      .selectFrom("namespace_key")
      .select(["key_wrapped", "shredded_at"])
      .where("namespace_id", "=", namespaceId)
      .where(sql<boolean>`period = ${period}::date`)
      .executeTakeFirst();
    if (!row) throw new Error(`no month key ${period} for namespace ${namespaceId}`);
    if (row.key_wrapped === null) {
      throw new PayloadExpired(
        `the month ${period} of namespace ${namespaceId} expired at ` +
          `${row.shredded_at?.toISOString()}; its payloads are unreadable`,
      );
    }
    return unwrapUnder(dataKey, row.key_wrapped, periodKeyAad(namespaceId, period));
  }

  /**
   * Every period this namespace holds a key row for, as text.
   *
   * Rendered `period::text` in SQL, like every other read of the column: the
   * driver parses a `date` at LOCAL midnight, so a Date here would be the
   * previous day east of UTC and this list would name months that are off by
   * one on exactly the machines this project runs on.
   */
  async periodsOf(namespaceId: string): Promise<string[]> {
    const rows = await sql<{ period: string }>`
      select period::text as period from namespace_key
      where namespace_id = ${namespaceId} order by period`.execute(this.db);
    return rows.rows.map((r) => r.period);
  }
}
