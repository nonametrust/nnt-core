import { createHash } from "node:crypto";
import type { Channel } from "./channel.js";
import type { NamespaceRef } from "./namespace.js";
import type { Source } from "./source.js";

/**
 * Deduplication is a correctness property, not a performance one: a duplicated
 * trace makes the tagging pipeline believe the evidence is twice as strong.
 *
 * The key identifies this source event, as it concerns this counterparty, on
 * this channel. It is derived from the producer name, the network, the source
 * reference, the channel, and the namespace kind and id, and from nothing else.
 *
 * The namespace is in because an observation is evidence about a counterparty.
 * A payment has two sides, and the sender's and the receiver's observations
 * share producer, network, ref and channel; without the namespace the second
 * would be dropped as a duplicate and one side's evidence would silently
 * disappear. Two observations about different counterparties are different
 * observations even when they come from one chain event, and the key says so by
 * construction rather than by a convention on `ref`. The continuity assertion
 * is provenance about the namespace, not part of which counterparty is meant,
 * so it stays out.
 *
 * The producer version is excluded so that a version bump does not silently
 * mint duplicates of everything already stored. The fetch time is excluded so
 * that a re-read of the same range produces no new observations, which is the
 * indexer's own acceptance criterion. The network is included because Horizon
 * operation ids repeat across pubnet and testnet, and one producer reading both
 * is the expected configuration once the testnet demo runs alongside mainnet
 * shadow observation.
 *
 * The parts are joined with a NUL rather than a space because `ref` and the
 * namespace id are unconstrained: without a separator that cannot occur inside
 * a field, two adjacent parts could be re-partitioned into a different pair
 * with the same concatenation. "Cannot occur" is enforced twice: `sourceSchema`
 * rejects a NUL in `network` and `ref`, `namespaceRefSchema` rejects one in
 * `id`, and this function refuses one in any part as well, so the key stays
 * unambiguous for input that reached it without validation. `producer` is
 * constrained by its own regex, and `channel` and the namespace `kind` are
 * enums. The observation's own `kind`, the free-string source event type, is
 * not a part of the key at all.
 *
 * An absent network occupies its slot as the empty string. The schema requires
 * a declared network to be non-empty, so absent and empty never collide.
 *
 * The part order is part of the derivation and is frozen once keys are stored.
 */
const SEPARATOR = "\u0000";

export function deriveIdempotencyKey(
  source: Source,
  channel: Channel,
  namespace: NamespaceRef,
): string {
  const parts = [
    source.producer,
    source.network ?? "",
    source.ref,
    channel,
    namespace.kind,
    namespace.id,
  ];
  for (const part of parts) {
    if (part.includes(SEPARATOR)) {
      throw new RangeError("idempotency key field contains NUL, the part separator");
    }
  }
  return createHash("sha256").update(parts.join(SEPARATOR)).digest("hex");
}
