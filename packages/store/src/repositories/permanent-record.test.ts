import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import { withIsoDates, type Db, type Schema } from "../db.js";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { requireTestUrl, storedObservation, urlForSchema, withSchema } from "../testing/harness.js";
import { keyRingFromEnv, permanentAad, seal } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { RETENTION_V0 } from "../retention.js";
import {
  AppendOnlyViolation, ConstraintViolation, NamespaceShredded, ObservationNotFound,
  PermanentRecordNotFound, StateNotPromotable, StoreError, mapPgError, PayloadExpired, CiphertextRejected,
} from "../errors.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";
import { PermanentRecordRepository } from "./permanent-record.js";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let db: Db;
let done: () => Promise<void>;
let namespaces: NamespaceRepository;
let observations: ObservationRepository;
let records: PermanentRecordRepository;
let ns: string;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
// Day twelve of the whitepaper's scenario. The suite advances from here.
const clock = fixedClock(new Date("2026-09-12T09:00:00.000Z"));

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "testnet", ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

// Every observation gets its own source ref, so the idempotency key keeps
// two events on the same instant apart.
let seq = 0;
function anEventOn(instant: string, over: Record<string, unknown> = {}): WireObservation {
  seq += 1;
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "GOLDADDRESS" },
    channel: "volume", evidenceKind: "event", kind: "payment",
    observedAt: instant,
    source: { ...src, ref: `op:${seq}` }, payload: { amount: "500.0000000" },
    salienceHints: { amount: "500.0000000" },
    ...over,
  } as WireObservation;
}

function aState(over: Record<string, unknown> = {}): WireObservation {
  seq += 1;
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "GOLDADDRESS" },
    channel: "protocol", evidenceKind: "state", kind: "trustline_open",
    validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
    source: { ...src, ref: `op:state:${seq}` }, payload: {},
    ...over,
  } as WireObservation;
}

beforeAll(async () => {
  ({ db, done } = await withSchema("permrec_test"));
  namespaces = new NamespaceRepository(db, ring, clock, RETENTION_V0);
  observations = new ObservationRepository(db, namespaces, clock, RETENTION_V0);
  records = new PermanentRecordRepository(db, ring, clock, RETENTION_V0);
  ns = (await namespaces.ensure({ kind: "wallet", id: "GOLDADDRESS" })).namespaceId;
});
afterAll(async () => { await done(); });

describe("the instant a promotion carries", () => {
  // Acceptance criterion 3, first half. Nine days pass between the evidence
  // and its promotion, and the record must still say day twelve.
  //
  // The evidence is ingested an hour after its own instant, as it would be
  // from an indexer, so the three instants a record could carry are all
  // distinct: dated 09:00, ingested 10:00, promoted nine days on. With the
  // clock at append equal to the evidence's instant, a repository that
  // copied the ingestion instant would pass this test by coincidence.
  it("keeps the day-twelve instant when read on day twenty-one", async () => {
    clock.advance(HOUR);
    const observation = storedObservation(await observations.append(anEventOn("2026-09-12T09:00:00.000Z")));
    expect(observation.ingestedAt).toBe("2026-09-12T10:00:00.000Z");
    clock.advance(9 * DAY);
    const record = await records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.8,
    });
    expect(record.originalDatedAt.toISOString()).toBe("2026-09-12T09:00:00.000Z");
    expect(record.promotedAt.toISOString()).toBe("2026-09-21T10:00:00.000Z");
    const read = await records.get(record.recordId);
    expect(read.originalDatedAt.toISOString()).toBe("2026-09-12T09:00:00.000Z");
    expect(read.promotedAt.toISOString()).toBe("2026-09-21T10:00:00.000Z");
    expect(read).toEqual(record);
  });

  it("carries the identifiers and the confidence back out as given", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-12T10:00:00.000Z")));
    const record = await records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.25,
    });
    expect(record.recordId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.observationId).toBe(observation.observationId);
    expect(record.namespaceId).toBe(ns);
    expect(record.rescuedBy).toBeNull();
    expect(record.confidence).toBe(0.25);
  });

  it("names a missing record by class, so a bad id is not mistaken for a bug", async () => {
    await expect(records.get(randomUUID())).rejects.toBeInstanceOf(PermanentRecordNotFound);
    await expect(records.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
  });
});

// Acceptance criterion 3, second half. The repository copies the instant
// correctly, so these go under it, by raw SQL, and prove the database refuses
// the rows a repository bug or a hand-written script could otherwise write.
// NNT04 is the SQLSTATE mapPgError turns into TimestampAltered.
describe("the invariant the table holds on its own", () => {
  it("refuses a record whose instant disagrees with its source, by SQLSTATE", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-13T09:00:00.000Z")));
    await expect(
      sql`insert into permanent_record
            (record_id, observation_id, namespace_id, original_dated_at, promoted_at, confidence)
          values (gen_random_uuid(), ${observation.observationId}, ${ns},
                  '2026-09-21T00:00:00Z', now(), 0.5)`.execute(db),
    ).rejects.toMatchObject({ code: "NNT04" });
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId).execute();
    expect(rows).toEqual([]);
  });

  // The table is append-only, and that trigger sorts before this one, so an
  // ordinary update is refused as NNT01 before the instant is ever compared.
  // The date trigger's update leg is defence in depth for the day the
  // append-only trigger is disabled, so it is proved with exactly that: the
  // append-only trigger off inside a transaction that is then rolled back,
  // and the instant still refused.
  it("refuses an update that moves the instant afterwards, even with append-only off", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-14T09:00:00.000Z")));
    const record = await records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.8,
    });
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table permanent_record disable trigger permanent_record_append_only`.execute(trx);
        await sql`update permanent_record set original_dated_at = now() where record_id = ${record.recordId}`
          .execute(trx);
      }),
    ).rejects.toMatchObject({ code: "NNT04" });
    const read = await records.get(record.recordId);
    expect(read.originalDatedAt.toISOString()).toBe("2026-09-14T09:00:00.000Z");
    // The rollback put the append-only trigger back: the same update, on
    // its own, is now refused by it.
    await expect(
      sql`update permanent_record set original_dated_at = now() where record_id = ${record.recordId}`
        .execute(db),
    ).rejects.toMatchObject({ code: "NNT01" });
  });

  // A writer that "helpfully" stamps a state with the promotion instant is
  // exactly the hazard: a standing condition given a date, and so a window.
  // The trigger sees a null source against a non-null record and refuses;
  // the honest null is refused by the column instead. Both leave no row.
  it("refuses a record of a state whether it invents an instant or writes none", async () => {
    const observation = storedObservation(await observations.append(aState()));
    await expect(
      sql`insert into permanent_record
            (record_id, observation_id, namespace_id, original_dated_at, promoted_at, confidence)
          values (gen_random_uuid(), ${observation.observationId}, ${ns}, now(), now(), 0.5)`
        .execute(db),
    ).rejects.toMatchObject({ code: "NNT04" });
    await expect(
      sql`insert into permanent_record
            (record_id, observation_id, namespace_id, original_dated_at, promoted_at, confidence)
          values (gen_random_uuid(), ${observation.observationId}, ${ns}, null, now(), 0.5)`
        .execute(db),
    ).rejects.toMatchObject({ code: "23502", column: "original_dated_at" });
  });

  it("refuses an UPDATE of any column, loudly, by SQLSTATE and by class", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-14T10:00:00.000Z")));
    const record = await records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.8,
    });
    const failure = await sql`update permanent_record set confidence = 0.1 where record_id = ${record.recordId}`
      .execute(db).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ code: "NNT01" });
    expect(mapPgError(failure)).toBeInstanceOf(AppendOnlyViolation);
    expect((await records.get(record.recordId)).confidence).toBe(0.8);
  });

  // A delete would remove evidence from a day-21 brief with no trace, which
  // is the one thing a permanent record must not allow. Erasure is by key
  // shredding and needs no delete path here.
  it("refuses a DELETE", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-14T11:00:00.000Z")));
    const record = await records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.8,
    });
    await expect(
      sql`delete from permanent_record where record_id = ${record.recordId}`.execute(db),
    ).rejects.toMatchObject({ code: "NNT01" });
    expect((await records.get(record.recordId)).recordId).toBe(record.recordId);
  });

  it("exposes no update or delete on the repository surface at all", () => {
    const surface = Object.getOwnPropertyNames(PermanentRecordRepository.prototype);
    expect(surface.filter((m) => /update|delete|remove/i.test(m))).toEqual([]);
  });

  it("promotes an observation at most once", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-15T09:00:00.000Z")));
    const input = {
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.8,
    };
    await records.promote(input);
    const again = records.promote({ ...input, confidence: 0.9 });
    await expect(again).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(again).rejects.toMatchObject({ sqlstate: "23505", constraint: "permanent_record_once" });
  });

  // The same finding Task 7's review made against tag: two independent keys
  // would let a record be filed under a namespace its observation does not
  // belong to, and surface in the wrong counterparty's brief.
  it("refuses a record filed under a namespace its observation does not belong to", async () => {
    const other = await namespaces.ensure({ kind: "wallet", id: "SOMEONEELSE" });
    const observation = storedObservation(await observations.append(anEventOn("2026-09-16T09:00:00.000Z")));
    const filed = records.promote({
      observationId: observation.observationId, namespaceId: other.namespaceId,
      rescuedBy: null, confidence: 0.8,
    });
    await expect(filed).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(filed).rejects.toMatchObject({
      sqlstate: "23503", constraint: "permanent_record_observation_in_namespace",
    });
  });

  it("holds confidence to the unit interval", async () => {
    for (const confidence of [-0.1, 1.1]) {
      const observation = storedObservation(await observations.append(anEventOn("2026-09-17T09:00:00.000Z")));
      const promoted = records.promote({
        observationId: observation.observationId, namespaceId: ns,
        rescuedBy: null, confidence,
      });
      await expect(promoted).rejects.toBeInstanceOf(ConstraintViolation);
      await expect(promoted).rejects.toMatchObject({ sqlstate: "23514", constraint: "permanent_record_confidence" });
    }
  });

  // NaN and the infinities are refused one layer earlier than the other two,
  // and both layers are asserted because both are rules. `confidence` became
  // a BOUND part of the permanent envelope in the branch review -- `0004`'s
  // own comment names it as something a session with write access could
  // rewrite, and until then a rewritten confidence still opened -- and a
  // bound part must render deterministically. `"NaN"` is a string two
  // different bindings could both produce, so it is refused where the field
  // can be named rather than left to a check constraint that would report a
  // column and not a reason.
  it("refuses a confidence that is not a finite number, by field, before the table sees it", async () => {
    for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const observation = storedObservation(await observations.append(anEventOn("2026-09-17T09:00:00.000Z")));
      await expect(records.promote({
        observationId: observation.observationId, namespaceId: ns,
        rescuedBy: null, confidence,
      })).rejects.toThrow(/confidence must be a finite number/);
    }
  });

  // And the table still holds it on its own, which is what the layer above
  // is allowed to assume and not allowed to replace.
  it("still refuses a NaN confidence from a raw writer", async () => {
    const observation = storedObservation(await observations.append(anEventOn("2026-09-17T09:05:00.000Z")));
    // `original_dated_at` copied from the observation itself, because
    // `permanent_record_keeps_its_date` refuses anything else and would be
    // the constraint that fired -- a test of another rule.
    await expect(sql`
      insert into permanent_record (
        record_id, observation_id, namespace_id, original_dated_at, promoted_at,
        rescued_by, confidence, payload_nonce, payload_tag, payload_ciphertext
      )
      select ${randomUUID()}, o.observation_id, o.namespace_id, o.dated_at,
             ${new Date("2026-09-20T09:00:00.000Z")}, null, 'NaN'::double precision,
             decode('00','hex'), decode('00','hex'), decode('00','hex')
        from observation o where o.observation_id = ${observation.observationId}
      `.execute(db)).rejects.toMatchObject({
        code: "23514", constraint: "permanent_record_confidence",
      });
  });
});

describe("what the repository refuses before writing", () => {
  // A state's dated_at is null and original_dated_at is not null, so the
  // database would refuse this on its own. It is named here so that a caller
  // promoting a state can tell that from a disk error, and so that the
  // refusal happens before anything is written rather than as a rollback.
  it("refuses to promote a state, by class, because it has no instant to preserve", async () => {
    const observation = storedObservation(await observations.append(aState()));
    await expect(records.promote({
      observationId: observation.observationId, namespaceId: ns,
      rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(StateNotPromotable);
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId).execute();
    expect(rows).toEqual([]);
  });

  // A promotion exists to make evidence surface in a future brief, and
  // evidence whose content can never be read again can only produce a reason
  // nobody can explain. The observation row survives a shred and its instant
  // is still readable, so nothing in the database refuses this on its own.
  it("refuses to promote into a shredded namespace, by class, and writes nothing", async () => {
    const shredded = await namespaces.ensure({ kind: "wallet", id: "SHREDPROMO" });
    const observation = storedObservation(await observations.append(anEventOn("2026-09-18T09:00:00.000Z", {
      namespace: { kind: "wallet", id: "SHREDPROMO" },
    })));
    await namespaces.shred(shredded.namespaceId);
    await expect(records.promote({
      observationId: observation.observationId, namespaceId: shredded.namespaceId,
      rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(NamespaceShredded);
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId).execute();
    expect(rows).toEqual([]);
  });

  it("names a missing observation by class", async () => {
    await expect(records.promote({
      observationId: randomUUID(), namespaceId: ns, rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(ObservationNotFound);
  });
});


// Task 9, G11. The whole card exists for one sentence -- a captured trace
// outlives its month -- and until now `promote` copied metadata and never
// opened the observation at all, so a promotion after expiry succeeded while
// rescuing nothing. §1 found it; this is where it closes.
// The third of the three construction sites that assert the policy, and the
// second of the three that nothing held: deleting this call left the suite
// green. `expiresAt`'s docstring claims an unvalidated policy cannot reach it
// from inside the store, and that claim is about all three sites.
describe("the policy this repository is built on", () => {
  it("refuses a malformed one in its own constructor, by field name", () => {
    expect(() => new PermanentRecordRepository(db, ring, clock, { ...RETENTION_V0, graceDays: 1.5 }))
      .toThrow(/graceDays/);
    expect(() => new PermanentRecordRepository(db, ring, clock, { ...RETENTION_V0, producerMaxObservations: 0 }))
      .toThrow(/producerMaxObservations/);
  });
});

describe("the permanent copy outlives its month", () => {
  const grace7 = { ...RETENTION_V0, graceDays: 7 };

  function at(iso: string) {
    const c = fixedClock(new Date(iso));
    const nsRepo = new NamespaceRepository(db, ring, c, grace7);
    return {
      ns: nsRepo,
      obs: new ObservationRepository(db, nsRepo, c, grace7),
      rec: new PermanentRecordRepository(db, ring, c, grace7),
    };
  }

  const anEventFor = (wallet: string, ref: string) => ({
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: wallet },
    channel: "volume", evidenceKind: "event", kind: "payment",
    observedAt: "2027-03-12T09:00:00.000Z",
    source: { ...src, ref },
    payload: { amount: "500.0000000" },
    salienceHints: { amount: "500.0000000" },
  }) as WireObservation;

  async function promoted(wallet: string, ref: string) {
    const march = at("2027-03-15T00:00:00.000Z");
    const o = storedObservation(await march.obs.append(anEventFor(wallet, ref)));
    const nsId = (await march.ns.find("wallet", wallet))!.namespaceId;
    const record = await march.rec.promote({
      observationId: o.observationId, namespaceId: nsId,
      rescuedBy: null, confidence: 0.9,
    });
    return { o, nsId, record };
  }

  async function expireMarch(nsId: string) {
    await sql`update namespace_key set key_wrapped = null,
                shredded_at = ${new Date("2027-04-08T00:00:00.000Z")}
              where namespace_id = ${nsId} and period = '2027-03-01'::date`.execute(db);
  }

  it("reads the rescued observation back after its month is gone", async () => {
    const { o, nsId, record } = await promoted("PERM1", "op:perm:1");
    await expireMarch(nsId);
    const after = at("2027-05-01T00:00:00.000Z");

    // The source is unreadable; the rescue is not. That pair IS the card.
    await expect(after.obs.get(o.observationId)).rejects.toBeInstanceOf(PayloadExpired);
    const rescued = await after.rec.read(record.recordId);
    expect(rescued).toEqual(o);
  });

  it("refuses a promotion after the month expired, and writes no row", async () => {
    const march = at("2027-03-15T00:00:00.000Z");
    const o = storedObservation(await march.obs.append(anEventFor("PERM2", "op:perm:2")));
    const nsId = (await march.ns.find("wallet", "PERM2"))!.namespaceId;
    await expireMarch(nsId);

    const after = at("2027-05-01T00:00:00.000Z");
    await expect(after.rec.promote({
      observationId: o.observationId, namespaceId: nsId,
      rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(PayloadExpired);
    const rows = await sql<{ n: string }>`
      select count(*)::text as n from permanent_record where observation_id = ${o.observationId}`
      .execute(db);
    expect(rows.rows[0]!.n).toBe("0");
  });

  it("makes the rescue unreadable when the counterparty space is erased", async () => {
    // The other half of retention: a month key's death is survivable, the
    // namespace key's is not. This is the sentence the whitepaper makes
    // about erasing a whole counterparty space, and it has to be true of the
    // permanent copy or the copy is a way around an erasure request.
    const { nsId, record } = await promoted("PERM3", "op:perm:3");
    const after = at("2027-05-01T00:00:00.000Z");
    expect(await after.rec.read(record.recordId)).toBeDefined();
    await after.ns.shred(nsId);
    await expect(after.rec.read(record.recordId)).rejects.toBeInstanceOf(NamespaceShredded);
    // Metadata stays listable, so a shredded namespace's records can still
    // be counted and audited.
    expect((await after.rec.get(record.recordId)).recordId).toBe(record.recordId);
  });

  it("refuses the read when any bound column is moved", async () => {
    // The payload is bound to the record's own identity. Without that a
    // ciphertext lifted from another record opens here, and the permanent
    // store becomes a way to attribute one counterparty's evidence to
    // another. Planted with the append-only trigger off, inside a
    // transaction that is rolled back.
    const { record, nsId } = await promoted("PERM4", "op:perm:4");
    const after = at("2027-05-01T00:00:00.000Z");
    // A real sibling in the SAME namespace, so the composite foreign key is
    // satisfied and the move is the one that matters: a record re-pointed at
    // another observation of the same counterparty. A random id would be
    // refused by the key before the binding was ever consulted.
    const movedRecordId = randomUUID();
    const sibling = storedObservation(
      await at("2027-03-15T00:00:00.000Z").obs.append(anEventFor("PERM4", "op:perm:4b")),
    );
    expect(nsId).toBeDefined();
    const trigger = randomUUID();
    await sql`
      insert into trigger_event (trigger_id, namespace_id, observation_id, status, tier, cluster_id, surprise, created_at)
      values (${trigger}, ${nsId}, ${sibling.observationId}, 'candidate', null, null, 4.5,
              ${new Date("2027-03-16T00:00:00.000Z")})`.execute(db);
    const moves = {
      // record_id is part of the binding and was the one part nothing moved:
      // the pair mutant that dropped it from BOTH sides died only by
      // accident, through the forgery test's incidental pin on the AAD's
      // shape. Moved here, and the read is asked for the NEW id.
      record_id: sql`record_id = ${movedRecordId}`,
      observation_id: sql`observation_id = ${sibling.observationId}`,
      original_dated_at: sql`original_dated_at = original_dated_at + interval '1 day'`,
      promoted_at: sql`promoted_at = promoted_at + interval '1 day'`,
      // The two the branch review found outside the envelope. Measured
      // through this very bypass: before they were bound, a rewritten
      // confidence and a record repointed at a sibling trigger both still
      // opened and still returned the rescued observation, while the comment
      // beside `permanentAad` said every column beside the payload was
      // inside it.
      confidence: sql`confidence = 0.01`,
      // Moved from null TO a real trigger, which is the direction that
      // matters: a rewrite that invents a justification for a rescue nobody
      // asked for. The trigger row exists so the foreign key is satisfied
      // and the binding is what refuses, not the key.
      rescued_by: sql`rescued_by = ${trigger}`,
    };
    for (const [column, move] of Object.entries(moves)) {
      const ROLLBACK = Symbol("rollback");
      let refused: unknown;
      await db.transaction().execute(async (trx) => {
        // Both guards off: one refuses any UPDATE, the other refuses a move
        // of the preserved instant, and this plants exactly those moves.
        await sql`alter table permanent_record disable trigger permanent_record_append_only`
          .execute(trx);
        await sql`alter table permanent_record disable trigger permanent_record_date_preserved`
          .execute(trx);
        await sql`update permanent_record set ${move} where record_id = ${record.recordId}`
          .execute(trx);
        const inside = new PermanentRecordRepository(
          trx, ring, fixedClock(new Date("2027-05-01T00:00:00.000Z")), grace7,
        );
        const asked = column === "record_id" ? movedRecordId : record.recordId;
        refused = await inside.read(asked).then(() => null, (e: unknown) => e);
        throw ROLLBACK;
      }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
      expect(refused, column).toBeInstanceOf(CiphertextRejected);
    }
    // And the row is untouched afterwards, so the loop measured refusals
    // rather than destroying the fixture.
    expect(await after.rec.read(record.recordId)).toBeDefined();
  });

  it("refuses a payload that opens but is not an observation", async () => {
    // The re-parse through the schema, which nothing held: dropping it left
    // `read` handing back whatever JSON the column contained. The key and
    // the binding are both correct here -- this is a record sealed by
    // someone with the namespace key, which is the whole threat model one
    // level down -- so only the parse stands between the caller and a shape
    // the rest of the engine will throw on somewhere far from here.
    const { record, nsId } = await promoted("PERM5", "op:perm:5");
    const after = at("2027-05-01T00:00:00.000Z");
    const row = await after.rec.get(record.recordId);
    const forged = seal(
      await after.ns.dataKey(nsId),
      JSON.stringify({ notAnObservation: true }),
      permanentAad({
        recordId: row.recordId, observationId: row.observationId,
        namespaceId: row.namespaceId, rescuedBy: row.rescuedBy,
        confidence: row.confidence, originalDatedAt: row.originalDatedAt,
        promotedAt: row.promotedAt,
      }),
    );
    const ROLLBACK = Symbol("rollback");
    let refused: unknown;
    await db.transaction().execute(async (trx) => {
      await sql`alter table permanent_record disable trigger permanent_record_append_only`
        .execute(trx);
      await sql`update permanent_record set payload_nonce = ${forged.nonce},
                  payload_tag = ${forged.tag}, payload_ciphertext = ${forged.ciphertext}
                where record_id = ${record.recordId}`.execute(trx);
      const inside = new PermanentRecordRepository(
        trx, ring, fixedClock(new Date("2027-05-01T00:00:00.000Z")), grace7,
      );
      refused = await inside.read(record.recordId).then(() => null, (e: unknown) => e);
      throw ROLLBACK;
    }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).constructor.name).toBe("ZodError");
  });

  // The erasure gate section 6 gives `observation` has no counterpart on
  // `permanent_record`, and `promote` reads `key_shredded_at` without
  // locking the row it read it from. An erasure committing in that window
  // wrote a permanent copy of an erased counterparty's evidence: measured,
  // no refusal and no block, one row committed. The FK's FOR KEY SHARE does
  // not conflict with the shred's FOR NO KEY UPDATE, so the foreign key does
  // not close it either.
  //
  // The fix is the lock, not a second check: a check re-read after the write
  // would still have a window. `for no key update of namespace` on the
  // source SELECT makes the read and the write one serialised unit against
  // `shred`, which takes the same mode.
  it("refuses a promotion whose namespace is erased between its read and its write", async () => {
    const other = new Kysely<Schema>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: withIsoDates(urlForSchema(requireTestUrl(), "permrec_test")), max: 2 }),
      }),
    });
    try {
      const c = fixedClock(new Date("2027-04-02T00:00:00.000Z"));
      const nsRepo = new NamespaceRepository(db, ring, c, grace7);
      const obs = new ObservationRepository(db, nsRepo, c, grace7);
      const o = storedObservation(await obs.append(anEventFor("PERMRACE", "op:perm:race")));
      const nsId = (await nsRepo.find("wallet", "PERMRACE"))!.namespaceId;

      // An erasure holding its lock, released only once the promotion is
      // demonstrably queued behind it.
      let go!: () => void, took!: () => void;
      const held = new Promise<void>((r) => { go = r; });
      // The HOLDER signals, so this half needs no poll at all. Polling
      // `pg_stat_activity` for "something is idle in transaction" was the
      // first version and it is wrong for a reason worth keeping: vitest runs
      // test FILES in parallel against one database, so a sibling file's
      // backend satisfied the predicate, the promotion fired before the shred
      // had its lock, and the promotion won. `datname = current_database()`
      // is not enough when the siblings share the database -- one level
      // deeper than the `pg_locks` lesson, same shape.
      const lockTaken = new Promise<void>((r) => { took = r; });
      const erasing = other.transaction().execute(async (trx) => {
        await new NamespaceRepository(trx, ring, c, grace7).shred(nsId);
        took();
        await held;
      });
      await lockTaken;
      const promoting = new PermanentRecordRepository(db, ring, c, grace7).promote({
        observationId: o.observationId, namespaceId: nsId, rescuedBy: null, confidence: 0.7,
      }).then(() => null, (e: unknown) => e);

      let blocked = false;
      try {
        for (let i = 0; i < 60 && !blocked; i++) {
          const waiting = await sql<{ n: string }>`
            select count(*)::text as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              -- This exact clause appears in promote's source SELECT and
              -- nowhere else, so a sibling file cannot satisfy it.
              and query ilike '%for no key update of namespace%'`.execute(db);
          blocked = waiting.rows[0]!.n !== "0";
          if (!blocked) await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        go();
      }
      await erasing;
      // Non-vacuous: if the promotion never queued, what follows proves
      // nothing about ordering.
      expect(blocked, "the promotion never queued behind the erasure's lock").toBe(true);
      expect(await promoting).toBeInstanceOf(NamespaceShredded);
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from permanent_record where namespace_id = ${nsId}`.execute(db);
      expect(rows.rows[0]!.n).toBe("0");
    } finally {
      await other.destroy();
    }
  }, 20_000);

  it("reads the observation on its OWN transaction, not on the pool", async () => {
    // R21's point, and the only thing that can see it. Under READ COMMITTED
    // a pool read returns the same committed rows, so swapping `trx` for the
    // pool changes no answer -- and deadlocks the pool the moment there is
    // contention, because `promote` is already holding a connection while it
    // asks for another. A pool of one makes that deterministic: on the
    // transaction it completes, on the pool it waits for a connection only
    // it could release.
    const narrow = new Kysely<Schema>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: withIsoDates(urlForSchema(requireTestUrl(), "permrec_test")), max: 1 }),
      }),
    });
    try {
      const c = fixedClock(new Date("2027-03-15T00:00:00.000Z"));
      const nsRepo = new NamespaceRepository(db, ring, c, grace7);
      const obs = new ObservationRepository(db, nsRepo, c, grace7);
      const o = storedObservation(await obs.append(anEventFor("PERM6", "op:perm:6")));
      const nsId = (await nsRepo.find("wallet", "PERM6"))!.namespaceId;
      const record = await new PermanentRecordRepository(narrow, ring, c, grace7).promote({
        observationId: o.observationId, namespaceId: nsId,
        rescuedBy: null, confidence: 0.7,
      });
      expect(record.observationId).toBe(o.observationId);
    } finally {
      await narrow.destroy();
    }
  }, 15_000);

  it("refuses a record with no payload at all", async () => {
    // NOT NULL on the three columns, which nothing held: made nullable, the
    // suite stayed green, and a record with no payload is exactly the empty
    // rescue this section exists to make impossible.
    // All THREE columns. The first version planted only the ciphertext, and
    // review found the other two undefended: a raw writer could store a
    // record with a null nonce or tag, and `read` then threw a bare
    // TypeError on `sealed.nonce.length` instead of a named refusal.
    const { record } = await promoted("PERM7", "op:perm:7");
    for (const column of ["payload_nonce", "payload_tag", "payload_ciphertext"] as const) {
      const ROLLBACK = Symbol("rollback");
      let refused: unknown;
      await db.transaction().execute(async (trx) => {
        await sql`alter table permanent_record disable trigger permanent_record_append_only`
          .execute(trx);
        refused = await sql`update permanent_record set ${sql.ref(column)} = null
                            where record_id = ${record.recordId}`.execute(trx)
          .then(() => null, (e: unknown) => e);
        throw ROLLBACK;
      }).catch((e: unknown) => { if (e !== ROLLBACK) throw e; });
      expect((refused as { code?: string }).code, column).toBe("23502");
    }
  });

  it("seals under the spellings the database stores, not the caller's", async () => {
    // The empty rescue, reopened one column over. `promote` sealed with the
    // uuid STRINGS the caller passed while `read` rebuilt the binding from
    // the canonical lowercase the database hands back -- so a caller who
    // spelled an id in uppercase, or in brace form, got a promotion that
    // SUCCEEDED, wrote a complete-looking row, and produced a payload that
    // never opens. Worse than the bug this task closed, because the failure
    // is CiphertextRejected and reads as a tamper.
    //
    // The rule was already written down one file over: the wrap's associated
    // data is bytes, and the bytes it was bound to are the canonical form
    // the database reports. `promote` broke it.
    const march = at("2027-03-15T00:00:00.000Z");
    const nsId = (await march.ns.ensure({ kind: "wallet", id: "PERM8" })).namespaceId;
    // One observation per shape: a record is promoted once per observation
    // (permanent_record_once), so re-promoting the same one would fail on
    // the unique key rather than on the binding this test is about.
    const shapes = [
      ["upper namespace", (n: string) => n.toUpperCase(), (o: string) => o],
      ["upper observation", (n: string) => n, (o: string) => o.toUpperCase()],
      ["braced namespace", (n: string) => `{${n}}`, (o: string) => o],
    ] as const;
    for (const [shape, spellNs, spellObs] of shapes) {
      const o = storedObservation(await march.obs.append(anEventFor("PERM8", `op:perm:8:${shape}`)));
      const record = await march.rec.promote({
        observationId: spellObs(o.observationId), namespaceId: spellNs(nsId),
        rescuedBy: null, confidence: 0.4,
      });
      expect(await march.rec.read(record.recordId), shape).toEqual(o);
    }
  });

  it("pins the permanent_record column catalogue", async () => {
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'permanent_record'
      order by column_name`.execute(db);
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      "confidence", "namespace_id", "observation_id", "original_dated_at",
      "payload_ciphertext", "payload_nonce", "payload_tag",
      "promoted_at", "record_id", "rescued_by",
    ]);
  });
});
