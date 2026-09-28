import { GRADES, type Grade } from "./grade.js";
import type { RelatednessCase } from "./relatedness.js";

/**
 * The risk tiers, R45.
 *
 * `"medium"` and not `"mid"`, because `mediumCeiling` is already named for it and
 * the policy field and the tier should agree. Nowhere in the tree agreed before
 * this: the design says "low-stakes / mid-tier / high-stakes" and M3's plan says
 * "low/mid/high" once and "medium" once.
 *
 * Refused at RUNTIME and not only by the type, because a JavaScript caller
 * bypasses the type and this value goes into a row that is hashed and outlives
 * every key. A tier the vocabulary does not admit must not become permanent.
 */
export const RISK_TIERS = ["low", "medium", "high"] as const;

export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Whether a reason's source would open, R47.
 *
 * A CODE and never a dereference. The source reference lives inside the sealed
 * payload, and three things follow: R25 forbids it in the audit body anyway, since
 * the chain outlives both the month key and the namespace key; a refreshed tag's
 * ref misdescribes its own evidence, measured at forty refreshes naming one
 * observation and recording the other thirty-nine nowhere; and `get` is the only
 * real cost in a brief, so dropping the ref drops it.
 *
 * Design §6 says error states are codes. The ordinary state needed one too, and
 * nothing had named it.
 */
export const SOURCE_CODES = ["SOURCE_PRESENT", "SOURCE_UNREADABLE"] as const;

export type SourceCode = (typeof SOURCE_CODES)[number];

/** One reason as the audit row carries it. */
export interface BriefAuditReason {
  readonly tagId: string;
  /** The tag's OPENING observation, R30. */
  readonly observationId: string;
  readonly relatednessCase: RelatednessCase;
  readonly source: SourceCode;
  /** `null` for a state, R19. An ISO instant otherwise. */
  readonly datedAt: string | null;
  /** R48's named number: the decayed strength this decision used. */
  readonly strength: number;
  /** R48's named number. */
  readonly relatedness: number;
}

/**
 * The audit row's body: a CLOSED type, R48.
 *
 * WHY IT CARRIES NUMBERS AT ALL. R25 admits "ids, codes, versions and instants",
 * and a grade cannot be explained by those alone -- `amount`, `unit`,
 * `threshold.base`, `threshold.applied` and each reason's `strength` and
 * `relatedness` are none of the four. **A grade nobody can recompute is not
 * auditable**, which is what an audit row is for. None of the six is a payload
 * field: `amount` is an input under R8, and the strengths and relatednesses are
 * computed from tag rows the store already keeps in the clear.
 *
 * WHY IT CARRIES `at` ITSELF. `AuditChain.append` stamps its own `occurredAt` from
 * the chain's clock and a caller cannot supply one, so the instant the brief was
 * ABOUT has to travel in the body. Under a fixed clock the two are equal; in
 * production `occurredAt` trails `at` by milliseconds, so the property that holds
 * outside a test is `at <= occurredAt`.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY, each with its reason:
 *
 * - **no source reference**, R47, and no key a reference could travel under. Held
 *   by a test over the whitelist and not only by this sentence.
 * - **no `refreshCount`**, which the brief's OUTPUT does carry under R30. It is not
 *   an id, a code, a version, an instant or one of R48's six numbers, and R42
 *   measured that at any past `at` it is a post-refresh value -- so a permanent row
 *   asserting it would be asserting something the store can already contradict.
 * - **no channel and no aspect.** A grade is recomputable without them, because
 *   each reason carries the relatedness VALUE the decision used rather than the
 *   inputs it was derived from. Keeping them out is R25 applied as written.
 * - **no `periodExpired` / `namespaceErased` booleans.** The CODE is the fact about
 *   the brief; the two flags are a read of the store's state at one instant, and
 *   retention moves them afterwards.
 */
export interface BriefAuditBody {
  readonly briefId: string;
  /** `null` when this brief recorded no candidate trigger (R18, R29). */
  readonly triggerId: string | null;
  /** The instant the brief was about, as an ISO string. */
  readonly at: string;
  readonly namespaceId: string;
  /** The intent's own observation. */
  readonly observationId: string;
  readonly amount: number;
  readonly unit: string;
  readonly riskTier: RiskTier;
  readonly grade: Grade;
  readonly threshold: { readonly base: number; readonly applied: number };
  readonly reasons: readonly BriefAuditReason[];
}

/**
 * Every key path a body contains, with array indices collapsed to `[]`.
 *
 * WALKS, and that is the ruling rather than an implementation detail. Measured
 * during review: `AuditChain.append` accepted
 * `{ payload, source, evidence: { ref } }`, so a check over TOP-LEVEL key names
 * passes `evidence.ref` into a table erasure cannot reach. And it is not a regex
 * over the rendered canonical JSON either, because a string VALUE containing `":`
 * fools one -- there is a test carrying such a value that must pass.
 *
 * A `null` is a leaf. Walking into one would produce no paths and quietly excuse
 * whatever a later shape put there.
 */
export function auditBodyPaths(body: unknown): Set<string> {
  const paths = new Set<string>();
  const walk = (value: unknown, prefix: string): void => {
    if (Array.isArray(value)) {
      // Collapsed, so two reasons produce one set of paths and the whitelist is a
      // statement about SHAPE rather than about how many reasons a brief found.
      for (const element of value) walk(element, `${prefix}[]`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      // A KEY MAY NOT CONTAIN THE PATH PUNCTUATION, and this is a real bypass a
      // review demonstrated rather than a precaution. `.`, `[` and `]` are legal in
      // a JSON key, and a path is built by joining with them -- so a single
      // top-level key literally named `threshold.base` renders the path
      // `threshold.base`, which `ADMITTED_PATHS` contains, and the value checks then
      // read the REAL `body.threshold.base` and never look at the impostor. Measured:
      // `{ ...body, "threshold.base": "tx/deadbeef" }` passed, and
      // `JSON.stringify` carried the reference into what the chain hashes.
      //
      // Refused rather than escaped, because escaping would make the whitelist's
      // entries unreadable and no legitimate body has such a key: every admitted key
      // is a TypeScript identifier.
      if (key.includes(".") || key.includes("[") || key.includes("]")) {
        throw new RangeError(
          `auditBody key ${JSON.stringify(key)} contains path punctuation, so it could ` +
            `impersonate an admitted path; every admitted key is a plain identifier`,
        );
      }
      const path = prefix === "" ? key : `${prefix}.${key}`;
      paths.add(path);
      walk(child, path);
    }
  };
  walk(body, "");
  return paths;
}

/**
 * The paths a body may contain, and no others.
 *
 * PATHS AND NOT KEY NAMES. A flat set of admitted names would let `unit` -- which
 * is admitted at the top level -- appear inside `threshold`, where it means
 * nothing and where a reader would take it for the threshold's own unit. A path
 * whitelist is the closed type expressed at runtime, which is what R48 asks for.
 *
 * Held equal to the shipped body's own paths by a test, in BOTH directions: a
 * missing entry refuses a legitimate body, and a dead entry admits a path nothing
 * produces today, which is a path a later body can start producing unnoticed.
 */
export const ADMITTED_PATHS: ReadonlySet<string> = new Set([
  "briefId",
  "triggerId",
  "at",
  "namespaceId",
  "observationId",
  "amount",
  "unit",
  "riskTier",
  "grade",
  "threshold",
  "threshold.base",
  "threshold.applied",
  "reasons",
  "reasons[].tagId",
  "reasons[].observationId",
  "reasons[].relatednessCase",
  "reasons[].source",
  "reasons[].datedAt",
  "reasons[].strength",
  "reasons[].relatedness",
]);

/** The four relatedness cases, as the body may name them. */
const RELATEDNESS_CASES: readonly RelatednessCase[] = [
  "same_aspect",
  "same_channel",
  "same_namespace",
  "unrelated",
];

/**
 * An ISO instant, to the millisecond, in UTC -- the one form `toISOString`
 * produces.
 *
 * Pinned to that exact form rather than to "a string `new Date` can parse",
 * because `new Date("2026-09-21")` parses and means midnight UTC while
 * `new Date("2026-09-21T00:00")` parses and means midnight LOCAL. A body whose
 * instant depended on the reader's zone is a body two readers disagree about, and
 * this branch has already paid for one date reader that returned February for a
 * March row.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requireAt(path: string, value: unknown, nullable: boolean): void {
  if (value === null && nullable) return;
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RangeError(
      `auditBody.${path} must be an ISO instant string like 2026-09-21T00:00:00.000Z, got ${JSON.stringify(value)}`,
    );
  }
}

function requireId(path: string, value: unknown, nullable: boolean): void {
  if (value === null && nullable) return;
  if (typeof value !== "string") {
    throw new RangeError(`auditBody.${path} must be a string, got ${typeof value}`);
  }
  if (value.trim().length === 0) throw new RangeError(`auditBody.${path} must not be blank`);
}

function requireFiniteNumber(path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `auditBody.${path} must be a finite number, got ${JSON.stringify(value)}`,
    );
  }
}

function requireOneOf(path: string, value: unknown, admitted: readonly string[]): void {
  if (typeof value !== "string" || !admitted.includes(value)) {
    throw new RangeError(
      `auditBody.${path} must be one of ${admitted.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}

function requirePresent(path: string, holder: object, key: string): void {
  if (!(key in holder) || (holder as Record<string, unknown>)[key] === undefined) {
    throw new RangeError(`auditBody.${path} is missing`);
  }
}

/**
 * Refuses a body the audit chain must not carry, naming the field or the path.
 *
 * TWO CHECKS AND NOT ONE. The path walk refuses a key nobody admitted, and the
 * field checks refuse a value the admitted type does not allow. Either alone is
 * insufficient: a walk passes `{ at: <a Date> }`, because a `Date` renders as an
 * ISO string and reads as admitted; and field checks alone pass
 * `evidence: { ref }`, because nothing looks at keys they do not name.
 *
 * The walk runs FIRST, so an unadmitted key is reported as itself rather than as
 * whatever missing field the value checks happen to reach.
 */
export function assertAuditBody(body: BriefAuditBody): void {
  if (typeof body !== "object" || body === null) {
    throw new RangeError(`auditBody must be an object, got ${typeof body}`);
  }

  for (const path of auditBodyPaths(body)) {
    if (!ADMITTED_PATHS.has(path)) {
      throw new RangeError(
        `auditBody.${path} is not admitted: the audit row outlives both the month key ` +
          `and the namespace key, so its body carries ids, codes, versions, instants and ` +
          `the named numbers a grade cannot be recomputed without, and nothing else`,
      );
    }
  }

  for (const key of ["briefId", "at", "namespaceId", "observationId", "amount", "unit", "riskTier", "grade", "threshold", "reasons", "triggerId"] as const) {
    requirePresent(key, body, key);
  }

  requireId("briefId", body.briefId, false);
  requireId("triggerId", body.triggerId, true);
  requireAt("at", body.at, false);
  requireId("namespaceId", body.namespaceId, false);
  requireId("observationId", body.observationId, false);
  requireFiniteNumber("amount", body.amount);
  requireId("unit", body.unit, false);
  requireOneOf("riskTier", body.riskTier, RISK_TIERS);
  requireOneOf("grade", body.grade, GRADES);

  requirePresent("threshold.base", body.threshold, "base");
  requirePresent("threshold.applied", body.threshold, "applied");
  requireFiniteNumber("threshold.base", body.threshold.base);
  requireFiniteNumber("threshold.applied", body.threshold.applied);

  if (!Array.isArray(body.reasons)) {
    throw new RangeError(`auditBody.reasons must be an array, got ${typeof body.reasons}`);
  }
  for (const reason of body.reasons) {
    // The path is written without an index on purpose: it is the path the
    // whitelist names, and a reader chasing a refusal should be handed the same
    // string in both messages.
    for (const key of ["tagId", "observationId", "relatednessCase", "source", "datedAt", "strength", "relatedness"] as const) {
      requirePresent(`reasons[].${key}`, reason, key);
    }
    requireId("reasons[].tagId", reason.tagId, false);
    requireId("reasons[].observationId", reason.observationId, false);
    requireOneOf("reasons[].relatednessCase", reason.relatednessCase, RELATEDNESS_CASES);
    requireOneOf("reasons[].source", reason.source, SOURCE_CODES);
    requireAt("reasons[].datedAt", reason.datedAt, true);
    requireFiniteNumber("reasons[].strength", reason.strength);
    requireFiniteNumber("reasons[].relatedness", reason.relatedness);
  }
}
