import { z } from "zod";

/**
 * The producer name and its version are separate fields on purpose. The
 * idempotency key is derived from the producer name, the source reference and
 * the channel; folding the version into the name would change every key on a
 * version bump and silently break deduplication, which is a correctness
 * property rather than a performance one.
 */
export const sourceSchema = z.object({
  // Lowercase alphanumeric segments joined by single hyphens: no leading,
  // trailing or doubled hyphen. Producer names are our own component names,
  // so the tight form rejects nothing legitimate.
  producer: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
      message: "producer is a bare name; put the version in producerVersion",
    }),
  producerVersion: z.string().min(1),
  network: z.string().min(1).optional(),
  ref: z.string().min(1),
  fetchedAt: z.string().datetime(),
})
  // Strict: an unknown key is rejected rather than stripped, because a
  // stripped key tells the indexer a field is flowing when it is not. Gated in
  // source.test.ts.
  .strict();
export type Source = z.infer<typeof sourceSchema>;
