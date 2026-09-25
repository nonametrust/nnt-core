import { randomUUID } from "node:crypto";
import {
  datedAt, deriveIdempotencyKey, observationSchema,
  type Observation, type WireObservation,
} from "@nonametrust/schema";
import type { Clock } from "../clock.js";
import type { Db } from "../db.js";
import { sql } from "kysely";
import { open, payloadAad, seal } from "../crypto.js";
import { assertRetentionPolicy, periodOf, type RetentionPolicy } from "../retention.js";
import {
  CiphertextRejected, IdempotencyKeyMismatch, NamespaceShredded, ObservationNotFound,
  PayloadExpired, mapPgError, SourceRateExceeded,
} from "../errors.js";
import { PERIOD_TEXT, type NamespaceRepository } from "./namespace.js";

/**
 * What `append` answers, in three shapes.
 *
 * The third exists because of R19, and its shape because of R18. Before it,
 * the pre-read opened the payload, so a re-delivery for a namespace erased on
 * request raised NamespaceShredded out of the RETRY path and the indexer
 * errored forever for that counterparty -- a denial of service on our own
 * pipeline. The row is already there; refusing protects nothing, since the
 * skeleton is what a shred deliberately leaves standing and §2c records
 * `ns_id` as plaintext through an erasure.
 *
 * Two booleans rather than a `reason: "period-expired" | "namespace-erased"`.
 * The union is the obvious design and it is wrong for the reason the sweep's
 * own `reason` was wrong one task earlier: an erased namespace can also hold
 * a month past its grace, so the two are not alternatives, and a union has to
 * pick one and drop the other from whatever counts it feeds. Both are state
 * at the moment of the read, not causes.
 *
 * `readable` is the discriminant because it is the question the caller
 * actually has. A NEW observation for an erased namespace is a different
 * case and still throws; see `append`.
 */
export type AppendResult =
  | { created: true; observation: Observation }
  | { created: false; readable: true; observation: Observation }
  | {
      created: false;
      readable: false;
      observationId: string;
      ingestedAt: Date;
      periodExpired: boolean;
      namespaceErased: boolean;
    };

/** The pre-read's answer: identity and state, never a payload. */
interface Skeleton {
  observationId: string;
  ingestedAt: Date;
  periodExpired: boolean;
  namespaceErased: boolean;
}

// The one insert failure that means "already stored": Postgres's
// unique_violation, on the constraint 0002_observation.sql names for the key.
// The constraint is matched by name and not by SQLSTATE alone because the
// primary key is unique too, and a collision there would be a different
// problem wearing the same code. It is looked at on the driver's raw error,
// before `mapPgError` runs: mapped, the same failure is a ConstraintViolation,
// and to this repository a duplicate is the retry it exists for, not a
// failure.
const UNIQUE_VIOLATION = "23505";
const IDEMPOTENCY_CONSTRAINT = "observation_idempotency";

function isDuplicateKey(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const { code, constraint } = e as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === IDEMPOTENCY_CONSTRAINT;
}

export class ObservationRepository {
  constructor(
    private readonly db: Db,
    private readonly namespaces: NamespaceRepository,
    private readonly clock: Clock,
    // R16's sibling. Required rather than defaulted because a default is a
    // policy that reaches production, which is the argument the key ring's
    // missing default master key already made.
    //
    // `append` reads `producerWindowMs` and `producerMaxObservations` for the
    // cap, while the namespace repository expires on `graceDays`, and nothing
    // compares the two policies -- so handed different objects the store
    // would cap under one number and expire under another with no error
    // anywhere. The composition point passes ONE value to both.
    //
    // For one commit this comment claimed that and the code did not do it:
    // the parameter was asserted, stored and never read, and review measured
    // the gap. It is read now. The note stays because "the comment described
    // a mechanism that arrived later" is the failure mode, not the delay.
    private readonly policy: RetentionPolicy,
  ) {
    // Asserted here for the reason NamespaceRepository asserts it: this is
    // where a policy enters, so this is where a malformed one is refused, by
    // field and by name.
    assertRetentionPolicy(policy);
  }

  /**
   * Writing the same source event twice is the indexer's normal retry path,
   * not a defect, so a repeat returns the stored observation and reports
   * `created: false` rather than raising. The distinction between "already
   * stored" and "conflicting" is drawn on the idempotency key alone, which is
   * what the key exists for.
   *
   * A key the caller supplied is compared with the derived one, not replaced
   * by it. Replaced, a caller that wrote under key K and then asked for K
   * would be told nothing is there about an observation this store said it
   * created. The comparison comes before the pre-read so a mismatch is never
   * answered with `created: false` either: a wrong key is a wrong key whether
   * or not the observation happens to be stored already.
   */
  async append(wire: WireObservation): Promise<AppendResult> {
    const parsed = observationSchema.parse(wire) as Observation;
    const key = deriveIdempotencyKey(parsed.source, parsed.channel, parsed.namespace);
    if (parsed.idempotencyKey !== undefined && parsed.idempotencyKey !== key) {
      throw new IdempotencyKeyMismatch(
        `idempotency key ${parsed.idempotencyKey} was supplied, but this observation derives to ${key}`,
      );
    }

    // The pre-read is a SKELETON: identity and state, no decrypt (R19). It
    // used to be `byIdempotencyKey`, which opens the payload -- so the retry
    // path itself threw for exactly the rows retention and erasure are
    // supposed to leave answerable.
    const stored0 = await this.skeleton(key);
    if (stored0) return this.answerStored(key, stored0);

    // Past here the observation is new, and a new observation for an erased
    // namespace is NOT the case above: it would be resuming collection on a
    // counterparty who asked to be erased. `periodKey` refuses to mint under
    // a dead outer key and that refusal stands (M1's rule, R19 records it).
    const ns = await this.namespaces.ensure(parsed.namespace);
    const observationId = randomUUID();
    const ingestedAt = this.clock.now();
    const stored = {
      ...parsed,
      observationId,
      idempotencyKey: key,
      ingestedAt: ingestedAt.toISOString(),
    } as Observation;

    // datedAt is the single reader of a date off an observation, and calling
    // it here is why this package needs no exemption in the repository's
    // single-date-reader gate. Note that the gate matches those field names
    // inside comments too, so this one describes the rule without naming
    // them.
    const dated = datedAt(stored);
    const datedColumn = dated === null ? null : new Date(dated);

    // The month the payload is keyed under, from INGEST time, so a new
    // observation lands in the month it is written in. Minting is idempotent
    // and never revives an expired month, so a re-delivery of an old month
    // finds the row exactly as retention left it.
    //
    // A previous version of this comment said a new observation can THEREFORE
    // never land in an expired month. That is false and review measured it:
    // with `graceDays: 0` -- a policy assertRetentionPolicy explicitly admits
    // -- a month expires at its own close, so a sweep running at 00:00 on the
    // first can shred the month an append captured its instant in at
    // 23:59:59.999 the night before. The append then throws PayloadExpired
    // and the observation is dropped at write time, which is the one thing
    // this design says it does not do.
    //
    // The general condition is that the grace must exceed the skew between
    // the appending clock and the sweeping one; at the shipped ninety days it
    // is unreachable outside a simulated clock.
    //
    // There is a THIRD ordering this comment used to omit, and review
    // reproduced it: if the sweep commits after `openPeriodKey` returns but
    // before the insert, the append succeeds and reports `created: true`
    // while the row it just wrote is already unreadable. Not dropped at write
    // time, which is the rule -- written unreadable instead, which is worse
    // to discover later and is the same mint-to-insert window that lets a new
    // observation land under an erased namespace. Both want the one gate
    // named in R19.
    //
    // Minted before the insert because the foreign key requires the row, and
    // the foreign key exists so that this ordering is a constraint rather
    // than a habit.
    const period = periodOf(ingestedAt);
    await this.namespaces.periodKey(ns.namespaceId, period);

    // The payload is bound to every column written beside it, as the Date
    // the column will hold, so that a column rewritten afterwards refuses
    // the read. `read` rebuilds the same binding from the same columns.
    const dataKey = await this.namespaces.openPeriodKey(ns.namespaceId, period);
    const sealed = seal(dataKey, JSON.stringify(stored), payloadAad({
      namespaceId: ns.namespaceId,
      observationId,
      idempotencyKey: key,
      evidenceKind: stored.evidenceKind,
      channel: stored.channel,
      kind: stored.kind,
      producer: stored.source.producer,
      ingestedAt,
      datedAt: datedColumn,
    }));

    try {
      // The cap, and the insert, in one transaction.
      //
      // The lock is per PRODUCER and transaction-scoped, the shape
      // `0005:84` and `chain.ts:275` already use: it is released by the
      // commit or the rollback, so there is no unlock that could land on
      // another pooled connection and no lock that can outlive the work it
      // guards (M1 ledger 189-194).
      //
      // Count-then-insert without it is the failure the plan names "a cap
      // that is not a cap": every concurrent appender reads the same count
      // and they all pass, so the cap is exceeded by roughly the pool's
      // width once per window. Sequential tests cannot see it; the
      // twenty-concurrent one is the only thing that can.
      //
      // `hashtext` rather than the producer string, because the advisory
      // lock space is bigint. Two producers can collide there and the cost
      // of a collision is that two producers queue behind each other for the
      // length of one insert -- not a wrong count, because the count itself
      // filters on the producer column.
      //
      // The pre-read is deliberately OUTSIDE this transaction: a re-delivery
      // has already returned by now, so the indexer's retry never consumes a
      // slot. Charged, a producer at its cap could not retry anything, which
      // is R3's denial of service on ourselves arriving through the one path
      // that exists to prevent it.
      // READ COMMITTED is what this transaction needs, and it is pinned on
      // the CONNECTION in db.ts rather than here. Under REPEATABLE READ the
      // snapshot is taken at the first statement -- the lock acquisition,
      // before the lock is granted -- so every queued appender counts
      // against a view predating the holder's commit: measured at cap 5,
      // fourteen rows stored.
      //
      // It was pinned in both places for one round. Mutation showed the
      // transaction-level call held nothing, because the connection pin
      // reaches it first, and it covers strictly less: `ensure` and
      // `periodKey` run outside any transaction and raise 40001 under
      // REPEATABLE READ, which no isolation level set HERE could have
      // helped. One mechanism, in the place that covers all of them, beats
      // two where the second is untestable -- and this package already
      // depends on db.ts's pins for correctness, since losing the DateStyle
      // one breaks every read.
      const raced = await this.db.transaction()
        .execute(async (trx) => {
          await sql`select pg_advisory_xact_lock(hashtext(${stored.source.producer}))`
            .execute(trx);

          // The key, re-read UNDER the lock. A concurrent delivery of this
          // same event may have stored it while this call queued, and then
          // counting would refuse a RETRY as a rate violation -- measured,
          // four rounds in five. The retry does not consume a slot, but
          // without this it gets refused by one, which is R3's denial of
          // service on ourselves arriving through the path that exists to
          // prevent it. Found, it is answered from outside this
          // transaction, so no count is taken and nothing is inserted.
          const already = await this.skeleton(key, trx);
          if (already) return already;

          const since = new Date(ingestedAt.getTime() - this.policy.producerWindowMs);
          // Bounded by the cap: the decision only needs to know whether the
          // window holds AT LEAST that many, and an exact count is O(rows in
          // the window) under the lock. At the shipped ten million a day
          // that is most of the table on every append, measured at roughly a
          // second once the window is full -- one producer's own throughput
          // ceiling collapsing exactly when it is busiest. The LIMIT stops
          // at the cap, so the number below is "at least", and the message
          // says so rather than reporting a total it did not compute.
          const counted = await sql<{ n: string }>`
            select count(*)::text as n from (
              select 1 from observation
              where producer = ${stored.source.producer} and ingested_at > ${since}
              limit ${this.policy.producerMaxObservations}
            ) bounded`
            .execute(trx);
          const n = Number(counted.rows[0]!.n);
          if (n >= this.policy.producerMaxObservations) {
            throw new SourceRateExceeded(
              `producer ${stored.source.producer} has reached its cap of ` +
                `${this.policy.producerMaxObservations} observations in the last ` +
                `${this.policy.producerWindowMs} ms under policy ${this.policy.version}; ` +
                `no observation was written`,
            );
          }
          await trx
          .insertInto("observation")
          .values({
            observation_id: observationId,
            idempotency_key: key,
            namespace_id: ns.namespaceId,
            channel: stored.channel,
            kind: stored.kind,
            evidence_kind: stored.evidenceKind,
            dated_at: datedColumn,
            ingested_at: ingestedAt,
            producer: stored.source.producer,
            period,
            payload_nonce: sealed.nonce,
            payload_tag: sealed.tag,
            payload_ciphertext: sealed.ciphertext,
          })
            .execute();
          return null;
        });
      if (raced) return this.answerStored(key, raced);
    } catch (e) {
      // The cap's own refusal is this repository's, not the driver's, and
      // mapPgError would hand it back as null and rethrow it unchanged
      // anyway. Named here so a reader does not have to work that out.
      if (e instanceof SourceRateExceeded) throw e;
      // A concurrent writer may have inserted the same key between the read
      // above and this insert. That is a duplicate, not a failure, and it is
      // the only failure that is one. Re-reading after any other error would
      // let a row some other writer stored stand in for the one this call
      // failed to store, and the caller would be told "already stored" about
      // a failure it never heard of.
      if (isDuplicateKey(e)) {
        // Through the same skeleton read as the pre-read, and for the same
        // reason: the row the other writer stored may already be unreadable,
        // and reaching it through the payload would throw here rather than
        // answer.
        const again = await this.skeleton(key);
        if (again) return this.answerStored(key, again);
      }
      throw mapPgError(e) ?? e;
    }
    return { created: true, observation: stored };
  }

  /**
   * The answer for a key the skeleton found, and the one race between the two
   * reads.
   *
   * When the skeleton says readable the payload is opened, and that open can
   * still fail: a sweep or an erasure committing in between makes the
   * skeleton's flags stale by milliseconds. Letting that throw would be the
   * original defect back inside a narrower window, so the refusal is caught
   * and the state is read AGAIN -- the second skeleton is what the caller is
   * told, because it is the one that describes the row the read actually met.
   *
   * A read that comes back NULL is different and is not caught. The table is
   * append-only and the skeleton just saw the row, so "no row" here is not a
   * race, it is an invariant that has failed; answering `readable: false`
   * with both flags false would report a row as unreadable while saying
   * nothing is wrong with it.
   */
  private async answerStored(key: string, seen: Skeleton): Promise<AppendResult> {
    if (seen.periodExpired || seen.namespaceErased) {
      return { created: false, readable: false, ...seen };
    }
    let opened: Observation | null;
    try {
      opened = await this.byIdempotencyKey(key);
    } catch (e) {
      if (!(e instanceof NamespaceShredded || e instanceof PayloadExpired)) throw e;
      const fresh = await this.skeleton(key);
      if (!fresh) throw e;
      // The docstring below refuses `readable: false` with both flags clear,
      // and until review measured it that refusal was enforced on the NULL
      // branch alone. Here it was reachable twice over: synthetically, and on
      // a real database where the §2c same-row restore of a captured outer
      // key lands between the failed read and this one -- a narrow window,
      // and inside the threat model §2c states rather than outside it. If
      // the re-read finds nothing wrong, the refusal we caught is the only
      // true thing we know, so it is the thing to raise.
      if (!fresh.periodExpired && !fresh.namespaceErased) throw e;
      return { created: false, readable: false, ...fresh };
    }
    if (!opened) {
      throw new ObservationNotFound(
        `observation ${seen.observationId} was found by idempotency key ${key} and then ` +
          `could not be read: this table is append-only, so a row that vanished between ` +
          `two reads is a broken invariant rather than a race`,
      );
    }
    return { created: false, readable: true, observation: opened };
  }

  /**
   * Identity and state for one idempotency key, with no decrypt.
   *
   * Both flags come from ONE statement, joined to the row's own namespace and
   * month key, because they must describe one instant: asked separately, a
   * shred landing between the two reads would produce a pair that was never
   * simultaneously true. The foreign keys make both joins exactly one row --
   * `observation.period` references `namespace_key` since Task 6 -- so this
   * cannot drop a row or multiply one.
   */
  private async skeleton(
    idempotencyKey: string,
    // The connection to ask. Defaults to the repository's, and the cap
    // passes its own transaction so the re-read under the lock sees
    // what that transaction sees.
    on: Db = this.db,
  ): Promise<Skeleton | null> {
    const found = await sql<{
      observation_id: string; ingested_at: Date;
      period_expired: boolean; ns_erased: boolean;
    }>`
      select o.observation_id::text as observation_id, o.ingested_at,
             (k.key_wrapped is null) as period_expired,
             (n.data_key_wrapped is null) as ns_erased
      from observation o
      join namespace n on n.namespace_id = o.namespace_id
      join namespace_key k
        on k.namespace_id = o.namespace_id and k.period = o.period
      where o.idempotency_key = ${idempotencyKey}`.execute(on);
    const row = found.rows[0];
    return row
      ? {
          observationId: row.observation_id,
          ingestedAt: row.ingested_at,
          periodExpired: row.period_expired,
          namespaceErased: row.ns_erased,
        }
      : null;
  }

  async get(observationId: string): Promise<Observation> {
    const found = await this.read("observation_id", observationId);
    if (!found) throw new ObservationNotFound(`no observation ${observationId}`);
    return found;
  }

  async byIdempotencyKey(key: string): Promise<Observation | null> {
    return this.read("idempotency_key", key);
  }

  /**
   * The one read path. Both public reads go through it because both must
   * rebuild the associated data from the same six columns the write bound it
   * to; two hand-copied selects are how those inputs would eventually diverge,
   * and the failure would be a payload that opens on one path and not the
   * other. The payload is not compared to the columns after it opens: a
   * column that disagrees with it does not open at all.
   */
  private async read(
    column: "observation_id" | "idempotency_key",
    value: string,
  ): Promise<Observation | null> {
    // `period` is rendered rather than selected: a `date` read back as a
    // driver Date is local midnight, which is the previous month's last day
    // east of UTC, and the key it would then look up is the wrong one.
    //
    // Through the shared PERIOD_TEXT rather than a second copy of the format
    // string: one pattern in two files is the drift this docstring warns
    // about everywhere else.
    //
    // Honest about what this buys: NOT much, and a previous version of this
    // comment claimed a joint defence that review showed does not exist. The
    // connection pins DateStyle=ISO, and under ISO the two renderings are the
    // same string. Under a non-ISO style the read fails earlier anyway --
    // node-pg cannot parse the timestamptz text the server sends and every
    // instant arrives as null -- and the period lookup would still have
    // worked, because Postgres parses '01.09.2026'::date in the same session
    // that rendered it. So the PIN is the defence; this is a belt, kept
    // because it costs nothing and does not depend on a session setting, and
    // it is held by no test. Said plainly rather than dressed up: the earlier
    // claim that mutating both together failed was true only because
    // removing the pin breaks the pin's OWN unit test.
    const found = await sql<{
      observation_id: string; namespace_id: string; idempotency_key: string;
      evidence_kind: string; channel: string; kind: string;
      dated_at: Date | null; ingested_at: Date; producer: string; period: string;
      payload_nonce: Buffer; payload_tag: Buffer; payload_ciphertext: Buffer;
    }>`
      select observation_id, namespace_id, idempotency_key, evidence_kind, channel, kind,
             dated_at, ingested_at, producer, ${PERIOD_TEXT(sql`period`)} as period,
             payload_nonce, payload_tag, payload_ciphertext
      from observation
      where ${sql.ref(column)} = ${value}`.execute(this.db);
    const row = found.rows[0];
    if (!row) return null;
    // Raises NamespaceShredded when the namespace key is gone and
    // PayloadExpired when only this month's is, in that order: an operator
    // told a month expired, when the counterparty space was erased on
    // request, would go looking for a retention sweep instead.
    const dataKey = await this.namespaces.openPeriodKey(row.namespace_id, row.period);
    const json = open(
      dataKey,
      { nonce: row.payload_nonce, tag: row.payload_tag, ciphertext: row.payload_ciphertext },
      payloadAad({
        namespaceId: row.namespace_id,
        observationId: row.observation_id,
        idempotencyKey: row.idempotency_key,
        evidenceKind: row.evidence_kind,
        channel: row.channel,
        kind: row.kind,
        producer: row.producer,
        ingestedAt: row.ingested_at,
        datedAt: row.dated_at,
      }),
    );
    const parsed = observationSchema.parse(JSON.parse(json)) as Observation;
    // The envelope already binds the row's primary key, so a payload that
    // opens here belongs to this row. This is the second reading of the same
    // rule, kept because the docstring above claims the store never serves a
    // payload under an identifier that is not its own, and a claim this cheap
    // to enforce should not rest on one layer.
    if (parsed.observationId !== row.observation_id) {
      throw new CiphertextRejected(
        `payload on row ${row.observation_id} carries observation id ${String(parsed.observationId)}`,
      );
    }
    return parsed;
  }
}
