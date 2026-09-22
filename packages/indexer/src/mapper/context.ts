import type { Source, WireObservation } from "@nonametrust/schema";
import type { DropReason } from "../counters.js";

export type Network = "stellar:pubnet" | "stellar:testnet";

/** What every mapper needs beyond the record: who is producing, on which network, when read. */
export interface MapContext {
  network: Network;
  producerVersion: string;
  fetchedAt: string;
}

export const PRODUCER = "stellar-indexer";

export type MapResult =
  | { ok: true; observation: WireObservation }
  | { ok: false; reason: DropReason; ref: string };

export function source(ctx: MapContext, ref: string): Source {
  return {
    producer: PRODUCER,
    producerVersion: ctx.producerVersion,
    network: ctx.network,
    ref,
    fetchedAt: ctx.fetchedAt,
  };
}
