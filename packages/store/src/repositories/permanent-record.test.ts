import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { RETENTION_V0 } from "../retention.js";
import {
  AppendOnlyViolation, ConstraintViolation, NamespaceShredded, ObservationNotFound,
  PermanentRecordNotFound, StateNotPromotable, StoreError, mapPgError,
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
  observations = new ObservationRepository(db, namespaces, clock);
  records = new PermanentRecordRepository(db, clock);
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
    const { observation } = await observations.append(anEventOn("2026-09-12T09:00:00.000Z"));
    expect(observation.ingestedAt).toBe("2026-09-12T10:00:00.000Z");
    clock.advance(9 * DAY);
    const record = await records.promote({
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(anEventOn("2026-09-12T10:00:00.000Z"));
    const record = await records.promote({
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(anEventOn("2026-09-13T09:00:00.000Z"));
    await expect(
      sql`insert into permanent_record
            (record_id, observation_id, namespace_id, original_dated_at, promoted_at, confidence)
          values (gen_random_uuid(), ${observation.observationId}, ${ns},
                  '2026-09-21T00:00:00Z', now(), 0.5)`.execute(db),
    ).rejects.toMatchObject({ code: "NNT04" });
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId!).execute();
    expect(rows).toEqual([]);
  });

  // The table is append-only, and that trigger sorts before this one, so an
  // ordinary update is refused as NNT01 before the instant is ever compared.
  // The date trigger's update leg is defence in depth for the day the
  // append-only trigger is disabled, so it is proved with exactly that: the
  // append-only trigger off inside a transaction that is then rolled back,
  // and the instant still refused.
  it("refuses an update that moves the instant afterwards, even with append-only off", async () => {
    const { observation } = await observations.append(anEventOn("2026-09-14T09:00:00.000Z"));
    const record = await records.promote({
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(aState());
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
    const { observation } = await observations.append(anEventOn("2026-09-14T10:00:00.000Z"));
    const record = await records.promote({
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(anEventOn("2026-09-14T11:00:00.000Z"));
    const record = await records.promote({
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(anEventOn("2026-09-15T09:00:00.000Z"));
    const input = {
      observationId: observation.observationId!, namespaceId: ns,
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
    const { observation } = await observations.append(anEventOn("2026-09-16T09:00:00.000Z"));
    const filed = records.promote({
      observationId: observation.observationId!, namespaceId: other.namespaceId,
      rescuedBy: null, confidence: 0.8,
    });
    await expect(filed).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(filed).rejects.toMatchObject({
      sqlstate: "23503", constraint: "permanent_record_observation_in_namespace",
    });
  });

  it("holds confidence to the unit interval, NaN included", async () => {
    for (const confidence of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { observation } = await observations.append(anEventOn("2026-09-17T09:00:00.000Z"));
      const promoted = records.promote({
        observationId: observation.observationId!, namespaceId: ns,
        rescuedBy: null, confidence,
      });
      await expect(promoted).rejects.toBeInstanceOf(ConstraintViolation);
      await expect(promoted).rejects.toMatchObject({ sqlstate: "23514", constraint: "permanent_record_confidence" });
    }
  });
});

describe("what the repository refuses before writing", () => {
  // A state's dated_at is null and original_dated_at is not null, so the
  // database would refuse this on its own. It is named here so that a caller
  // promoting a state can tell that from a disk error, and so that the
  // refusal happens before anything is written rather than as a rollback.
  it("refuses to promote a state, by class, because it has no instant to preserve", async () => {
    const { observation } = await observations.append(aState());
    await expect(records.promote({
      observationId: observation.observationId!, namespaceId: ns,
      rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(StateNotPromotable);
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId!).execute();
    expect(rows).toEqual([]);
  });

  // A promotion exists to make evidence surface in a future brief, and
  // evidence whose content can never be read again can only produce a reason
  // nobody can explain. The observation row survives a shred and its instant
  // is still readable, so nothing in the database refuses this on its own.
  it("refuses to promote into a shredded namespace, by class, and writes nothing", async () => {
    const shredded = await namespaces.ensure({ kind: "wallet", id: "SHREDPROMO" });
    const { observation } = await observations.append(anEventOn("2026-09-18T09:00:00.000Z", {
      namespace: { kind: "wallet", id: "SHREDPROMO" },
    }));
    await namespaces.shred(shredded.namespaceId);
    await expect(records.promote({
      observationId: observation.observationId!, namespaceId: shredded.namespaceId,
      rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(NamespaceShredded);
    const rows = await db.selectFrom("permanent_record").select(["record_id"])
      .where("observation_id", "=", observation.observationId!).execute();
    expect(rows).toEqual([]);
  });

  it("names a missing observation by class", async () => {
    await expect(records.promote({
      observationId: randomUUID(), namespaceId: ns, rescuedBy: null, confidence: 0.5,
    })).rejects.toBeInstanceOf(ObservationNotFound);
  });
});
