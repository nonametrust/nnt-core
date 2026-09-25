import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { deriveIdempotencyKey, type WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import { openDb, type Db } from "../db.js";
import {
  requireTestUrl, storedObservation, urlForSchema, withSchema,
} from "../testing/harness.js";
import { keyRingFromEnv, newDataKey, payloadAad, seal } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { RETENTION_V0, periodOf } from "../retention.js";
import {
  CiphertextRejected, ConstraintViolation, IdempotencyKeyMismatch, NamespaceShredded,
  ObservationNotFound, PayloadExpired, StoreError, mapPgError, SourceRateExceeded,
} from "../errors.js";
import { NamespaceRepository } from "./namespace.js";
import { ObservationRepository } from "./observation.js";

let db: Db;
let done: () => Promise<void>;
let observations: ObservationRepository;
let namespaces: NamespaceRepository;
const ring = keyRingFromEnv(
  { NNT_MASTER_KEY: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv,
);
const clock = fixedClock(new Date("2026-09-07T00:00:00.000Z"));

const src = {
  producer: "stellar-indexer", producerVersion: "0.1.0",
  network: "testnet", ref: "op:1", fetchedAt: "2026-09-05T10:00:00.000Z",
};

function anEvent(over: Record<string, unknown> = {}): WireObservation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "GOLDADDRESS" },
    channel: "volume", evidenceKind: "event", kind: "payment",
    observedAt: "2026-09-12T09:00:00.000Z",
    source: src, payload: { amount: "500.0000000" },
    salienceHints: { amount: "500.0000000" },
    ...over,
  } as WireObservation;
}

function aState(over: Record<string, unknown> = {}): WireObservation {
  return {
    schemaVersion: "0.1.0",
    namespace: { kind: "wallet", id: "GOLDADDRESS" },
    channel: "protocol", evidenceKind: "state", kind: "trustline_open",
    validFrom: "2026-09-01T00:00:00.000Z", validUntil: null,
    source: { ...src, ref: "op:state:1" }, payload: {},
    ...over,
  } as WireObservation;
}

beforeAll(async () => {
  ({ db, done } = await withSchema("obs_test"));
  namespaces = new NamespaceRepository(db, ring, clock, RETENTION_V0);
  observations = new ObservationRepository(db, namespaces, clock, RETENTION_V0);
});
afterAll(async () => { await done(); });

describe("the round trip", () => {
  it("returns every wire field it was given", async () => {
    const input = anEvent({ source: { ...src, ref: "op:rt:1" } });
    const _r = await observations.append(input);
    const created = _r.created;
    const observation = storedObservation(_r);
    expect(created).toBe(true);
    // `get` has already re-parsed the decrypted blob through the schema; that
    // parse is the proof, and a second one here would only hide which one
    // carries it.
    const read = (await observations.get(observation.observationId!)) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      expect(read[key]).toEqual((input as Record<string, unknown>)[key]);
    }
  });

  it("assigns the two fields ingest owns, and they are well-formed", async () => {
    const observation = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:rt:2" } })));
    expect(observation.observationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(observation.ingestedAt).toBe("2026-09-07T00:00:00.000Z");
  });

  it("carries the muxed identifier and the continuity assertion back out", async () => {
    const input = anEvent({
      source: { ...src, ref: "op:rt:3" },
      namespace: {
        kind: "wallet", id: "GOLDADDRESS", muxedId: "42",
        continuity: {
          assertedBy: "ops", assertedAt: "2026-09-06T00:00:00.000Z", reason: "same operator",
        },
      },
    });
    const observation = storedObservation(await observations.append(input));
    const read = await observations.get(observation.observationId!);
    expect(read.namespace).toEqual((input as Record<string, unknown>).namespace);
  });

  it("leaves a state undated, so a standing condition never enters a timing computation", async () => {
    const observation = storedObservation(await observations.append(aState()));
    const row = await db.selectFrom("observation").select(["dated_at"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.dated_at).toBeNull();
    const read = await observations.get(observation.observationId!);
    expect(read.evidenceKind).toBe("state");
  });

  it("dates an event by its own instant", async () => {
    const observation = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:rt:4" } })));
    const row = await db.selectFrom("observation").select(["dated_at"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.dated_at?.toISOString()).toBe("2026-09-12T09:00:00.000Z");
  });

  it("names a missing observation by class, so a bad id is not mistaken for a bug", async () => {
    await expect(observations.get(randomUUID())).rejects.toBeInstanceOf(ObservationNotFound);
    await expect(observations.get(randomUUID())).rejects.toBeInstanceOf(StoreError);
    expect(await observations.byIdempotencyKey("no such key")).toBeNull();
  });
});

// The repository derives dated_at and evidence_kind from one parsed object, so
// it cannot write a row that breaks either direction of the invariant. These
// two go under the repository, by raw SQL, and prove the database refuses the
// rows a repository bug or a hand-written script could otherwise produce. The
// constraint name is asserted because it is what tells the two directions
// apart when one fires.
describe("the invariant the table holds on its own", () => {
  // The period and its key row are part of the fixture now: the foreign key
  // means no payload may be stored without a key to open it under, so a raw
  // writer must mint one first exactly as `append` does. Loud if forgotten,
  // which is the point of the constraint.
  async function rawRow(evidenceKind: string, datedAt: Date | null) {
    const ns = (await namespaces.ensure({ kind: "wallet", id: "RAWROWS" })).namespaceId;
    const period = periodOf(clock.now());
    await namespaces.periodKey(ns, period);
    return sql`
      insert into observation (
        observation_id, idempotency_key, namespace_id, channel, kind, evidence_kind,
        dated_at, ingested_at, producer, period, payload_nonce, payload_tag, payload_ciphertext
      ) values (
        ${randomUUID()}, ${randomUUID()}, ${ns}, 'protocol', 'raw', ${evidenceKind},
        ${datedAt}, ${clock.now()}, 'raw-writer', ${period}::date,
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex')
      )
    `.execute(db);
  }

  it("refuses a dated state", async () => {
    await expect(rawRow("state", new Date("2026-09-01T00:00:00.000Z")))
      .rejects.toMatchObject({ code: "23514", constraint: "observation_state_is_undated" });
  });

  it("refuses an undated event", async () => {
    await expect(rawRow("event", null))
      .rejects.toMatchObject({ code: "23514", constraint: "observation_event_is_dated" });
  });
});

describe("idempotency", () => {
  it("yields one observation for the same source event twice", async () => {
    const input = anEvent({ source: { ...src, ref: "op:dup:1" } });
    const first = await observations.append(input);
    const second = await observations.append(input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(storedObservation(second).observationId).toBe(storedObservation(first).observationId);
  });

  it("keeps the two sides of one payment apart, because the namespace is in the key", async () => {
    const ref = "op:twosided:1";
    const sender = await observations.append(anEvent({
      source: { ...src, ref }, namespace: { kind: "wallet", id: "SENDER" },
    }));
    const receiver = await observations.append(anEvent({
      source: { ...src, ref }, namespace: { kind: "wallet", id: "RECEIVER" },
    }));
    expect(receiver.created).toBe(true);
    expect(storedObservation(receiver).observationId).not.toBe(storedObservation(sender).observationId);
  });

  it("stores the derived key, not one a caller invented", async () => {
    const input = anEvent({ source: { ...src, ref: "op:key:1" } });
    const observation = storedObservation(await observations.append(input));
    const row = await db.selectFrom("observation").select(["idempotency_key"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.idempotency_key).toBe(
      deriveIdempotencyKey(input.source, input.channel, input.namespace),
    );
  });

  // A caller who writes with key K and then asks byIdempotencyKey(K) must not
  // get null for something the store said it created. Silently storing the
  // derived key instead would accept a claim and later deny it, so a key that
  // is present and wrong is refused, and refused before the pre-read so it is
  // never answered with `created: false` either.
  it("refuses a caller-supplied key that differs from the derived one, and writes nothing", async () => {
    const input = anEvent({ source: { ...src, ref: "op:mismatch:1" }, idempotencyKey: "a".repeat(64) });
    await expect(observations.append(input)).rejects.toBeInstanceOf(IdempotencyKeyMismatch);
    expect(await observations.byIdempotencyKey(
      deriveIdempotencyKey(input.source, input.channel, input.namespace),
    )).toBeNull();
  });

  it("refuses a mismatched key even when the observation is already stored, rather than calling it a duplicate", async () => {
    const stored = anEvent({ source: { ...src, ref: "op:mismatch:2" } });
    expect((await observations.append(stored)).created).toBe(true);
    const wrong = anEvent({ source: { ...src, ref: "op:mismatch:2" }, idempotencyKey: "b".repeat(64) });
    await expect(observations.append(wrong)).rejects.toBeInstanceOf(IdempotencyKeyMismatch);
    const right = anEvent({
      source: { ...src, ref: "op:mismatch:2" },
      idempotencyKey: deriveIdempotencyKey(stored.source, stored.channel, stored.namespace),
    });
    expect((await observations.append(right)).created).toBe(false);
  });

  // The race itself, made deterministic: this instance's first pre-read sees
  // nothing, as a writer that lost the race would, and its insert then lands
  // on the row the winner stored. The loser must come back with the winner's
  // observation and `created: false`, not with an error.
  it("returns the winner's row when a concurrent writer stored the key first", async () => {
    const input = anEvent({ source: { ...src, ref: "op:race:1" } });
    const winner = await observations.append(input);
    const loser = new ObservationRepository(db, namespaces, clock, RETENTION_V0);
    // Blinds the SKELETON read, which is what the pre-read is since R19.
    // Blinding byIdempotencyKey no longer simulates a loser: the skeleton
    // would still find the row and the insert this test is about would never
    // be attempted. The stub is one call deep for the same reason as before
    // -- the loser must read nothing, then insert, then learn it lost from
    // the duplicate and re-read.
    const priv = loser as unknown as { skeleton: (k: string) => Promise<unknown> };
    const realSkeleton = priv.skeleton.bind(loser);
    let blind = true;
    priv.skeleton = async (key: string) => {
      if (blind) { blind = false; return null; }
      return realSkeleton(key);
    };
    const result = await loser.append(input);
    expect(result).toMatchObject({ created: false, readable: true });
    if (result.created === false && result.readable) {
      expect(result.observation.observationId).toBe(storedObservation(winner).observationId);
    }
  });

  // The read-then-insert in append has a race, and the insert's failure is
  // how the loser learns it lost. Only a unique violation on the key is that
  // race. Any other failed insert must surface as the failure it was: a
  // caller told "already stored" when nothing was stored has lost evidence
  // with no error anywhere, which is the failure this whole table exists to
  // prevent. The stub hands back a namespace that has no row, so the insert
  // fails on the foreign key and not on the key; and the reads after the
  // first hand back a stand-in row, as they would if a concurrent writer had
  // stored the key meanwhile. A catch that re-read after any failure would
  // return that stand-in with `created: false`. This one must rethrow the
  // foreign-key violation, mapped to its class.
  it("does not report a failed insert as already stored", async () => {
    // `append` now mints and opens a month key as well, so the stand-in
    // answers those too: what is under test is that an insert refused by a
    // foreign key is not reported as "already stored", and the stand-in
    // exists to make that insert fail.
    const orphan = {
      ensure: async () => ({ namespaceId: randomUUID(), kind: "wallet", nsId: "ORPHAN", shreddedAt: null }),
      dataKey: async () => newDataKey(),
      periodKey: async () => undefined,
      openPeriodKey: async () => newDataKey(),
    } as unknown as NamespaceRepository;
    const broken = new ObservationRepository(db, orphan, clock, RETENTION_V0);
    const standIn = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:orphan:standin" } })));
    // The stand-in must be reachable through the PRE-READ, which since R19
    // is `skeleton` and not `byIdempotencyKey`. Stubbing only the latter left
    // this test green for the wrong reason: the real skeleton read found no
    // row, so the stub was never reached and the catch's guard was held by
    // nothing. Measured, and not by me -- rewriting `if (isDuplicateKey(e))`
    // to `if (true)` passed the whole suite at the commit that moved the
    // pre-read, and failed at its parent, which is this test doing its job
    // right up until the line it depends on moved out from under it.
    let blind = true;
    const priv = broken as unknown as { skeleton: (k: string) => Promise<unknown> };
    priv.skeleton = async () => {
      if (blind) { blind = false; return null; }
      return {
        observationId: standIn.observationId!,
        ingestedAt: new Date(standIn.ingestedAt!),
        periodExpired: false,
        namespaceErased: false,
      };
    };
    broken.byIdempotencyKey = async () => standIn;
    const input = anEvent({ source: { ...src, ref: "op:orphan:1" }, namespace: { kind: "wallet", id: "ORPHAN" } });
    const attempt = broken.append(input);
    await expect(attempt).rejects.toBeInstanceOf(ConstraintViolation);
    await expect(attempt).rejects.toMatchObject({ sqlstate: "23503" });
    expect(await observations.byIdempotencyKey(
      deriveIdempotencyKey(input.source, input.channel, input.namespace),
    )).toBeNull();
  });
});

describe("append-only", () => {
  it("refuses an UPDATE, loudly and by SQLSTATE", async () => {
    const observation = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:ao:1" } })));
    await expect(
      sql`update observation set kind = 'tampered' where observation_id = ${observation.observationId}`
        .execute(db),
    ).rejects.toMatchObject({ code: "NNT01" });
    const row = await db.selectFrom("observation").select(["kind"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.kind).toBe("payment");
  });

  it("refuses a DELETE", async () => {
    const observation = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:ao:2" } })));
    await expect(
      sql`delete from observation where observation_id = ${observation.observationId}`.execute(db),
    ).rejects.toMatchObject({ code: "NNT01" });
    const row = await db.selectFrom("observation").select(["observation_id"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirst();
    expect(row?.observation_id).toBe(observation.observationId);
  });

  it("exposes no update or delete on the repository surface at all", () => {
    const surface = Object.getOwnPropertyNames(ObservationRepository.prototype);
    expect(surface.filter((m) => /update|delete|remove/i.test(m))).toEqual([]);
  });
});

// The associated data names its own threat model: an attacker with write
// access to the table. Under that model the append-only trigger is already
// assumed bypassed, since a swap needs an UPDATE too, and so a column beside
// the payload can be moved while the payload still opens. dated_at is the
// one that matters most: the promotion trigger measures a record against
// that column, so a moved instant would be carried into a permanent record
// with nothing in the store able to tell. Every derived column is therefore
// inside the envelope, and this plants each move with the trigger off, inside
// a transaction it rolls back, and reads through the repository.
describe("the columns beside the payload", () => {
  it("are bound to it: a rewritten column refuses the read, even with append-only off", async () => {
    const observation = storedObservation(await observations.append(anEvent({ source: { ...src, ref: "op:aad:1" } })));
    const id = observation.observationId!;
    const moves = [
      sql`dated_at = dated_at + interval '1 day'`,
      sql`channel = 'latency'`,
      sql`kind = 'tampered'`,
      sql`evidence_kind = 'state', dated_at = null`,
      sql`producer = 'tampered'`,
      // An hour moves the instant without moving its calendar month, so the
      // period column still agrees and the envelope is what refuses it.
      sql`ingested_at = ingested_at + interval '1 hour'`,
    ];
    for (const move of moves) {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`alter table observation disable trigger observation_no_update`.execute(trx);
          await sql`update observation set ${move} where observation_id = ${id}`.execute(trx);
          const inside = new ObservationRepository(trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock, RETENTION_V0);
          await inside.get(id);
        }),
      ).rejects.toBeInstanceOf(CiphertextRejected);
    }
    // evidence_kind on its own. It is in the move list above only paired with
    // `dated_at = null`, because the table refuses a dated state -- and the
    // pair means `dated_at` is what refuses the read, so the binding of
    // evidence_kind was carried by its neighbour. Dropping the two 0002
    // checks inside the rolled-back transaction lets it move alone.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`alter table observation drop constraint observation_state_is_undated`.execute(trx);
        await sql`alter table observation drop constraint observation_event_is_dated`.execute(trx);
        await sql`update observation set evidence_kind = 'state' where observation_id = ${id}`
          .execute(trx);
        const inside = new ObservationRepository(
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock, RETENTION_V0,
        );
        await inside.get(id);
      }),
    ).rejects.toBeInstanceOf(CiphertextRejected);

    // And the move the period check now refuses first, made consistent so the
    // check passes and only the envelope is left to refuse it: ingested_at
    // and period moved together, with October's key minted so the foreign
    // key is satisfied too. Without this the suite no longer covers a
    // month-crossing move at the envelope at all.
    const ns = (await namespaces.find("wallet", "GOLDADDRESS"))!.namespaceId;
    await namespaces.periodKey(ns, "2026-10-01");
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set ingested_at = ingested_at + interval '1 month',
            period = date '2026-10-01' where observation_id = ${id}`.execute(trx);
        const inside = new ObservationRepository(
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock, RETENTION_V0,
        );
        await inside.get(id);
      }),
    ).rejects.toBeInstanceOf(CiphertextRejected);

    // The rollback put the trigger back, and the row reads as it was written.
    await expect(sql`update observation set channel = 'latency' where observation_id = ${id}`.execute(db))
      .rejects.toMatchObject({ code: "NNT01" });
    const again = await observations.get(id);
    expect(again.channel).toBe("volume");
    expect(again.kind).toBe("payment");
  });

  // The row's own primary key is inside the envelope, and this is the attack
  // that needs it. Every foreign key in the schema names an observation by
  // observation_id -- a tag, a permanent record, a trigger event -- so an
  // attacker who exchanges the whole contents of two rows in one namespace
  // (idempotency key, derived columns and ciphertext together, which the
  // unique key forces to happen in steps) repoints the evidence behind a tag
  // at another observation. Before the key was bound, both rows still opened
  // and nothing in the store could tell.
  it("refuses a payload whose row was exchanged with another observation's", async () => {
    const a = await observations.append(anEvent({ source: { ...src, ref: "op:swap:a" } }));
    const b = await observations.append(anEvent({
      source: { ...src, ref: "op:swap:b" }, kind: "refund",
    }));
    const idA = storedObservation(a).observationId!;
    const idB = storedObservation(b).observationId!;
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        // idempotency_key is unique, so the exchange goes through parking
        // values. Every statement here succeeds; nothing relies on an error.
        const keyB = (await sql<{ k: string }>`
          select idempotency_key as k from observation where observation_id = ${idB}`
          .execute(trx)).rows[0]!.k;
        await sql`update observation set idempotency_key = 'parked-a' where observation_id = ${idA}`
          .execute(trx);
        await sql`update observation set idempotency_key = 'parked-b' where observation_id = ${idB}`
          .execute(trx);
        await sql`update observation a set
            idempotency_key = ${keyB}, kind = b.kind, channel = b.channel,
            evidence_kind = b.evidence_kind, dated_at = b.dated_at, producer = b.producer,
            payload_nonce = b.payload_nonce, payload_tag = b.payload_tag,
            payload_ciphertext = b.payload_ciphertext
          from (select * from observation where observation_id = ${idB}) b
          where a.observation_id = ${idA}`.execute(trx);
        const inside = new ObservationRepository(
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock, RETENTION_V0,
        );
        await inside.get(idA);
      }),
    ).rejects.toBeInstanceOf(CiphertextRejected);
    // Rolled back: both rows read as they were written.
    expect((await observations.get(idA)).kind).toBe("payment");
    expect((await observations.get(idB)).kind).toBe("refund");
  });

  // The second layer, which the envelope alone does not exercise: a payload
  // sealed CORRECTLY for this row but carrying another observation's id
  // inside it. The envelope authenticates it, because every bound column is
  // this row's; only the comparison after the parse catches it.
  //
  // The attacker who can do this holds the data key, and one who holds it can
  // forge a consistent id too -- so this is not a defence against them. It is
  // a defence against us: a future path that seals the wrong object under the
  // right associated data, which is one copy-paste away in promote.
  it("refuses a payload that opens on this row but names another observation", async () => {
    const a = await observations.append(anEvent({ source: { ...src, ref: "op:forge:a" } }));
    const b = await observations.append(anEvent({ source: { ...src, ref: "op:forge:b" } }));
    const idA = storedObservation(a).observationId!;
    const row = await db.selectFrom("observation")
      .select(["namespace_id", "idempotency_key", "evidence_kind", "channel", "kind",
        "dated_at", "ingested_at", "producer"])
      .where("observation_id", "=", idA).executeTakeFirstOrThrow();
    const period = periodOf(row.ingested_at);
    const dataKey = await namespaces.openPeriodKey(row.namespace_id, period);
    const forged = seal(
      dataKey,
      JSON.stringify({ ...storedObservation(a), observationId: storedObservation(b).observationId }),
      payloadAad({
        namespaceId: row.namespace_id,
        observationId: idA,
        idempotencyKey: row.idempotency_key,
        evidenceKind: row.evidence_kind,
        channel: row.channel,
        kind: row.kind,
        producer: row.producer,
        ingestedAt: row.ingested_at,
        datedAt: row.dated_at,
      }),
    );
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set payload_nonce = ${forged.nonce},
            payload_tag = ${forged.tag}, payload_ciphertext = ${forged.ciphertext}
          where observation_id = ${idA}`.execute(trx);
        const inside = new ObservationRepository(
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock, RETENTION_V0,
        );
        await inside.get(idA);
      }),
    ).rejects.toThrow(/carries observation id/);
  });

  // The schema already refuses a producer that is not a bare lowercase name,
  // so the repository cannot write one. This refuses it from a writer that
  // did not come through the schema, which is the two-shapes rule M1 set: the
  // TypeScript refuses first and names the class, and the table refuses
  // everyone.
  it("refuses a producer the schema would refuse, from a raw writer, by constraint name", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:2" } }),
    ));
    const id = observation.observationId!;
    for (const bad of ["Stellar-Indexer", "stellar_indexer", "-stellar", "stellar--indexer", ""]) {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`alter table observation disable trigger observation_no_update`.execute(trx);
          await sql`update observation set producer = ${bad} where observation_id = ${id}`.execute(trx);
        }),
        bad,
      ).rejects.toMatchObject({ code: "23514", constraint: "observation_producer_shape" });
    }
  });

  // The shape check admits a null, because `producer ~ '...'` is null rather
  // than false for one, and a check constraint passes on null. So the shape
  // and the not-null are two separate rules and this holds the second.
  //
  // What a null costs is not a missing label: the read path rebuilds the
  // envelope from the row, so a null producer reaches `joinParts` as a
  // non-string and crashes with a TypeError from inside the crypto module,
  // which is neither a refusal this store owns nor one an operator can read.
  it("refuses a producer that is absent, which the shape check alone would admit", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:3" } }),
    ));
    const id = observation.observationId!;
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set producer = null where observation_id = ${id}`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23502", column: "producer" });
  });

  // The schema bounds the producer at 64 characters and the check restated
  // only the regex, which matches a name of any length. A check that admits
  // more than the schema does is a check that lets a raw writer store what
  // the repository never could -- which is the sentence the migration's own
  // comment makes, so the comment was false until this landed.
  it("refuses a producer longer than the schema's bound, and admits one at it", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:4" } }),
    ));
    const id = observation.observationId!;
    const at64 = "a".repeat(64);
    const at65 = "a".repeat(65);
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set producer = ${at65} where observation_id = ${id}`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "observation_producer_shape" });
    // The bound is 64 and not 63: a check one short would refuse a legitimate
    // name, which is the other direction of the same error and would be
    // invisible without this half. The transaction rolls itself back through
    // a sentinel, so the row is left as it was written.
    const rolledBack = new Error("rollback");
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set producer = ${at64} where observation_id = ${id}`.execute(trx);
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);
    expect((await observations.get(id)).source.producer).toBe("stellar-indexer");
  });

  // Two producers, because one cannot tell a derived value from a constant.
  // With a single producer in the fixture, hard-coding both the envelope and
  // the column to that name passes the entire suite -- review found exactly
  // that mutant alive. The column is what Task 8's cap will count by, and a
  // constant would collapse a per-producer cap into a global one.
  it("derives the producer per observation, not once for the repository", async () => {
    const a = await observations.append(anEvent({
      source: { ...src, producer: "stellar-indexer", ref: "op:twoproducers:a" },
    }));
    const b = await observations.append(anEvent({
      source: { ...src, producer: "x402-gateway", ref: "op:twoproducers:b" },
    }));
    const rows = await db.selectFrom("observation").select(["observation_id", "producer"])
      .where("observation_id", "in", [storedObservation(a).observationId!, storedObservation(b).observationId!])
      .execute();
    const byId = new Map(rows.map((r) => [r.observation_id, r.producer]));
    expect(byId.get(storedObservation(a).observationId!)).toBe("stellar-indexer");
    expect(byId.get(storedObservation(b).observationId!)).toBe("x402-gateway");
    // And both still open, so the column and the envelope agree for each.
    expect((await observations.get(storedObservation(a).observationId!)).source.producer).toBe("stellar-indexer");
    expect((await observations.get(storedObservation(b).observationId!)).source.producer).toBe("x402-gateway");
  });

  // The envelope binds the Date the column will hold, and every test in this
  // package uses a frozen clock, so a second read of the clock for the column
  // returns the same instant and the rule is held by the fixture rather than
  // by the code. Under a real clock that mutant makes every payload fail to
  // open at its first read. This clock moves on every call.
  it("binds the instant it stores, not a second reading of the clock", async () => {
    let t = new Date("2026-09-07T00:00:00.000Z").getTime();
    const ticking = { now: () => { const d = new Date(t); t += 1_000; return d; } };
    const ns = new NamespaceRepository(db, ring, ticking, RETENTION_V0);
    const repo = new ObservationRepository(db, ns, ticking, RETENTION_V0);
    const observation = storedObservation(await repo.append(
      anEvent({ source: { ...src, ref: "op:ticking:1" } }),
    ));
    const id = observation.observationId!;
    // The read must succeed: it rebuilds the envelope from the stored column,
    // so column and envelope agreeing is exactly what this proves.
    await expect(repo.get(id)).resolves.toBeDefined();
    const row = await db.selectFrom("observation").select(["ingested_at"])
      .where("observation_id", "=", id).executeTakeFirst();
    expect(row?.ingested_at.toISOString()).toBe(observation.ingestedAt);
  });
});

describe("shredding", () => {
  it("leaves the row and refuses the read, by class", async () => {
    const ns = await namespaces.ensure({ kind: "wallet", id: "SHREDOBS" });
    const observation = storedObservation(await observations.append(anEvent({
      source: { ...src, ref: "op:shred:1" }, namespace: { kind: "wallet", id: "SHREDOBS" },
    })));
    await namespaces.shred(ns.namespaceId);
    const row = await db.selectFrom("observation").select(["observation_id"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirst();
    expect(row).toBeDefined();
    await expect(observations.get(observation.observationId!))
      .rejects.toBeInstanceOf(NamespaceShredded);
  });

  // Correct by reading, since `ensure` leaves a shredded row as it is and
  // `dataKey` throws before any insert, but every unenforced property in this
  // repository has turned out false at some point, so it is pinned.
  it("refuses a new observation for a shredded namespace, by class, and stores nothing", async () => {
    const ns = await namespaces.ensure({ kind: "wallet", id: "SHREDFIRST" });
    await namespaces.shred(ns.namespaceId);
    const input = anEvent({
      source: { ...src, ref: "op:shred:2" }, namespace: { kind: "wallet", id: "SHREDFIRST" },
    });
    await expect(observations.append(input)).rejects.toBeInstanceOf(NamespaceShredded);
    const rows = await db.selectFrom("observation").select(["observation_id"])
      .where("namespace_id", "=", ns.namespaceId).execute();
    expect(rows).toEqual([]);
  });
});

// The period column, the month key it points at, and the foreign key that
// makes "no payload without a key row" a fact rather than an ordering.
describe("the retention period", () => {
  it("is the UTC calendar month of ingested_at, and a key row exists for it", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:period:1" } }),
    ));
    const row = await sql<{ period: string }>`
      select to_char(period, 'YYYY-MM-DD') as period from observation
      where observation_id = ${observation.observationId!}`.execute(db);
    // The clock is 2026-09-07, and the period follows INGEST time, not the
    // event's: this observation is dated 2026-09-12, a different month from
    // neither, and the column says September because that is when it was
    // written. R1's reason, restated as a test: a backfill keyed on the
    // event's month would be born expired.
    expect(row.rows[0]?.period).toBe("2026-09-01");
    const ns = (await namespaces.find("wallet", "GOLDADDRESS"))!.namespaceId;
    expect(await namespaces.periodsOf(ns)).toContain("2026-09-01");
  });

  // Derived, not passed in: the same rule every other column beside the
  // payload follows. A raw writer that disagrees with ingested_at is refused
  // by name, so the two can never drift.
  it("refuses a period that is not the month of its own ingested_at, by name", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:period:2" } }),
    ));
    const id = observation.observationId!;
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set period = date '2026-10-01' where observation_id = ${id}`
          .execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "observation_period_from_ingested_at" });
  });

  // This is the assertion that inverted. Before the period column, moving
  // ingested_at across a month boundary was refused by the ENVELOPE at read
  // time; now the check refuses the write itself, before any payload is
  // consulted, and the test says which layer refused. Re-greening it by
  // deleting it would remove the loud refusal and leave the quiet one.
  it("refuses a move of ingested_at across a month boundary at the write, not at the read", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:period:3" } }),
    ));
    const id = observation.observationId!;
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set ingested_at = ingested_at + interval '1 month'
          where observation_id = ${id}`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "observation_period_from_ingested_at" });
  });

  it("refuses an observation whose month has no key row, by foreign key", async () => {
    const ns = (await namespaces.ensure({ kind: "wallet", id: "NOKEYROW" })).namespaceId;
    await expect(
      sql`insert into observation (
          observation_id, idempotency_key, namespace_id, channel, kind, evidence_kind,
          dated_at, ingested_at, producer, period, payload_nonce, payload_tag, payload_ciphertext
        ) values (
          ${randomUUID()}, ${randomUUID()}, ${ns}, 'volume', 'payment', 'event',
          ${clock.now()}, ${clock.now()}, 'raw-writer', date '2026-09-01',
          decode('00','hex'), decode('00','hex'), decode('00','hex')
        )`.execute(db),
    ).rejects.toMatchObject({ code: "23503", constraint: "observation_period_key" });
  });

  // The payload is sealed under the MONTH key, which is what makes expiry
  // unreadability rather than a column update. Before this task it was sealed
  // under the namespace key and expiring a month made nothing unreadable --
  // measured by review, which is why this test exists rather than a comment.
  it("seals under the month key, so expiring that month makes it unreadable", async () => {
    const ns = (await namespaces.ensure({ kind: "wallet", id: "EXPIREME" })).namespaceId;
    const observation = storedObservation(await observations.append(anEvent({
      source: { ...src, ref: "op:period:4" }, namespace: { kind: "wallet", id: "EXPIREME" },
    })));
    const id = observation.observationId!;
    expect(await observations.get(id)).toBeDefined();

    const row = await db.selectFrom("namespace_key").select(["expires_at"])
      .where("namespace_id", "=", ns).executeTakeFirstOrThrow();
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${row.expires_at}
      where namespace_id = ${ns}`.execute(db);

    await expect(observations.get(id)).rejects.toBeInstanceOf(PayloadExpired);
    // The row is still there, with its ciphertext: retention is unreadability,
    // not deletion.
    const still = await db.selectFrom("observation").select(["payload_ciphertext"])
      .where("observation_id", "=", id).executeTakeFirst();
    expect(still?.payload_ciphertext.length).toBeGreaterThan(0);
  });

  // The check alone admits a null: `period = date_trunc(...)` evaluates to
  // NULL, not false, and a check constraint passes on NULL. Shape and
  // presence are two rules. This is the third column on this branch with
  // exactly that gap -- producer and tag.aspect were the first two -- so it
  // is written down rather than remembered.
  it("refuses a period that is absent, which the check alone admits", async () => {
    const observation = storedObservation(await observations.append(
      anEvent({ source: { ...src, ref: "op:period:5" } }),
    ));
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`alter table observation disable trigger observation_no_update`.execute(trx);
        await sql`update observation set period = null where observation_id = ${observation.observationId!}`
          .execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23502", column: "period" });
  });

  // The month is the UTC month, and this is the only fixture that can tell.
  // Every other test ingests mid-month, where the session's zone and UTC
  // agree; at 23:30 on the last day of September they do not, and a check
  // written `date_trunc('month', ingested_at)` -- which truncates in the
  // SESSION's zone and is only stable -- says October. The cluster this runs
  // on sits at UTC+3, so the wrong form is wrong right here, and no test saw
  // it until this one.
  it("files the last half-hour of a month under that month, not the next one", async () => {
    const boundary = fixedClock(new Date("2026-09-30T23:30:00.000Z"));
    const ns = new NamespaceRepository(db, ring, boundary, RETENTION_V0);
    const repo = new ObservationRepository(db, ns, boundary, RETENTION_V0);
    const observation = storedObservation(await repo.append(
      anEvent({ source: { ...src, ref: "op:period:boundary" } }),
    ));
    const row = await sql<{ period: string }>`
      select to_char(period, 'YYYY-MM-DD') as period from observation
      where observation_id = ${observation.observationId!}`.execute(db);
    expect(row.rows[0]?.period).toBe("2026-09-01");
    expect(await repo.get(observation.observationId!)).toBeDefined();

    // The other side of the same boundary, and it is not redundant: 23:30 on
    // 30 September is still September WEST of Greenwich, so the first half
    // kills a session-zone check only on a cluster east of UTC -- which this
    // one is, but that is a property of the machine and not of the test.
    // 00:30 on 1 October is still September west of Greenwich and October
    // east of it, so the pair refuses the wrong form in either direction.
    const after = fixedClock(new Date("2026-10-01T00:30:00.000Z"));
    const ns2 = new NamespaceRepository(db, ring, after, RETENTION_V0);
    const repo2 = new ObservationRepository(db, ns2, after, RETENTION_V0);
    const october = await repo2.append(
      anEvent({ source: { ...src, ref: "op:period:boundary2" } }),
    );
    const row2 = await sql<{ period: string }>`
      select to_char(period, 'YYYY-MM-DD') as period from observation
      where observation_id = ${storedObservation(october).observationId!}`.execute(db);
    expect(row2.rows[0]?.period).toBe("2026-10-01");
  });

  // R1, as the only test that can see it: the period is the month of INGEST,
  // not of the event. Every other fixture is dated and ingested in the same
  // month, so a function reading the wrong instant agrees with itself. This
  // one is a backfill -- an August event loaded in September -- and under the
  // event's month it would be born expired, which is the thing R1 refuses.
  it("keys a backfill on the month it was loaded in, not the month it happened", async () => {
    const observation = storedObservation(await observations.append(anEvent({
      source: { ...src, ref: "op:period:backfill" },
      observedAt: "2026-08-20T09:00:00.000Z",
    })));
    const row = await sql<{ period: string; dated: string }>`
      select to_char(period, 'YYYY-MM-DD') as period,
             to_char(dated_at, 'YYYY-MM-DD') as dated
      from observation where observation_id = ${observation.observationId!}`.execute(db);
    expect(row.rows[0]?.dated).toBe("2026-08-20");
    expect(row.rows[0]?.period).toBe("2026-09-01");
  });

  // Two behaviours this commit does NOT fix, pinned so that Task 8 changes
  // them deliberately rather than discovering them. Both were measured by
  // review; a gap with a test is owed work, a gap without one is a surprise.

  // F8, the month version. The indexer's normal retry path re-delivers an
  // observation and expects `created: false`; once the month has expired the
  // pre-read opens the payload and throws instead. Task 8 replaces the
  // pre-read with a skeleton read and gives AppendResult a third shape; when
  // it does, this test inverts.
  it("answers a re-delivery whose month expired, and leaves the row untouched", async () => {
    const ns = (await namespaces.ensure({ kind: "wallet", id: "REDELIVER" })).namespaceId;
    const wire = anEvent({
      source: { ...src, ref: "op:redeliver:1" }, namespace: { kind: "wallet", id: "REDELIVER" },
    });
    const observation = storedObservation(await observations.append(wire));
    const before = await sql<{ x: string }>`
      select xmin::text as x from observation where observation_id = ${observation.observationId!}`
      .execute(db);
    const row = await db.selectFrom("namespace_key").select(["expires_at"])
      .where("namespace_id", "=", ns).executeTakeFirstOrThrow();
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${row.expires_at}
      where namespace_id = ${ns}`.execute(db);

    // Task 8 changed this deliberately, and this test's old name said so: it
    // asserted that this re-delivery THROWS PayloadExpired. R19 makes it
    // answer, because that throw sat in the indexer's retry path and wedged
    // it for the counterparty. What the test was really carrying is the
    // second half below -- the row is not re-sealed and not touched -- and
    // that is kept. Not redundant with the R19 block at the end of this file:
    // this runs under the shipped ninety-day policy, that one under seven.
    const answer = await observations.append(wire);
    expect(answer).toMatchObject({
      created: false, readable: false,
      observationId: observation.observationId!,
      periodExpired: true, namespaceErased: false,
    });
    const after = await sql<{ x: string }>`
      select xmin::text as x from observation where observation_id = ${observation.observationId!}`
      .execute(db);
    expect(after.rows[0]?.x).toBe(before.rows[0]?.x);
  });

  // The claim "a new observation can never land in an expired month" was
  // written in three places on this branch and is false. With a zero grace --
  // which assertRetentionPolicy admits as a policy -- a month expires at its
  // own close, so a sweep at 00:00 on the first shreds the month an append
  // captured its instant in moments before, and the observation is dropped at
  // write time. Under the shipped ninety days the window needs a clock skew
  // of ninety days and is unreachable outside a simulated clock.
  it("drops a write whose month expired under it, which the comments used to deny", async () => {
    const eager = { ...RETENTION_V0, graceDays: 0 };
    const at = fixedClock(new Date("2026-09-30T23:59:59.999Z"));
    const ns = new NamespaceRepository(db, ring, at, eager);
    const repo = new ObservationRepository(db, ns, at, eager);
    const id = (await ns.ensure({ kind: "wallet", id: "WRITERACE" })).namespaceId;
    await repo.append(anEvent({
      source: { ...src, ref: "op:writerace:a" }, namespace: { kind: "wallet", id: "WRITERACE" },
    }));
    // The sweep Task 7 will write, at the instant the month closes.
    await sql`update namespace_key set key_wrapped = null,
        shredded_at = ${new Date("2026-10-01T00:00:00.000Z")}
      where namespace_id = ${id} and key_wrapped is not null
        and expires_at <= ${new Date("2026-10-01T00:00:00.000Z")}`.execute(db);
    await expect(repo.append(anEvent({
      source: { ...src, ref: "op:writerace:b" }, namespace: { kind: "wallet", id: "WRITERACE" },
    }))).rejects.toBeInstanceOf(PayloadExpired);
    const n = await sql<{ n: number }>`
      select count(*)::int as n from observation where namespace_id = ${id}`.execute(db);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("holds exactly the columns the design enumerates, so an added column of any name is a decision", async () => {
    const rows = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_name = 'observation' and table_schema = current_schema()`.execute(db);
    // `producer` was argued in by the storage card: the read path rebuilds
    // the payload envelope from the row alone and the envelope binds it, and
    // the per-producer cap counts rows by it. `period` because retention is
    // keyed on (namespace, calendar month) and the month must be on the row
    // for the foreign key to hold "no payload without a key row".
    expect(rows.rows.map((r) => r.column_name).sort()).toEqual([
      "channel", "dated_at", "evidence_kind", "idempotency_key", "ingested_at",
      "kind", "namespace_id", "observation_id", "payload_ciphertext",
      "payload_nonce", "payload_tag", "period", "producer",
    ]);
  });

  // For the per-producer cap in the next task: it counts
  // `where producer = ? and ingested_at > ?`, which without this index is a
  // sequential scan of the whole table on every append.
  it("indexes the producer and its ingest time, for the cap that will count by them", async () => {
    const rows = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes
      where tablename = 'observation' and schemaname = current_schema()
        and indexname = 'observation_by_producer_ingested'`.execute(db);
    // On the column list, not on the definition text: the index is NAMED
    // observation_by_producer_ingested, so /producer/ matched the name and an
    // index on (ingested_at desc) alone passed.
    expect(rows.rows[0]?.indexdef).toMatch(/\(producer, ingested_at DESC\)/i);
  });
});

// Task 8, R19. What `append` answers when the row is already there and its
// payload cannot be opened.
//
// Before this, the pre-read was `byIdempotencyKey`, which OPENS the payload,
// so a re-delivery for an erased namespace raised NamespaceShredded out of
// the retry path itself and the indexer's normal retry errored forever for
// that counterparty. The pre-read is now a skeleton: identity and state, no
// decrypt.
//
// The shape carries two booleans and not a reason, and that is R18's lesson
// applied one task later rather than relearned. A namespace erased on request
// can also hold a month past its grace; a union would have to pick one, and
// whichever it picked, the other would vanish from any count built on it.
// The last test here is the one a union cannot pass.
describe("a re-delivery whose payload cannot be opened", () => {
  const grace7 = { ...RETENTION_V0, graceDays: 7 };

  /** Repositories on one policy object at one instant (§2d, R16). */
  function at(iso: string) {
    const c = fixedClock(new Date(iso));
    const ns = new NamespaceRepository(db, ring, c, grace7);
    return { ns, obs: new ObservationRepository(db, ns, c, grace7) };
  }

  /** Expire a month by hand, at an instant the shred guard admits. */
  async function expireMonth(namespaceId: string, period: string, at: string) {
    await sql`update namespace_key set key_wrapped = null, shredded_at = ${new Date(at)}
      where namespace_id = ${namespaceId} and period = ${period}::date`.execute(db);
  }

  async function xminOf(observationId: string): Promise<string> {
    const r = await sql<{ x: string }>`
      select xmin::text as x from observation where observation_id = ${observationId}`
      .execute(db);
    return r.rows[0]!.x;
  }

  it("answers a live re-delivery with the observation, as it always has", async () => {
    const live = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19LIVE" },
      source: { ...src, ref: "op:r19:live" } });
    const first = await live.obs.append(wire);
    expect(first.created).toBe(true);
    const again = await live.obs.append(wire);
    expect(again).toMatchObject({ created: false, readable: true });
    if (again.created === false && again.readable) {
      expect(storedObservation(again).observationId).toBe(storedObservation(first).observationId);
    }
  });

  it("answers an expired month instead of throwing, and touches nothing", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19EXPIRED" },
      source: { ...src, ref: "op:r19:expired" } });
    const first = await mar.obs.append(wire);
    const id = storedObservation(first).observationId!;
    const nsId = (await mar.ns.find("wallet", "R19EXPIRED"))!.namespaceId;
    const beforeX = await xminOf(id);
    // 2027-03 expires 2027-04-08 under grace 7.
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");

    const again = await at("2027-05-01T00:00:00.000Z").obs.append(wire);
    expect(again).toEqual({
      created: false, readable: false, observationId: id,
      ingestedAt: new Date("2027-03-05T00:00:00.000Z"),
      periodExpired: true, namespaceErased: false,
    });
    // Never re-sealed and never touched: a re-delivery that rewrote the row
    // would be a producer resurrecting a payload retention had removed,
    // which makes retention a fiction.
    expect(await xminOf(id)).toBe(beforeX);
  });

  it("answers an erased namespace instead of wedging the indexer's retry", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19ERASED" },
      source: { ...src, ref: "op:r19:erased" } });
    const first = await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19ERASED"))!.namespaceId;
    await at("2027-03-10T00:00:00.000Z").ns.shred(nsId);

    const again = await at("2027-03-11T00:00:00.000Z").obs.append(wire);
    expect(again).toEqual({
      created: false, readable: false,
      observationId: storedObservation(first).observationId!,
      ingestedAt: new Date("2027-03-05T00:00:00.000Z"),
      periodExpired: false, namespaceErased: true,
    });
  });

  // The test a `reason` union cannot pass, whichever branch it picked.
  it("reports both when the namespace is erased AND the month has expired", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19BOTH" },
      source: { ...src, ref: "op:r19:both" } });
    await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19BOTH"))!.namespaceId;
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");
    await at("2027-04-20T00:00:00.000Z").ns.shred(nsId);

    const again = await at("2027-05-01T00:00:00.000Z").obs.append(wire);
    expect(again).toMatchObject({
      created: false, readable: false,
      periodExpired: true, namespaceErased: true,
    });
  });

  // The adjacent case R19 records and does NOT change: a re-delivery is a
  // retry of something already stored, a NEW observation would be resuming
  // collection on a counterparty who asked to be erased. The idempotency key
  // is what tells them apart, which is what the pre-read is for.
  // R19's owed GATE. The refusal above holds only when the shred commits
  // BEFORE the append reads the key: nothing spans `openPeriodKey` and the
  // insert, so a shred landing in between let a new observation be stored
  // with `ingested_at` later than `namespace.key_shredded_at`. Review
  // reproduced it, and what it refutes is the M1 ledger's own sentence, "a
  // shredded counterparty can never be observed again". A documented
  // refusal with no mechanism is what this repository keeps finding to be
  // false, so the mechanism is a trigger and these two tests are it.
  it("refuses a raw INSERT for an erased namespace, by SQLSTATE and message", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    await mar.obs.append(anEvent({ namespace: { kind: "wallet", id: "GATERAW" },
      source: { ...src, ref: "op:gate:raw" } }));
    const nsId = (await mar.ns.find("wallet", "GATERAW"))!.namespaceId;
    await at("2027-03-10T00:00:00.000Z").ns.shred(nsId);

    const planted = sql`
      insert into observation (
        observation_id, idempotency_key, namespace_id, channel, kind, evidence_kind,
        dated_at, ingested_at, producer, period, payload_nonce, payload_tag, payload_ciphertext
      ) values (
        ${randomUUID()}, ${randomUUID()}, ${nsId}, 'protocol', 'raw', 'state',
        null, ${new Date("2027-03-11T00:00:00.000Z")}, 'raw-writer', '2027-03-01'::date,
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex')
      )`.execute(db).then(() => null, (e: unknown) => e);
    const failure = await planted;
    expect(failure).not.toBeNull();
    expect(mapPgError(failure)).toBeInstanceOf(NamespaceShredded);
    await expect(Promise.reject(mapPgError(failure)))
      .rejects.toThrow(/erased on request/);
  });

  it("refuses a NEW observation when the erasure lands between the key and the insert", async () => {
    // The window itself. `openPeriodKey` returns a live key, a real shred
    // commits, and the insert follows. Before the gate this stored a row
    // dated after the erasure; the row's own foreign key is satisfied by a
    // shredded namespace, so nothing else was going to stop it.
    const mar = at("2027-03-05T00:00:00.000Z");
    await mar.obs.append(anEvent({ namespace: { kind: "wallet", id: "GATERACE" },
      source: { ...src, ref: "op:gate:race1" } }));
    const nsId = (await mar.ns.find("wallet", "GATERACE"))!.namespaceId;

    const racing = at("2027-03-11T00:00:00.000Z");
    const priv = racing.ns as unknown as { openPeriodKey: (n: string, p: string) => Promise<Buffer> };
    const real = priv.openPeriodKey.bind(racing.ns);
    let once = true;
    priv.openPeriodKey = async (n: string, p: string) => {
      const key = await real(n, p);
      if (once) { once = false; await racing.ns.shred(nsId); }
      return key;
    };
    await expect(racing.obs.append(anEvent({
      namespace: { kind: "wallet", id: "GATERACE" },
      source: { ...src, ref: "op:gate:race2" },
    }))).rejects.toBeInstanceOf(NamespaceShredded);

    // And nothing was written: the erasure request's instant stays the last
    // word on this counterparty.
    const rows = await sql<{ n: string }>`
      select count(*)::text as n from observation o
      join namespace n on n.namespace_id = o.namespace_id
      where o.namespace_id = ${nsId} and o.ingested_at > n.key_shredded_at`.execute(db);
    expect(rows.rows[0]!.n).toBe("0");
  });

  // `for share` in the trigger, which mutation showed nothing held: removing
  // it left the suite green, because both gate tests above have the shred
  // committed BEFORE the insert statement begins. This one has it commit
  // while the statement runs, which is the narrower window the lock exists
  // for, and it is deterministic rather than timed: the erasing connection
  // takes the row lock FIRST, so the insert must queue behind it.
  //
  // Without the lock the trigger reads the statement's own snapshot, does
  // not see an erasure that has not committed yet, and admits the row --
  // and the erasure then commits on top of it.
  it("queues behind an erasure already in flight, and sees it when it lands", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    await mar.obs.append(anEvent({ namespace: { kind: "wallet", id: "GATEINFLIGHT" },
      source: { ...src, ref: "op:gate:inflight1" } }));
    const nsId = (await mar.ns.find("wallet", "GATEINFLIGHT"))!.namespaceId;
    // The month key has to exist before the race, or the append would mint
    // one and the ordering under test would be a different one.
    await at("2027-03-11T00:00:00.000Z").ns.periodKey(nsId, "2027-03-01");

    const other = openDb(urlForSchema(requireTestUrl(), "obs_test"));
    try {
      // Two handshakes, because a fixed sleep made this flaky and a flaky
      // test is worse than none: it failed once under a loaded run, and not
      // for its own reason -- the append simply started before the erasing
      // transaction had taken its lock, so nothing ever queued and the
      // property under test was not exercised at all.
      let lockHeld!: () => void;
      const holding = new Promise<void>((r) => { lockHeld = r; });
      let commitNow!: () => void;
      const release = new Promise<void>((r) => { commitNow = r; });

      const erasing = other.transaction().execute(async (trx) => {
        await sql`select namespace_id from namespace
                  where namespace_id = ${nsId} for update`.execute(trx);
        lockHeld();
        await release;
        await sql`update namespace set data_key_wrapped = null,
                    key_shredded_at = ${new Date("2027-03-11T00:00:00.000Z")}
                  where namespace_id = ${nsId}`.execute(trx);
      });

      // Only launch the append once the row is genuinely locked.
      await holding;
      const appending = at("2027-03-12T00:00:00.000Z").obs.append(anEvent({
        namespace: { kind: "wallet", id: "GATEINFLIGHT" },
        source: { ...src, ref: "op:gate:inflight2" },
      }));

      // And wait for it to be BLOCKED rather than for a number of
      // milliseconds. Scoped to this database: pg_locks and pg_stat_activity
      // are cluster-wide, and a sibling suite on another database would
      // otherwise satisfy this poll.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const waiting = await sql<{ n: string }>`
          select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query ilike '%insert into%observation%'`.execute(db);
        blocked = waiting.rows[0]!.n !== "0";
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      // Non-vacuous: if the insert never queued, the rest proves nothing.
      expect(blocked, "the insert never blocked, so nothing was serialised").toBe(true);

      commitNow();
      await erasing;

      await expect(appending).rejects.toBeInstanceOf(NamespaceShredded);
      const rows = await sql<{ n: string }>`
        select count(*)::text as n from observation o
        join namespace n on n.namespace_id = o.namespace_id
        where o.namespace_id = ${nsId} and o.ingested_at > n.key_shredded_at`.execute(db);
      expect(rows.rows[0]!.n).toBe("0");
    } finally {
      await other.destroy();
    }
  });

  it("still refuses a NEW observation for an erased namespace", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    await mar.obs.append(anEvent({ namespace: { kind: "wallet", id: "R19NEW" },
      source: { ...src, ref: "op:r19:new1" } }));
    const nsId = (await mar.ns.find("wallet", "R19NEW"))!.namespaceId;
    await at("2027-03-10T00:00:00.000Z").ns.shred(nsId);

    await expect(at("2027-03-11T00:00:00.000Z").obs.append(
      anEvent({ namespace: { kind: "wallet", id: "R19NEW" },
        source: { ...src, ref: "op:r19:new2" } }),
    )).rejects.toBeInstanceOf(NamespaceShredded);
  });

  // Five rules below were each a surviving mutant in this task's first
  // mutation round: the constructor's policy assertion, the mid-read race,
  // the null-read invariant, the period half of the skeleton's join, and the
  // duplicate-retry path's use of the skeleton. Every one passed all 376
  // tests before these were written.

  it("refuses a malformed policy in its own constructor, by field name", async () => {
    // R16's sibling. Without this the required parameter is indistinguishable
    // from a decorative one: deleting assertRetentionPolicy(policy) from the
    // constructor left the whole suite green.
    const { ns } = at("2027-03-05T00:00:00.000Z");
    expect(() => new ObservationRepository(
      db, ns, fixedClock(new Date()), { ...RETENTION_V0, producerMaxObservations: 0 },
    )).toThrow(/producerMaxObservations/);
    expect(() => new ObservationRepository(
      db, ns, fixedClock(new Date()), { ...RETENTION_V0, producerWindowMs: -1 },
    )).toThrow(/producerWindowMs/);
  });

  it("answers from a fresh read when the month is shredded mid-answer", async () => {
    // The skeleton says readable, and an erasure commits before the payload
    // is opened. Letting that throw is the original R19 defect back inside a
    // narrower window, so the refusal is caught and the state re-read. The
    // shred here is real and happens between the two reads, not stubbed.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19RACE" },
      source: { ...src, ref: "op:r19:race" } });
    await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19RACE"))!.namespaceId;

    const racing = at("2027-03-06T00:00:00.000Z");
    const priv = racing.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    const real = priv.byIdempotencyKey.bind(racing.obs);
    let once = true;
    priv.byIdempotencyKey = async (k: string) => {
      if (once) { once = false; await racing.ns.shred(nsId); }
      return real(k);
    };
    const answer = await racing.obs.append(wire);
    expect(answer).toMatchObject({
      created: false, readable: false, namespaceErased: true, periodExpired: false,
    });
  });

  it("refuses to call a row unreadable when nothing is wrong with it", async () => {
    // A read that comes back NULL is not a race: the table is append-only and
    // the skeleton just saw the row. Answering `readable: false` with both
    // flags false would report a row as unreadable while saying nothing ails
    // it, which is a lie no caller could act on.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19NULL" },
      source: { ...src, ref: "op:r19:null" } });
    await mar.obs.append(wire);
    const blind = at("2027-03-06T00:00:00.000Z");
    const priv = blind.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    priv.byIdempotencyKey = async () => null;
    await expect(blind.obs.append(wire)).rejects.toBeInstanceOf(ObservationNotFound);
    await expect(blind.obs.append(wire)).rejects.toThrow(/append-only/);
  });

  it("reads the key row of the observation's OWN month, not any month it has", async () => {
    // The skeleton joins namespace_key on (namespace_id, period). Dropping
    // the period half leaves one row per MONTH the namespace holds, and the
    // answer then depends on which one the planner hands back first. Two
    // months, the older expired and the newer live: a re-delivery from the
    // newer must still be readable.
    const mar = at("2027-03-05T00:00:00.000Z");
    const old = anEvent({ namespace: { kind: "wallet", id: "R19TWOMONTH" },
      source: { ...src, ref: "op:r19:2m:old" } });
    await mar.obs.append(old);
    const apr = at("2027-04-05T00:00:00.000Z");
    const recent = anEvent({ namespace: { kind: "wallet", id: "R19TWOMONTH" },
      source: { ...src, ref: "op:r19:2m:new" } });
    await apr.obs.append(recent);
    const nsId = (await mar.ns.find("wallet", "R19TWOMONTH"))!.namespaceId;
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");

    const now = at("2027-04-20T00:00:00.000Z");
    expect(await now.obs.append(recent)).toMatchObject({ created: false, readable: true });
    expect(await now.obs.append(old)).toMatchObject({
      created: false, readable: false, periodExpired: true,
    });
  });

  it("answers rather than throws when the writer that won the race left an unreadable row", async () => {
    // The duplicate-retry path goes through the skeleton for the same reason
    // the pre-read does. Reached by blinding the skeleton once, so this
    // append inserts, collides, and re-reads -- with the stored row already
    // expired. Through byIdempotencyKey that re-read throws, which is the
    // R19 defect surviving in the one path R19 did not name.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19DUP" },
      source: { ...src, ref: "op:r19:dup" } });
    const first = await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19DUP"))!.namespaceId;
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");

    const loser = at("2027-05-01T00:00:00.000Z");
    const priv = loser.obs as unknown as { skeleton: (k: string) => Promise<unknown> };
    const real = priv.skeleton.bind(loser.obs);
    let blind = true;
    priv.skeleton = async (k: string) => {
      if (blind) { blind = false; return null; }
      return real(k);
    };
    expect(await loser.obs.append(wire)).toMatchObject({
      created: false, readable: false, periodExpired: true,
      observationId: storedObservation(first).observationId!,
    });
  });

  // The skeleton read's whole point: it must not decrypt. If it still opened
  // the payload, every assertion above would have thrown instead of
  // answering -- but this states it directly, so a future pre-read that
  // decrypts "just to check" fails here rather than three tests away.
  it("never opens the payload when the skeleton already says it is unreadable", async () => {
    // The test below asserts the OUTCOME and review showed that is not the
    // same rule: deleting the early return in `answerStored`, so every
    // unreadable re-delivery goes through the open and is rescued by the
    // mid-answer catch, left all 381 tests green. Observable behaviour is
    // identical and the design property -- the pre-read decides without
    // decrypting -- was enforced by nothing. So this one counts the calls.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19SPY" },
      source: { ...src, ref: "op:r19:spy" } });
    await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19SPY"))!.namespaceId;
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");

    const after = at("2027-05-01T00:00:00.000Z");
    const priv = after.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    const real = priv.byIdempotencyKey.bind(after.obs);
    let opens = 0;
    priv.byIdempotencyKey = async (k: string) => { opens += 1; return real(k); };
    expect(await after.obs.append(wire)).toMatchObject({ readable: false, periodExpired: true });
    expect(opens, "the pre-read decrypted a payload it had already ruled unreadable").toBe(0);
  });

  it("catches a month EXPIRING mid-answer, not only a namespace erasure", async () => {
    // The catch's instanceof list has two arms and only one was held: review
    // narrowed it to NamespaceShredded alone and all 381 tests stayed green,
    // so the expiry half of the mid-answer race was the original R19 defect
    // still sitting in a narrow window. The test that looked like it covered
    // this shreds the NAMESPACE despite its name; this one expires the MONTH.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19MONTHRACE" },
      source: { ...src, ref: "op:r19:monthrace" } });
    await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19MONTHRACE"))!.namespaceId;

    const racing = at("2027-05-01T00:00:00.000Z");
    const priv = racing.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    const real = priv.byIdempotencyKey.bind(racing.obs);
    let once = true;
    priv.byIdempotencyKey = async (k: string) => {
      // A real expiry, committed between the skeleton and the open.
      if (once) { once = false; await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z"); }
      return real(k);
    };
    expect(await racing.obs.append(wire)).toMatchObject({
      created: false, readable: false, periodExpired: true, namespaceErased: false,
    });
  });

  it("lets a tamper out of the retry path instead of calling it unreadable", async () => {
    // The other side of the same list. A catch that swallowed everything
    // passed all 381 tests while answering `readable: false` with both flags
    // clear for a REWRITTEN row -- reporting a tamper as retention, which is
    // the one thing the audit chain exists to keep apart. A corrupted or
    // re-keyed payload wedges the indexer's retry forever, and that is a
    // decision rather than an oversight: a tamper must be loud.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19TAMPER" },
      source: { ...src, ref: "op:r19:tamper" } });
    await mar.obs.append(wire);
    const later = at("2027-03-06T00:00:00.000Z");
    const priv = later.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    priv.byIdempotencyKey = async () => {
      throw new CiphertextRejected("the payload did not authenticate");
    };
    await expect(later.obs.append(wire)).rejects.toBeInstanceOf(CiphertextRejected);
  });

  it("still reports a tamper when a sweep lands on top of it", async () => {
    // The instanceof list and the both-flags-clear rethrow cover the same
    // ground everywhere except here, which is why a catch that swallowed
    // everything survived until this test existed: a genuine tamper, with a
    // real expiry committing on the same row before the state is re-read.
    // Swallowed, the answer is `readable: false, periodExpired: true` and the
    // tamper is reported as retention -- the one confusion the audit chain
    // exists to prevent. The list is what keeps it loud.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19TAMPERSWEEP" },
      source: { ...src, ref: "op:r19:tampersweep" } });
    await mar.obs.append(wire);
    const nsId = (await mar.ns.find("wallet", "R19TAMPERSWEEP"))!.namespaceId;

    const later = at("2027-05-01T00:00:00.000Z");
    const priv = later.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    priv.byIdempotencyKey = async () => {
      // The month expires while the payload is being opened, so the re-read
      // WILL show a flag set and a swallowing catch has somewhere to hide.
      await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");
      throw new CiphertextRejected("the payload did not authenticate");
    };
    await expect(later.obs.append(wire)).rejects.toBeInstanceOf(CiphertextRejected);
  });

  it("gives a created result exactly two keys, and no readable flag", async () => {
    // The union's discriminant is `created` first and `readable` second, and
    // a JavaScript caller that reached for `readable` on a created result
    // would read undefined and treat it as unreadable. Nothing pinned the
    // created shape's key set: a mutant that added `readable: false` to it
    // passed the whole suite.
    const fresh = at("2027-06-05T00:00:00.000Z");
    const r = await fresh.obs.append(anEvent({
      namespace: { kind: "wallet", id: "R19KEYS" }, source: { ...src, ref: "op:r19:keys" },
    }));
    expect(Object.keys(r).sort()).toEqual(["created", "observation"]);
  });

  it("raises the refusal it caught rather than calling a healthy row unreadable", async () => {
    // F4. The catch re-reads the state, and until review measured it the
    // re-read could come back clean -- leaving `readable: false` with both
    // flags clear, which is a row reported unreadable while the answer says
    // nothing ails it. `answerStored`'s own docstring refuses that shape and
    // enforced the refusal on one branch of two. Reachable on a real
    // database when the §2c same-row restore lands between the failed read
    // and the re-read; reached here by making the open throw with no state
    // change at all, which is the same shape and cheaper to write.
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19LIAR" },
      source: { ...src, ref: "op:r19:liar" } });
    await mar.obs.append(wire);

    const lying = at("2027-03-06T00:00:00.000Z");
    const priv = lying.obs as unknown as { byIdempotencyKey: (k: string) => Promise<unknown> };
    priv.byIdempotencyKey = async () => {
      throw new NamespaceShredded("a refusal with no state behind it");
    };
    await expect(lying.obs.append(wire)).rejects.toBeInstanceOf(NamespaceShredded);
    await expect(lying.obs.append(wire)).rejects.toThrow(/no state behind it/);
  });

  it("does not open the payload to decide, so an unreadable row still answers", async () => {
    const mar = at("2027-03-05T00:00:00.000Z");
    const wire = anEvent({ namespace: { kind: "wallet", id: "R19NODECRYPT" },
      source: { ...src, ref: "op:r19:nodecrypt" } });
    const first = await mar.obs.append(wire);
    const id = storedObservation(first).observationId!;
    const nsId = (await mar.ns.find("wallet", "R19NODECRYPT"))!.namespaceId;
    await expireMonth(nsId, "2027-03-01", "2027-04-08T00:00:00.000Z");
    // The ciphertext is now unopenable by anyone. `get` says so; `append`
    // answers anyway.
    await expect(at("2027-05-01T00:00:00.000Z").obs.get(id))
      .rejects.toBeInstanceOf(PayloadExpired);
    const again = await at("2027-05-01T00:00:00.000Z").obs.append(wire);
    expect(again.created).toBe(false);
  });
});


// Task 8b, G12's first half. The producer cap.
//
// R3 says plainly what this is NOT: a defence against an attacker. The
// producer name is free text until signatures are enforced, so anyone who
// wanted around it would rotate names. Its real job is catching our own
// indexer in a loop, which is why too LOW is the dangerous direction -- it
// refuses a legitimate delivery and becomes the denial of service on
// ourselves that §6 exists to prevent.
//
// Every number here is overridden and none of them collides with another
// field of the policy, which is the habit the M2 ledger asks for: under the
// shipped values (90, 86_400_000, 10_000_000) a cap read from the wrong
// field would agree with itself.
describe("the producer cap", () => {
  const CAP = 3;
  const WINDOW = 1_000;
  const capped = { ...RETENTION_V0, producerMaxObservations: CAP, producerWindowMs: WINDOW };

  function at(iso: string, policy = capped) {
    const c = fixedClock(new Date(iso));
    const ns = new NamespaceRepository(db, ring, c, policy);
    return { ns, obs: new ObservationRepository(db, ns, c, policy) };
  }

  const from = (producer: string, ref: string, wallet = "CAPWALLET") => anEvent({
    namespace: { kind: "wallet", id: wallet },
    source: { ...src, producer, ref },
  });

  async function storedFor(producer: string): Promise<number> {
    const r = await sql<{ n: string }>`
      select count(*)::text as n from observation where producer = ${producer}`.execute(db);
    return Number(r.rows[0]!.n);
  }

  it("admits the cap and refuses the one after it, writing nothing", async () => {
    const t = at("2028-01-05T00:00:00.000Z");
    for (let i = 0; i < CAP; i++) {
      expect((await t.obs.append(from("cap-exact", `op:cap:${i}`))).created).toBe(true);
    }
    expect(await storedFor("cap-exact")).toBe(CAP);
    await expect(t.obs.append(from("cap-exact", "op:cap:over")))
      .rejects.toBeInstanceOf(SourceRateExceeded);
    // Refused means refused: the row is not written and the next window does
    // not inherit it.
    expect(await storedFor("cap-exact")).toBe(CAP);
  });

  it("names the producer, the window and the count in the refusal", async () => {
    // A class-only assertion passes when a later guard throws the same class
    // for a different reason, which is how two tests on this branch were
    // hollow. The refusal has to say what an operator must act on: whose
    // cap, over what window, and how many.
    const t = at("2028-02-05T00:00:00.000Z");
    for (let i = 0; i < CAP; i++) await t.obs.append(from("cap-message", `op:msg:${i}`));
    const refused = t.obs.append(from("cap-message", "op:msg:over"));
    await expect(refused).rejects.toThrow(/cap-message/);
    await expect(refused).rejects.toThrow(new RegExp(String(WINDOW)));
    await expect(refused).rejects.toThrow(new RegExp(`\\b${CAP}\\b`));
  });

  it("leaves another producer alone, because the cap is per producer", async () => {
    const t = at("2028-03-05T00:00:00.000Z");
    for (let i = 0; i < CAP; i++) await t.obs.append(from("cap-noisy", `op:noisy:${i}`));
    await expect(t.obs.append(from("cap-noisy", "op:noisy:over")))
      .rejects.toBeInstanceOf(SourceRateExceeded);
    // A second producer at the same instant is unaffected.
    expect((await t.obs.append(from("cap-quiet", "op:quiet:1"))).created).toBe(true);
  });

  it("admits one more once the window has passed", async () => {
    const t0 = at("2028-04-05T00:00:00.000Z");
    for (let i = 0; i < CAP; i++) await t0.obs.append(from("cap-window", `op:win:${i}`));
    await expect(t0.obs.append(from("cap-window", "op:win:over")))
      .rejects.toBeInstanceOf(SourceRateExceeded);
    // The window is a SLIDING one on ingest time, so two seconds later the
    // three above have left it. A cap counted over all history would still
    // refuse here.
    const t1 = at("2028-04-05T00:00:02.000Z");
    expect((await t1.obs.append(from("cap-window", "op:win:after"))).created).toBe(true);
  });

  it("does not charge a re-delivery against the cap", async () => {
    // The pre-read is OUTSIDE the lock and outside the count, so the
    // indexer's normal retry never consumes a slot. Charged, a producer at
    // its cap could not retry anything, which is the denial of service on
    // ourselves R3 warns about, arriving through the retry path.
    const t = at("2028-05-05T00:00:00.000Z");
    const first = from("cap-retry", "op:retry:1");
    await t.obs.append(first);
    for (let i = 1; i < CAP; i++) await t.obs.append(from("cap-retry", `op:retry:${i + 1}`));
    expect(await storedFor("cap-retry")).toBe(CAP);
    // At the cap. A fresh one is refused; the re-delivery is not.
    await expect(t.obs.append(from("cap-retry", "op:retry:fresh")))
      .rejects.toBeInstanceOf(SourceRateExceeded);
    expect(await t.obs.append(first)).toMatchObject({ created: false, readable: true });
  });

  it("measures the window in milliseconds, not in whichever number is to hand", async () => {
    // Every other test here appends at ONE fixed instant, so the window's
    // LENGTH never bites: `ingested_at > now - w` admits a row stamped `now`
    // for any positive w. Reading the window from `producerMaxObservations`
    // instead of `producerWindowMs` therefore passed the whole suite --
    // measured, and it is the policy-override habit's own failure mode, one
    // level up: the fields differ, but the fixture never asked them to.
    //
    // Cap one, window one second, two appends half a second apart. Under the
    // window that is declared, the second sees the first. Under a window of
    // one millisecond -- which is what the cap's own value would give -- it
    // does not.
    const narrow = { ...RETENTION_V0, producerMaxObservations: 1, producerWindowMs: 1_000 };
    const t0 = at("2028-07-05T00:00:00.000Z", narrow);
    expect((await t0.obs.append(from("cap-msunit", "op:ms:1"))).created).toBe(true);
    const t1 = at("2028-07-05T00:00:00.500Z", narrow);
    await expect(t1.obs.append(from("cap-msunit", "op:ms:2")))
      .rejects.toBeInstanceOf(SourceRateExceeded);
    // And just past the second, it is admitted again.
    const t2 = at("2028-07-05T00:00:01.100Z", narrow);
    expect((await t2.obs.append(from("cap-msunit", "op:ms:3"))).created).toBe(true);
  });

  it("locks per producer, so a busy producer never queues a quiet one", async () => {
    // The lock's KEY, which nothing held: `pg_advisory_xact_lock(1)` -- one
    // lock for the whole store -- passed every test above, because none of
    // them has two producers in flight at once. A global lock is not a wrong
    // answer, it is every append in the system queueing behind every other,
    // which is the kind of defect that is invisible until it is the only
    // thing anyone can see.
    //
    // Deterministic rather than timed: another connection holds advisory
    // lock 1, the number the mutant would take. Under the shipped key the
    // append takes hashtext(producer), does not meet it, and finishes. Under
    // the mutant it waits for a lock this test never releases, and the test
    // fails by timing out rather than by being slow.
    const other = openDb(urlForSchema(requireTestUrl(), "obs_test"));
    try {
      let unlock!: () => void;
      const held = new Promise<void>((r) => { unlock = r; });
      let taken!: () => void;
      const ready = new Promise<void>((r) => { taken = r; });
      const holder = other.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(1)`.execute(trx);
        taken();
        await held;
      });
      await ready;
      const t = at("2028-08-05T00:00:00.000Z");
      expect((await t.obs.append(from("cap-unblocked", "op:unblocked:1"))).created).toBe(true);
      unlock();
      await holder;
    } finally {
      await other.destroy();
    }
  }, 10_000);

  it("stores exactly the cap under twenty concurrent appends", async () => {
    // The only test that sees a missing lock. Count-then-insert without one
    // admits the pool's width over the cap -- measured as "a cap that is not
    // a cap" in the plan's risk list -- and every sequential test above
    // passes without it.
    const fives = { ...RETENTION_V0, producerMaxObservations: 5, producerWindowMs: 60_000 };
    const t = at("2028-06-05T00:00:00.000Z", fives);
    const attempts = Array.from({ length: 20 }, (_, i) =>
      t.obs.append(from("cap-concurrent", `op:conc:${i}`)).then(
        () => "created" as const,
        (e: unknown) => (e instanceof SourceRateExceeded ? "refused" as const : Promise.reject(e)),
      ));
    const outcomes = await Promise.all(attempts);
    expect(outcomes.filter((o) => o === "created")).toHaveLength(5);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(15);
    expect(await storedFor("cap-concurrent")).toBe(5);
  });
});
