import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { WireObservation } from "@nonametrust/schema";
import { CALIBRATION_V0, POLICY_V0 } from "@nonametrust/tagging";
import {
  fixedClock,
  keyRingFromEnv,
  migrate,
  openDb,
  RETENTION_V0,
  type Db,
  type FixedClock,
} from "@nonametrust/store";
import { compose, type Composed } from "./compose.js";
import { observe } from "./observe.js";
import { briefDeps, runBrief } from "./run-brief.js";
import { BRIEF_POLICY_V0 } from "./policy.js";
import type { BriefPolicies } from "./brief.js";
import type { IdSource } from "./ids.js";

// TASK 9: R15's acceptance scenario, end to end through the ENGINE, on one
// database, with one clock advanced through twenty-one simulated days.
//
// THE STORY. A data provider an agent uses often has a standing condition and a
// payment history (day zero). On day twelve its advertised payment address
// changes once and reverts the same afternoon; the change is unremarkable alone
// and is what the brief must surface. On day twenty-one the provider quotes a
// large price, the decision layer asks what is known, and the address change
// must still be there, still dated day twelve.
//
// WHAT R15 CORRECTED IN ITS OWN FIRST VERSION, and why this file is shaped the
// way it is. M1's story alone is arithmetically COLD: `POLICY_V0.minObservations`
// is 10 and the story gives the provider ONE price observation, so
// `judgeSurprise` returns cold, nothing crosses on day twenty-one, and
// `trigger_event.surprise` is NOT NULL -- the brief would have had no candidate
// trigger to note. So M2's prior quotes are merged in, and the COUNT IS DERIVED
// from `POLICY_V0.minObservations` rather than written down, because a
// hard-coded twenty stops being right the moment the policy moves.
//
// AND THE HALF-LIFE IS FOURTEEN DAYS, not the store's seven. The store's own
// acceptance test keeps 7 for its own reasons; R15 records that the two differ
// rather than unifying them, so this file takes `CALIBRATION_V0` and asserts
// nothing that depends on "halved once by day nineteen".
//
// THE TRAP THIS FILE IS WRITTEN AGAINST. The storage card's acceptance test fell
// into it twice: asserting the brief's answer against an array the test itself
// filled in earlier, which tests the array. Every assertion below reads out of
// the `BriefOutput` the engine returned, and the day-twelve instant is read off
// the reason rather than compared to a date the test already knew it had put in.

const SCHEMA = "engine_acceptance_test";
const MIGRATIONS = fileURLToPath(new URL("../../store/migrations/", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

// Day zero is twelve days before the address change, so "day twelve" is a date
// the story names rather than an offset the reader has to compute.
const DAY_TWELVE = new Date("2026-09-12T00:00:00.000Z");
const DAY_ZERO = new Date(DAY_TWELVE.getTime() - 12 * DAY);

function day(n: number, time = "00:00"): Date {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(DAY_ZERO.getTime() + n * DAY + h * 60 * 60 * 1000 + m * 60 * 1000);
}

/**
 * The provider is an ENDPOINT, as the fixtures have it: an address is an
 * attribute of a counterparty, not a counterparty. Its payment wallet is a
 * second namespace, and under R11 the continuity assertion that links them is
 * out of M3 entirely -- so the wallet's payment is observed here and asserted to
 * contribute NOTHING to the provider's brief, which is the honest version of
 * "linked by a continuity assertion" at this milestone.
 */
const PROVIDER = { kind: "endpoint", id: "https://data.example/x402" } as const;
const WALLET = { kind: "wallet", id: "GPROVIDERWALLET00000000000000000000000000000000000000000" } as const;
/** A counterparty with no history at all: the comparison the threshold needs. */
const STRANGER = { kind: "endpoint", id: "https://other.example/y402" } as const;

const gateway = {
  producer: "x402-gateway",
  producerVersion: "0.1.0",
  network: "testnet",
};
const indexer = {
  producer: "horizon-indexer",
  producerVersion: "0.1.0",
  network: "testnet",
};

const ring = keyRingFromEnv({
  NNT_MASTER_KEY: randomBytes(32).toString("base64"),
} as NodeJS.ProcessEnv);

const policies: BriefPolicies = {
  retention: RETENTION_V0,
  tagging: POLICY_V0,
  calibration: CALIBRATION_V0,
  brief: BRIEF_POLICY_V0,
};

let db: Db;
let clock: FixedClock;
let composed: Composed;
let base: string;

function requireBaseUrl(): string {
  const url = process.env.NNT_TEST_DATABASE_URL;
  if (!url) throw new Error("NNT_TEST_DATABASE_URL is not set; this suite fails rather than skips.");
  return url;
}

const ids = (): IdSource => {
  let n = 0;
  return { next: (): string => `99999999-0000-4000-8000-${String(++n).padStart(12, "0")}` };
};

/** Advances the one clock to an instant and ingests one observation there. */
async function at(instant: Date, wire: WireObservation) {
  clock.advance(instant.getTime() - clock.now().getTime());
  return observe(composed, wire, policies);
}

const priceQuote = (n: number, quoted: string, instant: Date): WireObservation =>
  ({
    schemaVersion: "0.1.0",
    namespace: PROVIDER,
    channel: "price",
    evidenceKind: "event",
    kind: "quote",
    observedAt: instant.toISOString(),
    source: { ...gateway, ref: `req:quote:${n}`, fetchedAt: instant.toISOString() },
    payload: { quoted, unit: "USDC" },
  }) as WireObservation;

beforeAll(async () => {
  base = requireBaseUrl();
  const admin = openDb(base);
  await admin.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
  await admin.schema.createSchema(SCHEMA).execute();
  await admin.destroy();

  db = openDb(
    `${base}${base.includes("?") ? "&" : "?"}options=-c%20search_path%3D${SCHEMA}`,
  );
  await migrate(db, MIGRATIONS);
  clock = fixedClock(DAY_ZERO);
  composed = compose(db, clock, ring, RETENTION_V0);
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await db.destroy();
    const cleanup = openDb(base);
    await cleanup.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
    await cleanup.destroy();
  }
});

describe("R15: day zero, day twelve, day twenty-one", () => {
  it("surfaces the day-twelve address change in the day-twenty-one brief, dated day twelve", async () => {
    // ---- DAY ZERO: a standing condition, and a routine payment on the wallet.
    const condition = await at(
      day(0, "09:00"),
      {
        schemaVersion: "0.1.0",
        namespace: PROVIDER,
        channel: "protocol",
        evidenceKind: "state",
        kind: "accepts_asset",
        validFrom: day(0).toISOString(),
        validUntil: null,
        source: { ...gateway, ref: "probe:day-zero", fetchedAt: day(0, "09:00").toISOString() },
        payload: { event: "accepts_usdc" },
      } as unknown as WireObservation,
    );
    expect(condition.folded).toBe(true);
    expect(condition.ownTagIds, "the standing condition opened no tag").toHaveLength(1);

    const payment = await at(day(0, "09:30"), {
      schemaVersion: "0.1.0",
      namespace: WALLET,
      channel: "volume",
      evidenceKind: "event",
      kind: "payment",
      observedAt: day(0, "09:30").toISOString(),
      source: { ...indexer, ref: "op:day-zero:1", fetchedAt: day(0, "09:31").toISOString() },
      payload: { amount: "12.5000000", assetCode: "USDC", direction: "in" },
    } as WireObservation);
    expect(payment.folded).toBe(true);

    // ---- DAYS ONE TO ELEVEN: M2's prior quotes, so day twenty-one is not cold.
    // THE COUNT IS DERIVED. R15: "the test computes the bound from
    // minObservations rather than hard-coding it", which is the shape the
    // producer cap's own test uses. Twice the minimum is M2's twenty when the
    // minimum is ten, and stays correct if the policy moves.
    const priorQuotes = POLICY_V0.minObservations * 2;
    expect(priorQuotes, "the fixture is below the cold bound it exists to clear").toBeGreaterThan(
      POLICY_V0.minObservations,
    );
    for (let i = 0; i < priorQuotes; i += 1) {
      // Eleven days of quotes, two or so a day, all near 40 USDC: a tight history
      // is what makes a 2500 quote surprising rather than merely larger.
      const instant = new Date(day(1).getTime() + i * ((11 * DAY) / priorQuotes));
      const out = await at(instant, priceQuote(i, (40 + i * 0.01).toFixed(7), instant));
      expect(out.folded, `prior quote ${i} did not fold`).toBe(true);
    }

    // ---- DAY TWELVE: the advertised address moves, and reverts the same
    // afternoon. Two observations, one transition each: a revert is a second
    // change and not an undo, which is what makes the day's history readable
    // later.
    const movedAway = await at(day(12, "11:00"), {
      schemaVersion: "0.1.0",
      namespace: PROVIDER,
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "address_changed",
      observedAt: day(12, "11:00").toISOString(),
      source: { ...gateway, ref: "probe:day-twelve:away", fetchedAt: day(12, "11:01").toISOString() },
      payload: {
        previous: "GPROVIDERWALLET00000000000000000000000000000000000000000",
        current: "GSOMEWHEREELSE000000000000000000000000000000000000000000",
      },
    } as WireObservation);
    expect(movedAway.ownTagIds, "the address change opened no tag").toHaveLength(1);
    const addressTagId = movedAway.ownTagIds[0]!;

    const movedBack = await at(day(12, "16:00"), {
      schemaVersion: "0.1.0",
      namespace: PROVIDER,
      channel: "address_integrity",
      evidenceKind: "event",
      kind: "address_changed",
      observedAt: day(12, "16:00").toISOString(),
      source: { ...gateway, ref: "probe:day-twelve:back", fetchedAt: day(12, "16:01").toISOString() },
      payload: {
        previous: "GSOMEWHEREELSE000000000000000000000000000000000000000000",
        current: "GPROVIDERWALLET00000000000000000000000000000000000000000",
      },
    } as WireObservation);
    // The revert REFRESHES the same tag rather than opening a second: one live tag
    // per (namespace, channel, aspect) is M2's invariant, and `transition` is the
    // aspect for every address change.
    expect(movedBack.ownTagIds).toEqual([addressTagId]);

    // ---- DAY TWENTY-ONE: the large quote, then the brief.
    const quote = await at(day(21, "10:00"), priceQuote(999, "2500.0000000", day(21, "10:00")));
    expect(quote.folded).toBe(true);
    expect(quote.intent.briefable, "the price intent is not briefable").toBe(true);
    // NOT COLD, which is the whole reason the prior quotes are here. A cold
    // verdict would make `surprise` null and leave the brief no candidate
    // trigger to record.
    expect(quote.surprise, "the day-twenty-one quote was COLD").not.toBeNull();

    const providerNs = (await composed.namespaces.find(PROVIDER.kind, PROVIDER.id))!.namespaceId;
    const brief = await runBrief(briefDeps(composed, ids()), {
      intent: { namespaceId: providerNs, channel: "price", aspect: "quoted/USDC" },
      observationId: quote.observationId,
      amount: 2500,
      unit: "USDC",
      riskTier: "high",
      ownTagIds: quote.ownTagIds,
      surprise: quote.surprise,
      policies,
    });

    // ---- THE ANSWER, READ OUT OF THE BRIEF.
    // The day-twelve reason, found by its CHANNEL in the brief's own output, and
    // its instant read off the reason -- not compared with a date this test
    // handed in, which is the trap this file is written against.
    const addressReason = brief.reasons.find((r) => r.channel === "address_integrity");
    expect(addressReason, "the day-twelve address change is not in the brief").toBeDefined();
    expect(addressReason!.tagId).toBe(addressTagId);
    expect(addressReason!.datedAt, "the address reason carries no instant").not.toBeNull();
    // STILL DATED DAY TWELVE, nine days later. The revert is the afternoon
    // observation, so the tag's evidence is dated day twelve whichever of the two
    // the reason points at -- and the assertion is the DAY, which is the story's
    // claim.
    expect(addressReason!.datedAt!.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(addressReason!.evidenceKind).toBe("event");

    // R30: the reason names the tag's OPENING observation, not the refresh's --
    // and the instant is the opening one too, to the millisecond. The revert at
    // 16:00 refreshed the tag; the reason still carries 11:00.
    expect(addressReason!.observationId).toBe(movedAway.observationId);
    expect(addressReason!.datedAt!.toISOString()).toBe(day(12, "11:00").toISOString());
    expect(addressReason!.refreshCount).toBe(1);

    // ---- EXACTLY ONE REASON, AND THE DAY-ZERO CONDITION IS NOT IT.
    //
    // THIS IS THE MECHANISM THE WHOLE SYSTEM IS FOR, and it only shows up in a
    // scenario that runs twenty-one days. The standing condition from day zero is
    // STILL LIVE in the store -- so its absence from the brief is the active floor
    // doing work, not the tag having gone away. Measured at this `at`, with the
    // calibrated fourteen-day half-life:
    //
    //   protocol/event/accepts_usdc   g0 0.51968  tagged day 0   -> strength 0.1837
    //   address_integrity/transition  g0 0.63872  tagged day 12  -> strength 0.4142
    //
    // The floor R49 names falls between them, so the day-zero fact has faded and
    // the day-twelve one has not. An implementation that ignored decay, or read
    // `g0` instead of the decayed strength, would put BOTH in the brief and the
    // threshold would be 600 x 0.8^2 = 384 instead of 480 -- which is why the
    // count of reasons is asserted and not just their content.
    const liveTags = await composed.tags.listLive(providerNs);
    const dayZeroTag = liveTags.find((t) => t.channel === "protocol");
    expect(dayZeroTag, "the day-zero condition's tag is GONE, so the floor proves nothing").toBeDefined();
    expect(brief.reasons, "the day-zero condition did not fade out of the brief").toHaveLength(1);
    expect(brief.reasons[0]!.channel).toBe("address_integrity");

    // And the two strengths really do straddle the floor, in the order the
    // comment states -- so the exclusion is decay and not an accident of ordering.
    expect(addressReason!.strength).toBeGreaterThan(0.25);
    expect(addressReason!.strength).toBeCloseTo(0.4142, 3);

    // The intent's own tag is NOT a reason, R22: the day-twenty-one quote opened
    // or refreshed a price tag and a brief does not cite its own evidence.
    expect(
      brief.reasons.map((r) => r.tagId),
      "the brief cited the intent's own tag",
    ).not.toContain(quote.ownTagIds[0]);
    expect(brief.reasons.some((r) => r.channel === "price")).toBe(false);

    // R39: `loweredBy` is the same set as the reasons, asserted rather than
    // trusted to stay so.
    expect([...brief.threshold.loweredBy].sort()).toEqual(
      brief.reasons.map((r) => r.tagId).sort(),
    );
    expect(brief.threshold.base).toBe(BRIEF_POLICY_V0.briefThreshold);
    expect(brief.threshold.applied).toBeLessThan(brief.threshold.base);
    // The arithmetic R39 names, through the policy rather than a number: base
    // times the factor once per reason.
    expect(brief.threshold.applied).toBeCloseTo(
      BRIEF_POLICY_V0.briefThreshold * BRIEF_POLICY_V0.activeTagFactor ** brief.reasons.length,
      9,
    );

    // 2500 USDC against a lowered threshold of a few hundred: the grade is read
    // from the brief, and the amount really is above the bar.
    expect(brief.grade).toBe("hold");
    expect(brief.threshold.applied).toBeLessThan(2500);

    // ---- THE EFFECTS: a candidate trigger, and a chain entry that is not
    // optional (R24).
    expect(brief.effects.audit, "the brief recorded no chain entry").toBeDefined();
    expect(brief.effects.trigger, "a measured crossing recorded no candidate trigger").not.toBeNull();
    const head = await composed.audit.head();
    expect(head!.kind).toBe("brief");
    // And nothing payload-derived reached the chain: the aspect names the unit,
    // which is a payload field, and R25 keeps it out.
    expect(head!.canonical).not.toContain("quoted/USDC");

    // ---- THE COMPARISON R15 INSISTS ON. "Lower than it was" is satisfiable with
    // `activeTagFactor = 1` whenever `briefThreshold < 2500`, so the acceptance is
    // a comparison against the SAME QUERY for a counterparty with no active tag.
    const strangerQuote = await at(
      day(21, "10:30"),
      {
        schemaVersion: "0.1.0",
        namespace: STRANGER,
        channel: "price",
        evidenceKind: "event",
        kind: "quote",
        observedAt: day(21, "10:30").toISOString(),
        source: { ...gateway, ref: "req:quote:stranger", fetchedAt: day(21, "10:30").toISOString() },
        payload: { quoted: "2500.0000000", unit: "USDC" },
      } as WireObservation,
    );
    const strangerNs = (await composed.namespaces.find(STRANGER.kind, STRANGER.id))!.namespaceId;
    const strangerBrief = await runBrief(briefDeps(composed, ids()), {
      intent: { namespaceId: strangerNs, channel: "price", aspect: "quoted/USDC" },
      observationId: strangerQuote.observationId,
      amount: 2500,
      unit: "USDC",
      riskTier: "high",
      ownTagIds: strangerQuote.ownTagIds,
      surprise: strangerQuote.surprise,
      policies,
    });

    expect(strangerBrief.reasons, "the stranger has a history after all").toEqual([]);
    expect(strangerBrief.threshold.applied).toBe(BRIEF_POLICY_V0.briefThreshold);
    expect(
      brief.threshold.applied,
      "the provider's active tags did not lower its threshold below a stranger's",
    ).toBeLessThan(strangerBrief.threshold.applied);

    // ---- R11: the wallet's payment contributed nothing. The continuity
    // assertion that links wallet to endpoint is out of M3, and this is what that
    // means in the answer rather than in a sentence.
    const walletNs = (await composed.namespaces.find(WALLET.kind, WALLET.id))!.namespaceId;
    expect(walletNs, "the wallet and the endpoint are one namespace").not.toBe(providerNs);
    expect(
      brief.reasons.map((r) => r.relatednessCase),
      "a wallet tag reached the endpoint's brief",
    ).toEqual(["same_namespace"]);
    expect(await composed.tags.listLive(walletNs), "the wallet payment opened a tag").toEqual([]);
  }, 180_000);
});
