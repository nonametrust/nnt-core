import {
  payloadSchemaFor,
  type Channel,
  type Observation,
  type PayloadByChannel,
} from "@nonametrust/schema";

/**
 * The four channels that carry a continuous quantity and so have a baseline,
 * and the three that are categorical and tag from day one against no
 * baseline at all. The partition is total over CHANNELS; reading.test.ts
 * holds the union equal to it, so a new channel fails there until it is
 * placed on one side.
 */
export const CONTINUOUS_CHANNELS = ["volume", "price", "latency", "cluster_proximity"] as const;
export const CATEGORICAL_CHANNELS = ["address_integrity", "protocol", "content"] as const;
export type ContinuousChannel = (typeof CONTINUOUS_CHANNELS)[number];
export type CategoricalChannel = (typeof CATEGORICAL_CHANNELS)[number];

export interface ContinuousReading {
  kind: "continuous";
  channel: ContinuousChannel;
  aspect: string;
  value: number;
}

export interface CategoricalReading {
  kind: "categorical";
  channel: CategoricalChannel;
  aspect: string;
}

export type Reading = ContinuousReading | CategoricalReading;

/**
 * The shape of the aspects one channel can produce. `template` names the
 * quantity and, in braces, the payload fields that fix its unit; `quantity`
 * is the payload field whose value is read, null for a categorical channel.
 *
 * The set of shapes per channel is the enumeration the spec asks for. The
 * set of aspect strings is not finite for volume, price or protocol, since an
 * asset code, a unit and an event name are open strings, but every string
 * that can occur matches exactly one shape, and that is the property a
 * reader needs: a new payload field either lands in a template here or it
 * lands nowhere and pools nothing.
 */
export interface AspectShape {
  template: string;
  unitFields: readonly string[];
  quantity: string | null;
}

export const ASPECT_SHAPES: Readonly<Record<Channel, readonly AspectShape[]>> = {
  // 200 XLM in and 200 USDC out are three different scales, not one.
  volume: [{ template: "amount/{assetCode}/{direction}", unitFields: ["assetCode", "direction"], quantity: "amount" }],
  // A quote in USDC and a quote in XLM are not comparable.
  price: [{ template: "quoted/{unit}", unitFields: ["unit"], quantity: "quoted" }],
  // One scale per counterparty.
  latency: [{ template: "latencyMs", unitFields: [], quantity: "latencyMs" }],
  // Two quantities in one payload, one aspect each; amount only when present.
  cluster_proximity: [
    { template: "hops", unitFields: [], quantity: "hops" },
    { template: "amount", unitFields: [], quantity: "amount" },
  ],
  // Categorical. One transition is one aspect; a revert is a second
  // observation on the same aspect, which is what refresh is for.
  address_integrity: [{ template: "transition", unitFields: [], quantity: null }],
  protocol: [{ template: "event/{event}", unitFields: ["event"], quantity: null }],
  content: [{ template: "field/{field}", unitFields: ["field"], quantity: null }],
};

/**
 * A regular expression matching every aspect string the shape can produce.
 * Each braced field admits any non-empty run; the separator is `/`, which a
 * unit or an event name may itself contain, so a field is not anchored on
 * the separator and the match is on the whole string. The aspect is a key
 * and is never parsed back into its fields, so ambiguity of partition costs
 * nothing.
 */
export function shapePattern(shape: AspectShape): RegExp {
  const escaped = shape.template.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\{[a-zA-Z]+\}/g, "(.+)") + "$");
}

/**
 * The payload as its channel's validator types it. Every observation that
 * reaches tagging was validated on the wire, but the stored form types the
 * payload as an open record, and re-running the channel validator is the one
 * way to read it with the field names the shapes above name. A payload the
 * validator refuses cannot be read, so it is a RangeError here, before any
 * number is derived from it.
 */
function parsePayload<C extends Channel>(channel: C, payload: unknown): PayloadByChannel[C] {
  const result = payloadSchemaFor(channel).safeParse(payload);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`);
    throw new RangeError(`${channel} payload cannot be read: ${issues.join("; ")}`);
  }
  return result.data as PayloadByChannel[C];
}

/**
 * A decimal string, as the contract carries amounts and prices, read as a
 * double. Seven decimals of a Stellar amount fit; a string of four hundred
 * digits does not, and Number() of it is Infinity, which no scale can
 * measure. Refused rather than returned, so that no infinity is constructed
 * here to be caught later.
 */
function decimal(text: string, field: string): number {
  const n = Number(text);
  if (!Number.isFinite(n)) throw new RangeError(`${field} ${text} does not fit a double`);
  return n;
}

function finite(n: number, field: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${field} must be finite, got ${n}`);
  return n;
}

function continuous(channel: ContinuousChannel, aspect: string, value: number): ContinuousReading {
  return { kind: "continuous", channel, aspect, value };
}

function categorical(channel: CategoricalChannel, aspect: string): CategoricalReading {
  return { kind: "categorical", channel, aspect };
}

/**
 * Reads an observation into its readings: one per quantity the payload
 * carries, each with the aspect that names the quantity and fixes its unit.
 * The switch is exhaustive over the seven channels and TypeScript holds it
 * so; a channel added to the schema without a case here fails to compile.
 *
 * The aspect is derived here and only here. No caller passes one in, which
 * is what stops a producer from splitting or merging a counterparty's
 * history by choosing a string.
 */
export function readObservation(o: Observation): Reading[] {
  switch (o.channel) {
    case "volume": {
      const p = parsePayload("volume", o.payload);
      return [continuous("volume", `amount/${p.assetCode}/${p.direction}`, decimal(p.amount, "amount"))];
    }
    case "price": {
      const p = parsePayload("price", o.payload);
      return [continuous("price", `quoted/${p.unit}`, decimal(p.quoted, "quoted"))];
    }
    case "latency": {
      const p = parsePayload("latency", o.payload);
      return [continuous("latency", "latencyMs", finite(p.latencyMs, "latencyMs"))];
    }
    case "cluster_proximity": {
      const p = parsePayload("cluster_proximity", o.payload);
      const readings: Reading[] = [continuous("cluster_proximity", "hops", finite(p.hops, "hops"))];
      if (p.amount !== undefined) {
        readings.push(continuous("cluster_proximity", "amount", decimal(p.amount, "amount")));
      }
      return readings;
    }
    case "address_integrity": {
      parsePayload("address_integrity", o.payload);
      return [categorical("address_integrity", "transition")];
    }
    case "protocol": {
      const p = parsePayload("protocol", o.payload);
      return [categorical("protocol", `event/${p.event}`)];
    }
    case "content": {
      const p = parsePayload("content", o.payload);
      return [categorical("content", `field/${p.field}`)];
    }
    default: {
      const unhandled: never = o.channel;
      throw new RangeError(`no reading is defined for channel ${String(unhandled)}`);
    }
  }
}
