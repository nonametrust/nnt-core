import { z } from "zod";
import { channelSchema } from "./channel.js";
import { namespaceRefSchema } from "./namespace.js";
import { sourceSchema } from "./source.js";

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
  salienceHints: z
    .object({
      amount: z.string().optional(),
      latencyMs: z.number().nonnegative().optional(),
    })
    .strict()
    .optional(),
  /** Present from v0 so that enabling verification is not a migration. */
  signature: z.string().nullable().optional(),
  /** Assigned by the engine on ingest, absent on the wire. */
  observationId: z.string().uuid().optional(),
  idempotencyKey: z.string().optional(),
  ingestedAt: z.string().datetime().optional(),
};

const eventSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("event"),
    observedAt: z.string().datetime(),
  })
  .strict();

const stateSchema = z
  .object({
    ...common,
    evidenceKind: z.literal("state"),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime().nullable().default(null),
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

export type Observation = z.infer<typeof observationSchema>;
