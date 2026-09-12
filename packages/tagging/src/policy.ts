import type { ContinuousChannel } from "./reading.js";

/**
 * What the study does not speak to. The backtest measured whether evidence
 * exists before a loss, not how an engine should weigh it, so none of these
 * numbers is derivable from it. Each v0 default was chosen so that the parent
 * spec's section 9 scenario behaves as the whitepaper describes: small daily
 * payments, an address change on day twelve that lands in limbo, a
 * five-hundred-unit request on day twenty-one that is held. Every one of
 * them is uncalibrated, and tuning them against live traffic is the shadow
 * evaluation's job. The version is what the champion-challenger arrangement
 * keys on: two policies scoring the same traffic side by side are two
 * versions, and every result names the one that produced it.
 *
 * All fields are readonly. A policy is a value, and a value that one
 * computation could edit for the next would make the version a lie.
 */
export interface Policy {
  readonly version: string;
  /**
   * Below this count a continuous channel produces no tag, whatever the
   * deviation. The categorical channels are independent of it.
   */
  readonly minObservations: number;
  /** An observation is clipped at this multiple of the robust scale before it updates anything. */
  readonly winsorMadMultiple: number;
  /**
   * The floor under the robust scale, in the quantity's own unit, per
   * continuous channel with an override per aspect. Not the quantity's
   * granularity: a floor at the granularity would make a counterparty who
   * always sends exactly the same amount produce a maximal surprise on the
   * first trivial deviation. The two overrides are the scenario's aspects.
   */
  readonly scaleFloor: {
    readonly byChannel: Readonly<Record<ContinuousChannel, number>>;
    /** Keyed `channel/aspect`, for example `volume/amount/USDC/in`. */
    readonly byAspect: Readonly<Record<string, number>>;
  };
  /** Exponential weights of the fast and slow estimators; fast must be the larger. */
  readonly fastAlpha: number;
  readonly slowAlpha: number;
  /** The tag threshold at zero noise, in robust z units. */
  readonly thresholdBase: number;
  /** How fast the threshold rises with the namespace's relative dispersion. */
  readonly noiseCoefficient: number;
  /**
   * v0 has no fleet. The parent spec shrinks namespace statistics toward a
   * fleet-wide prior beneath the minimum count; here the prior is one
   * constant per continuous channel, a relative dispersion, and the count it
   * shrinks over is minObservations. Four declared numbers rather than a
   * prior per (kind, channel, aspect), which would be several hundred
   * invented ones. A real fleet prior is D1.4's work.
   */
  readonly fleetPrior: Readonly<Record<ContinuousChannel, number>>;
  /** The surprise at which g0 reaches 1 − 1/e of its channel's ceiling. */
  readonly surpriseScale: number;
  /**
   * A categorical observation has no surprise. Its g0 is its channel weight
   * times this base, and this base is the one place the spec left open.
   */
  readonly categoricalBase: number;
  /** A refresh adds this on top of the maximum, and it is what saturates. */
  readonly refreshIncrement: number;
  /** Where the increment saturates; a refreshed g0 never exceeds it. */
  readonly g0Ceiling: number;
  /**
   * Latency and price had no signal in the study. Calibration cannot carry
   * what was not measured, so their weight is here, and it is the weakest
   * measured weight so that an unmeasured channel never outranks a measured
   * one.
   */
  readonly unmeasuredChannelWeight: number;
}

export const POLICY_V0: Policy = {
  version: "policy-v0",
  minObservations: 10,
  winsorMadMultiple: 3,
  scaleFloor: {
    byChannel: { volume: 1, price: 0.01, latency: 50, cluster_proximity: 1 },
    byAspect: { "volume/amount/USDC/in": 0.05, "price/quoted/USDC": 0.05 },
  },
  fastAlpha: 0.2,
  slowAlpha: 0.02,
  thresholdBase: 3,
  noiseCoefficient: 1,
  fleetPrior: { volume: 0.5, price: 0.2, latency: 0.5, cluster_proximity: 0.5 },
  surpriseScale: 3,
  categoricalBase: 0.8,
  refreshIncrement: 0.05,
  g0Ceiling: 1,
  unmeasuredChannelWeight: 0.6227,
};

function positive(name: string, value: number): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`policy.${name} must be a positive finite number, got ${value}`);
  }
}

function nonNegative(name: string, value: number): void {
  if (!(value >= 0) || !Number.isFinite(value)) {
    throw new RangeError(`policy.${name} must be a non-negative finite number, got ${value}`);
  }
}

function unit(name: string, value: number, closedAtOne: boolean): void {
  const ok = value > 0 && (closedAtOne ? value <= 1 : value < 1);
  if (!ok) throw new RangeError(`policy.${name} must lie in (0, ${closedAtOne ? "1]" : "1)"}, got ${value}`);
}

/**
 * The minimum count, refused unless it is a positive integer. Written once
 * and read from three places: assertPolicy below, the shrinkage in
 * threshold.ts and the uncertainty in g0.ts, each of which divides by it and
 * each of which is public and reachable without passing through assertPolicy.
 * One predicate, so the three cannot drift apart in what they admit or in
 * what they say.
 */
export function requireMinObservations(policy: Policy): number {
  const n = policy.minObservations;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`policy.minObservations must be a positive integer, got ${n}`);
  }
  return n;
}

/**
 * A policy the arithmetic can use. Refused up front, once, rather than
 * discovered as a NaN three functions deep: a zero floor divides, an alpha
 * of one forgets everything, a slow weight above the fast one inverts the
 * two timescales and the divergence they expose.
 */
export function assertPolicy(policy: Policy): void {
  // The version is what every result names and what the champion-challenger
  // arrangement keys on; an empty one is a result that names nothing.
  if (policy.version.length === 0) throw new RangeError("policy.version must not be empty");
  requireMinObservations(policy);
  positive("winsorMadMultiple", policy.winsorMadMultiple);
  for (const [channel, floor] of Object.entries(policy.scaleFloor.byChannel)) {
    positive(`scaleFloor.byChannel.${channel}`, floor);
  }
  for (const [aspect, floor] of Object.entries(policy.scaleFloor.byAspect)) {
    positive(`scaleFloor.byAspect.${aspect}`, floor);
  }
  unit("fastAlpha", policy.fastAlpha, false);
  unit("slowAlpha", policy.slowAlpha, false);
  if (!(policy.fastAlpha > policy.slowAlpha)) {
    throw new RangeError(`policy.fastAlpha must exceed slowAlpha, got ${policy.fastAlpha} and ${policy.slowAlpha}`);
  }
  nonNegative("thresholdBase", policy.thresholdBase);
  nonNegative("noiseCoefficient", policy.noiseCoefficient);
  for (const [channel, prior] of Object.entries(policy.fleetPrior)) {
    nonNegative(`fleetPrior.${channel}`, prior);
  }
  positive("surpriseScale", policy.surpriseScale);
  unit("categoricalBase", policy.categoricalBase, true);
  nonNegative("refreshIncrement", policy.refreshIncrement);
  unit("g0Ceiling", policy.g0Ceiling, true);
  unit("unmeasuredChannelWeight", policy.unmeasuredChannelWeight, true);
}

/**
 * The floor for one aspect: the aspect's own entry when the policy names
 * it, the channel's otherwise. Never zero, by assertPolicy, so the scale
 * built on it is never zero.
 */
export function scaleFloorFor(policy: Policy, channel: ContinuousChannel, aspect: string): number {
  return policy.scaleFloor.byAspect[`${channel}/${aspect}`] ?? policy.scaleFloor.byChannel[channel];
}
