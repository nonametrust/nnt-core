import { randomUUID } from "node:crypto";
import { sql, type RawBuilder } from "kysely";
import type { NamespaceRef } from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { newDataKey, periodKeyAad, unwrapUnder, wrapUnder, type KeyRing } from "../crypto.js";
import {
  NamespaceNotFound, NamespaceShredded, PayloadExpired, PeriodKeyAltered, mapPgError,
} from "../errors.js";
import { assertRetentionPolicy, expiresAt, type RetentionPolicy } from "../retention.js";

/**
 * How a `date` column becomes the string this package binds keys to and hands
 * back to callers.
 *
 * NOT `period::text`, which renders through the server's DateStyle: the same
 * date is `2026-09-01` under ISO, `01.09.2026` under German and `09/01/2026`
 * under SQL/MDY. The month key's associated data is built from this string,
 * so a key minted under one DateStyle and opened under another refuses as
 * CiphertextRejected -- a tamper report for a postgresql.conf line, or for an
 * `alter role ... set datestyle`. It is the same class of mistake as reading
 * a `date` back as a driver Date (R8), and the same class of mistake as the
 * naive CHECK that inherits the session's TimeZone: a value that depends on a
 * setting no migration controls.
 *
 * `to_char` with an explicit pattern depends on nothing. It is only STABLE
 * rather than immutable, which would matter in a check constraint or an index
 * and does not matter here.
 */
export const PERIOD_TEXT = (column: RawBuilder<unknown>) =>
  sql<string>`to_char(${column}, 'YYYY-MM-DD')`;

/**
 * One month the sweep made unreadable.
 *
 * This carried a `reason` of `"retention-expiry" | "erased-namespace"` for
 * one commit and adversarial review took it apart, correctly. Two things were
 * wrong with it and both are worth keeping written down, because the union
 * read as the more careful design and was the less honest one.
 *
 * It asserted an exclusivity the data does not have. The sweep's WHERE admits
 * only rows past their grace, so EVERY row it returns is a retention expiry;
 * belonging to an erased namespace is an additional fact about the same row,
 * not an alternative to it. Measured consequence: a month whose grace ran out
 * three weeks BEFORE its namespace was erased -- a sweep that did not run,
 * then an erasure request -- came back as `erased-namespace` and vanished
 * from the retention count, which is exactly the outage case someone would be
 * counting in order to find.
 *
 * And it named a cause the code never reads. The sweep does not select a row
 * because a namespace was erased; it selects on `expires_at <= now` and then
 * looks at what the namespace column says AT THAT MOMENT. So the flag is
 * state, and it is named for state.
 *
 * What M4 gets from the pair: the retention count is every row, and
 * `namespaceErasedAtSweep` says which of those months belonged to a
 * counterparty space already erased on request. The compliance record for
 * THAT erasure is `namespace.key_shredded_at` and never this sweep -- these
 * months had been unreadable through the API since that instant, and what
 * the sweep changed is that their keys are no longer sitting live under a
 * dead one.
 */
export interface ExpiredPeriod {
  namespaceId: string;
  period: string;
  /**
   * Whether the namespace was erased on request as of the sweep's snapshot.
   * Not a cause, and not history: a namespace erased after this sweep reads
   * false here forever, and one whose key was restored by hand reads false
   * on the next sweep. Under READ COMMITTED the joined `namespace` row is the
   * statement's snapshot, so an erasure committing while the sweep is in
   * flight reads false -- measured, with the sweep blocked on a row lock.
   */
  namespaceErasedAtSweep: boolean;
}

export interface SweepResult {
  shredded: ExpiredPeriod[];
}

export interface StoredNamespace {
  namespaceId: string;
  kind: string;
  nsId: string;
  shreddedAt: Date | null;
}

/**
 * The order `expirePeriods` reports its rows in: namespace, then period, both
 * by CODE POINT.
 *
 * Not `localeCompare`, which is what stood here. `localeCompare` with no
 * locale argument uses the RUNTIME's default, so the order of a sweep was a
 * property of `LANG` rather than of the data -- and this machine runs
 * `tr_TR.UTF-8`, one of the few collations that reorders letters outright.
 * The comment below the sort says an M4 audit body built from an array that
 * reorders itself between runs is not reproducible; an array that reorders
 * itself between HOSTS is the same defect with a longer fuse, and it would
 * have shown up as two operators disagreeing about a row neither could
 * reproduce.
 *
 * Today's ids cannot expose the difference -- Postgres renders a uuid as
 * lowercase hex and a period as an ISO date, and every collation agrees on
 * those -- so this is pinned at the comparator rather than through a sweep.
 * That is the point: the rule is "this order does not depend on the host",
 * and a test that can only use data where the two agree cannot state it.
 */
export function sweepOrder(
  a: { namespaceId: string; period: string },
  b: { namespaceId: string; period: string },
): number {
  if (a.namespaceId !== b.namespaceId) return a.namespaceId < b.namespaceId ? -1 : 1;
  if (a.period === b.period) return 0;
  return a.period < b.period ? -1 : 1;
}

export class NamespaceRepository {
  constructor(
    private readonly db: Db,
    private readonly ring: KeyRing,
    // Readable for the same reason `policy` below is: the observation
    // repository refuses a clock that is not this one, rather than trusting
    // a convention. Two repositories on one namespace with two clocks would
    // stamp `ingested_at` from one and compute the cap's window and the
    // month's expiry from the other, and nothing downstream compares them --
    // which is the same failure the policy guard exists for, one field over.
    readonly clock: Clock,
    // Needed at mint and nowhere else: expires_at is fixed on the row from
    // the period and the policy in force (R2). Required rather than
    // defaulted, for the reason the key ring has no default master key -- a
    // fallback policy is a policy that reaches production.
    // Readable so the observation repository can refuse a mismatch rather
    // than trust a convention; see its constructor.
    readonly policy: RetentionPolicy,
  ) {
    // The docstring on assertRetentionPolicy said "the composition point calls
    // this once, and every arithmetic trusts it". There was no composition
    // point: nothing in src called it at all, so a fractional graceDays wrote
    // a fractional expiry silently and a negative one surfaced three layers
    // down as a 23514 from a check constraint that was never meant to be the
    // one refusing it. That made this the sixth property on this branch that
    // was true only because nothing enforced it.
    //
    // Here is where a policy enters the store, so here is where it is refused.
    assertRetentionPolicy(policy);
  }

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
      .execute()
      .catch((e: unknown) => { throw mapPgError(e) ?? e; });
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
    // Mapped, because two shreds composed in opposite orders inside a
    // caller's transaction deadlock -- measured, 40P01 after a second -- and
    // an unmapped driver error tells the caller nothing about whether to
    // retry. R21 refuses the writes that open their own transaction; this is
    // one that does not, so it can take part in the cycle.
    const result = await this.db
      .updateTable("namespace")
      .set({
        data_key_wrapped: null,
        key_shredded_at: sql<Date>`coalesce(key_shredded_at, ${this.clock.now()})`,
      })
      .where("namespace_id", "=", namespaceId)
      .executeTakeFirst()
      .catch((e: unknown) => { throw mapPgError(e) ?? e; });
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
   * `dataKey` is read first, so a shredded namespace is refused rather than
   * minted under: there is no inner key to mint under a null outer one.
   *
   * That ordering is not a transactional guarantee and the docstring used to
   * imply it was. Nothing spans the read and the insert, so a shred that
   * commits in between leaves a row whose own columns say the month is live;
   * measured, it happens in every interleaving tried. It is not an evasion --
   * the outer key is gone, so `openPeriodKey` raises NamespaceShredded and
   * the month key can never be unwrapped by anyone -- but a row that reads as
   * live under an erased counterparty is worth knowing about before someone
   * writes a report off these columns. That is
   * also the restatement M1's re-key argument needed once period keys existed
   * (F9): a namespace shred is total because the outer key is gone, not
   * because readable and unreadable rows may not sit behind one marker --
   * under period keys, that is the designed normal state.
   */
  async periodKey(namespaceId: string, period: string): Promise<void> {
    const dataKey = await this.dataKey(namespaceId);
    // Bound to the spellings the database will report, not to the ones the
    // caller passed, for the reason `dataKey` unwraps under the column rather
    // than the argument: the uuid column locates the row whatever case the
    // caller spelled it in, and `2026-9-1` is the same date to Postgres as
    // `2026-09-01`, but the wrap's associated data is bytes. Bound to the
    // caller's spelling, a mint and a read that disagree on case produce a
    // CiphertextRejected -- a tamper report for a formatting difference.
    const canonical = await this.canonicalPair(namespaceId, period);
    await this.db
      .insertInto("namespace_key")
      .values({
        namespace_id: namespaceId,
        period,
        key_wrapped: wrapUnder(dataKey, newDataKey(), periodKeyAad(canonical.namespaceId, canonical.period)),
        expires_at: expiresAt(canonical.period, this.policy),
        shredded_at: null,
        created_at: this.clock.now(),
      })
      .onConflict((oc) => oc.columns(["namespace_id", "period"]).doNothing())
      .execute()
      .catch((e: unknown) => { throw mapPgError(e) ?? e; });

    // On conflict this wrote nothing, which is what keeps an expired month
    // expired -- and also what would let a row planted before the mint stand
    // in for it. The table bounds the expiry to a range; this refuses any
    // expiry that is not the one THIS policy computes, so a month minted
    // under a different policy version is a named refusal rather than a
    // silently different retention.
    const expected = expiresAt(canonical.period, this.policy);
    const stored = await this.db
      .selectFrom("namespace_key")
      .select(["expires_at"])
      .where("namespace_id", "=", namespaceId)
      .where(sql<boolean>`period = ${period}::date`)
      .executeTakeFirst();
    if (stored && stored.expires_at.getTime() !== expected.getTime()) {
      throw new PeriodKeyAltered(
        `the stored expiry of month ${canonical.period} in namespace ` +
          `${canonical.namespaceId} is ${stored.expires_at.toISOString()}, which is not the ` +
          `expiry policy ${this.policy.version} computes for it, ${expected.toISOString()}`,
      );
    }
  }

  /**
   * The pair as the database spells it: the uuid in its canonical lowercase
   * form and the period as `YYYY-MM-DD`. Both come back through the same
   * rendering every other read of this column uses, so the binding a key is
   * minted under and the binding it is opened under are the same bytes even
   * when two callers spell the pair differently.
   *
   * A period the database cannot read as a date fails here, as a
   * ConstraintViolation-shaped driver error rather than deep inside a cipher.
   */
  private async canonicalPair(
    namespaceId: string,
    period: string,
  ): Promise<{ namespaceId: string; period: string }> {
    const row = await sql<{ namespace_id: string; period: string }>`
      select namespace_id::text as namespace_id, ${PERIOD_TEXT(sql`${period}::date`)} as period
      from namespace where namespace_id = ${namespaceId}`.execute(this.db);
    const only = row.rows[0];
    if (!only) throw new NamespaceNotFound(`no namespace ${namespaceId}`);
    return { namespaceId: only.namespace_id, period: only.period };
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
   * `periodKey` compares nothing to the clock, so minting a month that is
   * already past its grace produces a live key: a backfill of 2020 under a
   * 2026 clock is readable until the next sweep reaches it. That follows from
   * R2 (expiry comes from the period, never from the clock) and is left to
   * Task 7's sweep rather than refused here, because refusing it would drop
   * the observation at write time, which is the one thing this design does
   * not do.
   *
   * A period with no row is a caller defect rather than a store condition --
   * the only reader is a path whose row already exists - so it is a plain
   * Error, as `ensure` does for a namespace that vanished after its insert.
   */
  async openPeriodKey(namespaceId: string, period: string): Promise<Buffer> {
    const dataKey = await this.dataKey(namespaceId);
    // Every part of the binding is read back from the row, so the key opens
    // under what the database holds rather than under what this caller typed.
    const found = await sql<{
      namespace_id: string; period: string;
      key_wrapped: Buffer | null; shredded_at: Date | null;
    }>`
      select namespace_id::text as namespace_id, ${PERIOD_TEXT(sql`period`)} as period,
             key_wrapped, shredded_at
      from namespace_key
      where namespace_id = ${namespaceId} and period = ${period}::date`.execute(this.db);
    const row = found.rows[0];
    if (!row) throw new Error(`no month key ${period} for namespace ${namespaceId}`);
    if (row.key_wrapped === null) {
      throw new PayloadExpired(
        `the month ${row.period} of namespace ${row.namespace_id} expired at ` +
          `${row.shredded_at?.toISOString()}; its payloads are unreadable`,
      );
    }
    return unwrapUnder(dataKey, row.key_wrapped, periodKeyAad(row.namespace_id, row.period));
  }

  /**
   * The nightly sweep: every month past its grace loses its key, and nothing
   * else about it changes. Not quite "becomes unreadable", which is what this
   * line said until review measured the exception: a month under a namespace
   * already erased on request has been unreadable through this API since that
   * erasure, and what the sweep changes for it is that its key is no longer
   * sitting live under a dead one.
   *
   * One statement, for the reason `shred` is one statement -- the set it acts
   * on and the set it reports are then the same set by construction, and a
   * job that told M4 it expired a month it had not is worse than one that
   * expired nothing. `returning` is what is reported, so the report comes
   * from the rows the database actually wrote.
   *
   * It takes no namespace argument. That is what makes it the nightly job,
   * and also what makes it awkward to test: a suite sharing a schema with it
   * has every month it minted swept too, so the sweep's own tests own a
   * schema.
   *
   * `now` from the injected clock, never `now()`, so a simulated day is a
   * simulated day all the way down.
   *
   * The store writes no audit row here, as it never has: the caller writes
   * it, the way the acceptance story's own `audit()` helper does beside every
   * other operation. (This cited `acceptance.test.ts:174-182` as "where that
   * division is pinned" until review read those lines: they are the story's
   * journal helper, not an assertion that the store writes nothing. The
   * division is a convention this package keeps, not a gate -- worth knowing
   * before anyone relies on it.) What this returns is what that caller needs
   * in order to write one.
   *
   * The two `where` clauses are each a rule. `expires_at <= now` is the
   * retention promise itself; `key_wrapped is not null` is what keeps the
   * sweep idempotent, because an already-expired row re-selected here would
   * have its `shredded_at` moved and the guard refuses exactly that -- so
   * dropping it turns the second night into a PeriodKeyAltered rather than
   * into a no-op.
   *
   * R18: the join, and why the sweep reaches an erased namespace. Such a
   * namespace keeps its month keys, each still carrying a live wrapped key,
   * and sweeping them keeps those past-grace months under the same two dead
   * keys a live namespace's expired months get. A filter would leave them
   * under one.
   *
   * That is the whole claim, and it is deliberately smaller than the one this
   * comment made first. It said a restore of the outer key recovers, after a
   * sweep, "only the months still inside their grace". Review measured all
   * three parts. True for an attacker who restores exactly ONE row, the
   * namespace's, into its own row: unswept months then opened, swept months
   * refused. False for the backup §2c actually names, which holds the
   * `namespace_key` rows too and restores both tables: everything came back,
   * swept or not. And false against the disk in any case -- pageinspect read
   * the swept keys out of dead heap tuples before a vacuum, and
   * pg_walinspect found each one in the mint's WAL record afterwards. So the
   * sweep is strictly better than a filter, and it is better only through
   * this API and only against that one narrow restore. Outward, §2c's limit
   * stands unchanged.
   *
   * The foreign key guarantees exactly one matching namespace row, so the
   * join changes which rows are swept not at all. What it adds is
   * `namespaceErasedAtSweep`, per row, read from the namespace's own column
   * in the same statement -- a snapshot under READ COMMITTED rather than a
   * serialization, so an erasure committing while this statement is in
   * flight reads false. Measured by blocking the sweep on a row lock; the
   * window is one statement and the recorded instants stay ordered.
   *
   * The instant is `now` for every row. For a month whose namespace was
   * erased BEFORE the month's own expiry, `namespace_key_shred_not_early`
   * refuses the erasure instant outright, so `now` is forced. For one erased
   * after it, the earlier instant would be accepted and `now` is a
   * uniformity choice rather than a forced one -- review measured both, and
   * the ruling's one-line justification covered only the first.
   */
  async expirePeriods(): Promise<SweepResult> {
    const now = this.clock.now();
    const swept = await sql<{ namespace_id: string; period: string; erased: boolean }>`
      update namespace_key k
         set key_wrapped = null, shredded_at = ${now}
        from namespace n
       where n.namespace_id = k.namespace_id
         and k.key_wrapped is not null
         and k.expires_at <= ${now}
      returning k.namespace_id::text as namespace_id,
                ${PERIOD_TEXT(sql`k.period`)} as period,
                (n.data_key_wrapped is null) as erased`
      .execute(this.db)
      .catch((e: unknown) => { throw mapPgError(e) ?? e; });
    return {
      shredded: swept.rows
        .map((row) => ({
          namespaceId: row.namespace_id,
          period: row.period,
          namespaceErasedAtSweep: row.erased,
        }))
        // Sorted here rather than in SQL, because `UPDATE ... RETURNING`
        // cannot be ordered without wrapping the whole statement in a CTE and
        // the statement being one statement is load-bearing. Sorted at all
        // because review measured the unsorted order to be HEAP order --
        // interleaved by insertion, and free to change across a vacuum or a
        // restore. An M4 audit body built from an array that reorders itself
        // between runs is not reproducible, and reproducibility is the whole
        // point of the row it will write.
        .sort(sweepOrder),
    };
  }

  /**
   * Every period this namespace holds a key row for, as text.
   *
   * Rendered through PERIOD_TEXT, like every other read of the column. Two
   * settings would move it otherwise: the driver parses a `date` at LOCAL
   * midnight, so a Date here would be the previous day east of UTC and this
   * list would name months off by one on exactly the machines this project
   * runs on; and `period::text` renders through the session's DateStyle,
   * which R17 replaced everywhere for the same reason. This docstring said
   * `::text` until Task 7, which is what the shared helper exists to stop.
   */
  async periodsOf(namespaceId: string): Promise<string[]> {
    const rows = await sql<{ period: string }>`
      select ${PERIOD_TEXT(sql`period`)} as period from namespace_key
      where namespace_id = ${namespaceId} order by period`.execute(this.db);
    return rows.rows.map((r) => r.period);
  }
}
