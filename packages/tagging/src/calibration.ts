import type { Channel } from "@nonametrust/schema";
import type { Policy } from "./policy.js";

/**
 * What the study measured. Every entry names the result it comes from, and
 * provenance.test.ts recomputes it from the aggregate tables vendored under
 * fixtures/study, so a number edited here without the fixture moving fails
 * there. Changing one is a claim about the measurement and needs evidence;
 * the audit moving a rate is that evidence, and the fixture is where it
 * lands first.
 */
export const MEASURED_CHANNELS = [
  "volume", "address_integrity", "protocol", "cluster_proximity", "content",
] as const;
export type MeasuredChannel = (typeof MEASURED_CHANNELS)[number];

export interface WeightEntry {
  readonly weight: number;
  /** The signal id in the study's frozen catalog, as the table names it. */
  readonly signal: string;
  readonly victimHits: number;
  readonly victimN: number;
  readonly controlHits: number;
  readonly controlN: number;
  readonly source: string;
}

export interface Calibration {
  readonly version: string;
  readonly channelWeights: Readonly<Record<MeasuredChannel, WeightEntry>>;
  /**
   * One pooled value for every channel. The study reports one pooled
   * distance distribution, dominated by one signal, and per-channel decay
   * learning is D1.4's designated analysis; inventing seven different
   * numbers would be the kind of unenforced claim this project keeps finding
   * false. Marked as not calibrated per channel, here and in the README.
   */
  readonly halfLifeMs: number;
  readonly halfLifeSource: string;
}

/**
 * Precision at an even prior, add-one smoothed on both arms.
 *
 * The study's table gives the share of victims and the share of controls
 * that carried each signal. Precision is the share of carriers that are
 * victims; at the study's own two-to-one control ratio it is a fact about
 * the sample design, so it is taken at an even prior, v / (v + c) over the
 * two rates. That is the quantity the audit's diagnosis of criterion 3 asks
 * for: the broad channels fire on nearly half of controls and land near
 * 0.63, the narrow ones almost never do and land near 0.8 to 0.97. Weighting
 * by raw difference would reproduce the OR-ing error one step later, because
 * the broad channels have the largest differences.
 *
 * Add-one smoothing exists for one row. S2's control rate is exactly zero,
 * and an unsmoothed precision of one would claim a test payment is never
 * innocent, which nothing measured.
 */
export function precisionAtEvenPrior(
  victimHits: number, victimN: number, controlHits: number, controlN: number,
): number {
  for (const [name, n] of [["victimHits", victimHits], ["victimN", victimN], ["controlHits", controlHits], ["controlN", controlN]] as const) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer, got ${n}`);
  }
  if (victimHits > victimN || controlHits > controlN) throw new RangeError("hits cannot exceed the arm's size");
  const v = (victimHits + 1) / (victimN + 2);
  const c = (controlHits + 1) / (controlN + 2);
  return v / (v + c);
}

const SIGNAL_TABLE = "nonametrust/results/signal_table.csv, 30-day rows, vendored as fixtures/study/signal_table_30d.csv";

export const CALIBRATION_V0: Calibration = {
  version: "calibration-v0",
  channelWeights: {
    // S2, the test payment: a small payment from the victim to the scam
    // address before the loss. 14 of 100 victims, 0 of 200 controls.
    volume: {
      weight: 0.9674, signal: "test_payment",
      victimHits: 14, victimN: 100, controlHits: 0, controlN: 200, source: SIGNAL_TABLE,
    },
    // S4, the lookalike address. 3 of 100 victims, 1 of 200 controls; the
    // study's own table says it does not carry the difference alone, its
    // interval crossing zero. The weight is high because controls almost
    // never carry it, and it rests on four carriers in all.
    address_integrity: {
      weight: 0.7984, signal: "lookalike_address",
      victimHits: 3, victimN: 100, controlHits: 1, controlN: 200, source: SIGNAL_TABLE,
    },
    // S5, the atypical trustline or unsolicited claimable balance. Fires on
    // 87 of 100 victims and 93 of 200 controls; the larger of the two broad
    // channels behind the 47.5% control base rate.
    protocol: {
      weight: 0.6496, signal: "atypical_trustline_or_claimable",
      victimHits: 87, victimN: 100, controlHits: 93, controlN: 200, source: SIGNAL_TABLE,
    },
    // S1, dust from the operation's one-hop cluster. 17 of 100, 7 of 200.
    cluster_proximity: {
      weight: 0.8167, signal: "dust_from_scam_cluster",
      victimHits: 17, victimN: 100, controlHits: 7, controlN: 200, source: SIGNAL_TABLE,
    },
    // S6, the memo anomaly. 69 of 100 victims, 83 of 200 controls; the other
    // broad channel.
    content: {
      weight: 0.6227, signal: "memo_anomaly",
      victimHits: 69, victimN: 100, controlHits: 83, controlN: 200, source: SIGNAL_TABLE,
    },
  },
  // The pooled median distance of dated victim hits before the loss, 14.01
  // days over 19,429 hits, rounded to a whole day. A tag opened at the median
  // distance still holds half of g0 when the loss arrives. The 80th
  // percentile, 23.4 days, is the limbo TTL's figure and belongs to W7.
  halfLifeMs: 14 * 24 * 60 * 60 * 1000,
  halfLifeSource: "nonametrust/results/distance_hist.csv, pooled median, vendored as fixtures/study/distance_hist.csv",
};

export function assertCalibration(calibration: Calibration): void {
  for (const c of MEASURED_CHANNELS) {
    const entry = calibration.channelWeights[c];
    if (!(entry.weight > 0 && entry.weight <= 1)) {
      throw new RangeError(`calibration.channelWeights.${c}.weight must lie in (0, 1], got ${entry.weight}`);
    }
  }
  if (!(calibration.halfLifeMs > 0) || !Number.isFinite(calibration.halfLifeMs)) {
    throw new RangeError(`calibration.halfLifeMs must be positive and finite, got ${calibration.halfLifeMs}`);
  }
}

function isMeasured(channel: Channel): channel is MeasuredChannel {
  return (MEASURED_CHANNELS as readonly string[]).includes(channel);
}

/**
 * The weight one channel's g0 is scaled by. Measured channels read the
 * calibration; latency and price read the policy, because the study had no
 * signal on either and calibration cannot carry what was not measured.
 */
export function channelWeight(channel: Channel, calibration: Calibration, policy: Policy): number {
  return isMeasured(channel)
    ? calibration.channelWeights[channel].weight
    : policy.unmeasuredChannelWeight;
}
