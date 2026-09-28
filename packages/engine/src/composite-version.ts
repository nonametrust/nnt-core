/**
 * The separator R26 joins the four policy versions with.
 *
 * Re-exported from here rather than from `policy.ts` because this module is what
 * performs the join; `policy.ts` refuses it in `BriefPolicy.version` alone, which
 * was one quarter of the rule.
 */
export const VERSION_SEPARATOR = "/";

/** The four versions an audit body's `policy_version` column carries. */
export interface PolicyVersions {
  /** `RetentionPolicy.version`, the store's. */
  retention: string;
  /** `Policy.version`, tagging's. */
  tagging: string;
  /** `Calibration.version`, tagging's. */
  calibration: string;
  /** `BriefPolicy.version`, the engine's. */
  brief: string;
}

/** R26's fixed order, declared once so the join and the tests read it from here. */
const ORDER = ["retention", "tagging", "calibration", "brief"] as const;

/**
 * The composite `policy_version` for an audit body: four versions in R26's fixed
 * order, joined by `/`, with every component refused if it could make the result
 * unsplittable.
 *
 * WHY THE REFUSAL LIVES HERE. R26 fixes the format and says no component may
 * contain the separator. Task 1 gated that for `BriefPolicy.version` and review
 * then measured the other three: `assertRetentionPolicy({version:
 * "retention/v1"})`, `assertPolicy({version: "policy/v1"})` and
 * `assertCalibration({version: "calibration/v1"})` are all ACCEPTED, and
 * `AuditChain.append` took the malformed composite unparsed — so an audit row
 * would have carried a string nothing could split back into four, and the
 * champion-challenger key would have become unreadable at exactly the moment
 * someone versioned a policy with a path-like name.
 *
 * Those three packages are not the engine's to constrain: each version is its own
 * package's, and each may legitimately hold whatever that package admits. The
 * engine is the only thing that JOINS them, so the join is the one place the rule
 * can be enforced without reaching into three other packages' values.
 *
 * Blank and padded components are refused for the same reason `BriefPolicy`
 * refuses them: a result that names nothing is not a version, and a padded one
 * splits back into a padded field.
 */
export function compositePolicyVersion(versions: PolicyVersions): string {
  for (const component of ORDER) {
    const value = versions[component];
    if (value.trim().length === 0) {
      throw new RangeError(`policyVersion.${component} must not be blank`);
    }
    if (value !== value.trim()) {
      throw new RangeError(
        `policyVersion.${component} must not be padded, got ${JSON.stringify(value)}`,
      );
    }
    if (value.includes(VERSION_SEPARATOR)) {
      throw new RangeError(
        `policyVersion.${component} must not contain the composite separator ` +
          `${VERSION_SEPARATOR}, got ${value}: the four versions are joined as ` +
          `${ORDER.join(VERSION_SEPARATOR)} into one column and must split back into four`,
      );
    }
  }
  return ORDER.map((c) => versions[c]).join(VERSION_SEPARATOR);
}
