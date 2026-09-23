import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { deriveIdempotencyKey, type WireObservation } from "@nonametrust/schema";
import { sql } from "kysely";
import type { Db } from "../db.js";
import { withSchema } from "../testing/harness.js";
import { keyRingFromEnv, newDataKey, payloadAad, seal } from "../crypto.js";
import { fixedClock } from "../clock.js";
import { RETENTION_V0 } from "../retention.js";
import {
  CiphertextRejected, ConstraintViolation, IdempotencyKeyMismatch, NamespaceShredded,
  ObservationNotFound, StoreError,
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
  observations = new ObservationRepository(db, namespaces, clock);
});
afterAll(async () => { await done(); });

describe("the round trip", () => {
  it("returns every wire field it was given", async () => {
    const input = anEvent({ source: { ...src, ref: "op:rt:1" } });
    const { observation, created } = await observations.append(input);
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
    const { observation } = await observations.append(anEvent({ source: { ...src, ref: "op:rt:2" } }));
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
    const { observation } = await observations.append(input);
    const read = await observations.get(observation.observationId!);
    expect(read.namespace).toEqual((input as Record<string, unknown>).namespace);
  });

  it("leaves a state undated, so a standing condition never enters a timing computation", async () => {
    const { observation } = await observations.append(aState());
    const row = await db.selectFrom("observation").select(["dated_at"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.dated_at).toBeNull();
    const read = await observations.get(observation.observationId!);
    expect(read.evidenceKind).toBe("state");
  });

  it("dates an event by its own instant", async () => {
    const { observation } = await observations.append(anEvent({ source: { ...src, ref: "op:rt:4" } }));
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
  function rawRow(evidenceKind: string, datedAt: Date | null) {
    return sql`
      insert into observation (
        observation_id, idempotency_key, namespace_id, channel, kind, evidence_kind,
        dated_at, ingested_at, producer, payload_nonce, payload_tag, payload_ciphertext
      )
      select ${randomUUID()}, ${randomUUID()}, namespace_id, 'protocol', 'raw', ${evidenceKind},
        ${datedAt}, ${clock.now()}, 'raw-writer',
        decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex')
      from namespace limit 1
    `.execute(db);
  }

  it("refuses a dated state", async () => {
    await namespaces.ensure({ kind: "wallet", id: "RAWROWS" });
    await expect(rawRow("state", new Date("2026-09-01T00:00:00.000Z")))
      .rejects.toMatchObject({ code: "23514", constraint: "observation_state_is_undated" });
  });

  it("refuses an undated event", async () => {
    await namespaces.ensure({ kind: "wallet", id: "RAWROWS" });
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
    expect(second.observation.observationId).toBe(first.observation.observationId);
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
    expect(receiver.observation.observationId).not.toBe(sender.observation.observationId);
  });

  it("stores the derived key, not one a caller invented", async () => {
    const input = anEvent({ source: { ...src, ref: "op:key:1" } });
    const { observation } = await observations.append(input);
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
    const loser = new ObservationRepository(db, namespaces, clock);
    const realRead = loser.byIdempotencyKey.bind(loser);
    let blind = true;
    loser.byIdempotencyKey = async (key: string) => {
      if (blind) { blind = false; return null; }
      return realRead(key);
    };
    const result = await loser.append(input);
    expect(result.created).toBe(false);
    expect(result.observation.observationId).toBe(winner.observation.observationId);
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
    const orphan = {
      ensure: async () => ({ namespaceId: randomUUID(), kind: "wallet", nsId: "ORPHAN", shreddedAt: null }),
      dataKey: async () => newDataKey(),
    } as unknown as NamespaceRepository;
    const broken = new ObservationRepository(db, orphan, clock);
    const standIn = (await observations.append(anEvent({ source: { ...src, ref: "op:orphan:standin" } }))).observation;
    let blind = true;
    broken.byIdempotencyKey = async () => {
      if (blind) { blind = false; return null; }
      return standIn;
    };
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
    const { observation } = await observations.append(anEvent({ source: { ...src, ref: "op:ao:1" } }));
    await expect(
      sql`update observation set kind = 'tampered' where observation_id = ${observation.observationId}`
        .execute(db),
    ).rejects.toMatchObject({ code: "NNT01" });
    const row = await db.selectFrom("observation").select(["kind"])
      .where("observation_id", "=", observation.observationId!).executeTakeFirstOrThrow();
    expect(row.kind).toBe("payment");
  });

  it("refuses a DELETE", async () => {
    const { observation } = await observations.append(anEvent({ source: { ...src, ref: "op:ao:2" } }));
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
    const { observation } = await observations.append(anEvent({ source: { ...src, ref: "op:aad:1" } }));
    const id = observation.observationId!;
    const moves = [
      sql`dated_at = dated_at + interval '1 day'`,
      sql`channel = 'latency'`,
      sql`kind = 'tampered'`,
      sql`evidence_kind = 'state', dated_at = null`,
      sql`producer = 'tampered'`,
      // An hour moves the instant without moving its calendar month; a month
      // moves the bucket the retention key is chosen by. Both are refused by
      // the envelope, and the second is the one that would otherwise re-file
      // a row under a key that was never used to seal it.
      sql`ingested_at = ingested_at + interval '1 hour'`,
      sql`ingested_at = ingested_at + interval '1 month'`,
    ];
    for (const move of moves) {
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`alter table observation disable trigger observation_no_update`.execute(trx);
          await sql`update observation set ${move} where observation_id = ${id}`.execute(trx);
          const inside = new ObservationRepository(trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock);
          await inside.get(id);
        }),
      ).rejects.toBeInstanceOf(CiphertextRejected);
    }
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
    const idA = a.observation.observationId!;
    const idB = b.observation.observationId!;
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
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock,
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
    const idA = a.observation.observationId!;
    const row = await db.selectFrom("observation")
      .select(["namespace_id", "idempotency_key", "evidence_kind", "channel", "kind",
        "dated_at", "ingested_at", "producer"])
      .where("observation_id", "=", idA).executeTakeFirstOrThrow();
    const dataKey = await namespaces.dataKey(row.namespace_id);
    const forged = seal(
      dataKey,
      JSON.stringify({ ...a.observation, observationId: b.observation.observationId }),
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
          trx, new NamespaceRepository(trx, ring, clock, RETENTION_V0), clock,
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
    const { observation } = await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:2" } }),
    );
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
    const { observation } = await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:3" } }),
    );
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
    const { observation } = await observations.append(
      anEvent({ source: { ...src, ref: "op:producer:4" } }),
    );
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
      .where("observation_id", "in", [a.observation.observationId!, b.observation.observationId!])
      .execute();
    const byId = new Map(rows.map((r) => [r.observation_id, r.producer]));
    expect(byId.get(a.observation.observationId!)).toBe("stellar-indexer");
    expect(byId.get(b.observation.observationId!)).toBe("x402-gateway");
    // And both still open, so the column and the envelope agree for each.
    expect((await observations.get(a.observation.observationId!)).source.producer).toBe("stellar-indexer");
    expect((await observations.get(b.observation.observationId!)).source.producer).toBe("x402-gateway");
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
    const repo = new ObservationRepository(db, ns, ticking);
    const { observation } = await repo.append(
      anEvent({ source: { ...src, ref: "op:ticking:1" } }),
    );
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
    const { observation } = await observations.append(anEvent({
      source: { ...src, ref: "op:shred:1" }, namespace: { kind: "wallet", id: "SHREDOBS" },
    }));
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
