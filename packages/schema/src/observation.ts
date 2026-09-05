import { z } from "zod";
import { channelSchema } from "./channel.js";
import { namespaceRefSchema } from "./namespace.js";
import { sourceSchema } from "./source.js";
import { decimalStringSchema, utcDatetimeSchema } from "./scalars.js";

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
