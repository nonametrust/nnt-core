import { z } from "zod";
import { channelSchema } from "./channel.js";
import { namespaceRefSchema } from "./namespace.js";
import { sourceSchema } from "./source.js";
import { decimalStringSchema, utcDatetimeSchema } from "./scalars.js";

/**
 * The WIRE version, which is not this package's version and moves for different
 * reasons.
 *
 * This constant changes only when what a producer must send changes, and every
 * observation names it; the package version changes whenever the package's own
 * surface does. M3's Task 3 is the case that makes the distinction worth writing
 * down: it took the package from 0.2.0 to 0.3.0 by adding `holdsAt` and
 * `StoredObservation`, and neither is a wire change -- a producer's mapper still
 * returns exactly the `WireObservation` it returned before, so this stays at
 * 0.1.0 and the indexer needs to do nothing.
 */
export const OBSERVATION_SCHEMA_VERSION = "0.1.0";

const common = {
  schemaVersion: z.string().min(1),
  namespace: namespaceRefSchema,
  channel: channelSchema,
  /** What happened at the source, for example "payment". Not the channel. */
  kind: z.string().min(1),
  source: sourceSchema,
  /**
   * Required, and an object. `z.unknown()` would infer an optional key and
   * let a missing payload through; `observation.test.ts` gates both.
   */
  payload: z.record(z.string(), z.unknown()),
  /**
   * Read by the salience computation without opening the payload, so the
   * amount obeys the same rule as a payload amount.
   *
   * Not yet enforced: that the payload is encrypted at rest, which is why the
   * hints exist. The store belongs to a later milestone and nothing in this
   * package encrypts anything.
   */
  salienceHints: z
    .object({
      amount: decimalStringSchema.optional(),
      latencyMs: z.number().nonnegative().optional(),
    })
    .strict()
    .optional(),
  /** Present from v0 so that enabling verification is not a migration. */
  signature: z.string().nullable().optional(),
  /** Assigned by the engine on ingest, absent on the wire. */
  observationId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  ingestedAt: utcDatetimeSchema.optional(),
};

const eventSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("event"),
    observedAt: utcDatetimeSchema,
  })
  .strict();

const stateSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("state"),
    validFrom: utcDatetimeSchema,
    validUntil: utcDatetimeSchema.nullable().default(null),
  })
  .strict();

/**
 * An event carries an instant and no interval; a state carries an interval and
 * no instant. The union is strict in both directions so that a state can never
 * acquire a date by accident, which is the defect the study's S3 signal
 * exhibited.
 *
 * The interval check sits on the union rather than on the state member because
 * `z.discriminatedUnion` accepts plain objects only: a member ending in
 * `.refine` is a `ZodEffects` and the union throws while it is being built.
 */
export const observationSchema = z
  .discriminatedUnion("evidenceKind", [eventSchema, stateSchema])
  .superRefine((o, ctx) => {
    if (o.evidenceKind !== "state") return;
    if (o.validUntil === null) return;
    if (Date.parse(o.validUntil) < Date.parse(o.validFrom)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validUntil"],
        message: "validUntil precedes validFrom",
      });
    }
  });

/**
 * The stored form: the engine-assigned fields are present once ingest has run.
 * The design document's `Observation` interface describes this form.
 */
export type Observation = z.infer<typeof observationSchema>;

// `Omit` on a union collapses it to its common keys, which would lose the
// event/state discrimination; distributing over the members keeps it.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * The wire form: what a producer's mapper returns and `validateObservation`
 * accepts. `observationId` and `ingestedAt` are absent because the validator
 * refuses them on the wire; typing a mapper's output as this rather than as
 * `Observation` makes that a compile-time error instead of a runtime one.
 * `idempotencyKey` stays optional here because the validator accepts a
 * precomputed key that equals the derived one.
 */
export type WireObservation = DistributiveOmit<Observation, "observationId" | "ingestedAt">;

// NO DISTRIBUTION HELPER HERE, and the absence is deliberate. `DistributiveOmit`
// above needs one because `Omit` is built on `keyof`, and `keyof` of a union is
// only its COMMON keys, so omitting from a union collapses the discrimination. An
// INTERSECTION has no such problem: TypeScript already normalises
// `(A | B) & C` to `(A & C) | (B & C)`, so `evidenceKind` keeps narrowing.
//
// Written down because the first version of this type wrapped the intersection in
// a `T extends unknown ? ... : never` and claimed the distribution was what kept
// the discrimination working. Mutation refused that: removing the conditional
// produced ZERO typecheck errors, because it was never doing anything. A helper
// that can be deleted with nothing failing is a helper whose comment is wrong.

/**
 * The stored form with its identity REQUIRED: what a caller holds once ingest
 * has run and the row exists.
 *
 * R32, and it is a typing defect rather than a new concept. `observationId` is
 * optional on `Observation` because it is absent on the wire -- "assigned by the
 * engine on ingest" -- which is right for the wire and wrong for everything
 * downstream. The store's `AppendResult` then declared `observationId: string`
 * on its unreadable arm while its readable arms carried an `Observation` whose
 * id was optional, so a caller narrowing on `created` got a DIFFERENT TYPE for
 * the same field depending on which arm it landed in, and the store's test
 * harness grew a `storedObservation` helper whose only job was to paper over it.
 * That helper was the only narrowing in the tree.
 *
 * The engine is the first real consumer, which is why this lands now: Task 2's
 * own tests had to write `storedObservation(...).observationId!` to typecheck,
 * and an assertion operator in a test is a rule held by nobody.
 *
 * `WireObservation` remains the type that REFUSES the field, so the three forms
 * now say three different things: the wire has no id, `Observation` may have one,
 * and this one has one.
 */
export type StoredObservation = Observation & { observationId: string };
