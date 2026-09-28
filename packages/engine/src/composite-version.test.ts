import { describe, it, expect } from "vitest";
import { POLICY_V0, CALIBRATION_V0 } from "@nonametrust/tagging";
import { RETENTION_V0 } from "@nonametrust/store";
import { BRIEF_POLICY_V0 } from "./policy.js";
import { compositePolicyVersion, VERSION_SEPARATOR } from "./composite-version.js";

// R26: `audit_entry.policy_version` holds ONE column carrying four versions,
// joined as `retention/tagging/calibration/brief`, with no component permitted to
// contain the separator.
//
// THE JOIN WAS UNHELD AND THREE OF FOUR COMPONENTS ACCEPT A SLASH. Measured by
// review: `assertRetentionPolicy({version: "retention/v1"})`,
// `assertPolicy({version: "policy/v1"})` and
// `assertCalibration({version: "calibration/v1"})` are all ACCEPTED -- only
// `assertBriefPolicy` refuses, because Task 1 gated its own quarter. And
// `AuditChain.append` took the malformed composite unparsed, so an audit row would
// have carried a version string nothing could split back into four.
//
// The other three packages are not the engine's to change: retention's version is
// the store's, the tagging policy's and the calibration's are tagging's, and each
// is legitimately free to contain whatever its own package admits. The engine is
// the only place that JOINS them, so the engine is where the refusal belongs.
describe("compositePolicyVersion", () => {
  const shipped = {
    retention: RETENTION_V0.version,
    tagging: POLICY_V0.version,
    calibration: CALIBRATION_V0.version,
    brief: BRIEF_POLICY_V0.version,
  };

  it("joins the four shipped versions in R26's fixed order", () => {
    expect(compositePolicyVersion(shipped)).toBe(
      `${shipped.retention}/${shipped.tagging}/${shipped.calibration}/${shipped.brief}`,
    );
    // The order is the ruling, so it is pinned by name and not only by the join.
    expect(compositePolicyVersion(shipped).split(VERSION_SEPARATOR)).toEqual([
      "retention-v0", "policy-v0", "calibration-v0", "brief-policy-v0",
    ]);
  });

  it("splits back into exactly four components, which is the whole point of the rule", () => {
    // A composite that cannot be split is a champion-challenger key that cannot be
    // read, and the column is one column.
    expect(compositePolicyVersion(shipped).split(VERSION_SEPARATOR)).toHaveLength(4);
  });

  it("refuses EACH component that carries the separator, by name", () => {
    // One plant per component, because a check that names only the field it was
    // written for is a check three components walk past.
    for (const component of ["retention", "tagging", "calibration", "brief"] as const) {
      const bad = { ...shipped, [component]: `${shipped[component]}/v1` };
      expect(() => compositePolicyVersion(bad), component).toThrow(
        new RegExp(`${component}.*separator|separator.*${component}`),
      );
    }
  });

  it("refuses a blank component, because a result that names nothing is not a version", () => {
    for (const component of ["retention", "tagging", "calibration", "brief"] as const) {
      expect(() => compositePolicyVersion({ ...shipped, [component]: "" }), component)
        .toThrow(new RegExp(component));
      expect(() => compositePolicyVersion({ ...shipped, [component]: "   " }), component)
        .toThrow(new RegExp(component));
    }
  });

  it("refuses a padded component, so the composite cannot be split into a padded field", () => {
    expect(() => compositePolicyVersion({ ...shipped, tagging: " policy-v0" }))
      .toThrow(/tagging/);
  });

  it("holds the three OTHER packages' shipped versions to the rule today", () => {
    // Not a claim that they will stay that way -- they are not the engine's to
    // constrain -- but a measurement of the day this was written, so the day one of
    // them gains a slash the failure names which one.
    for (const [name, version] of Object.entries(shipped)) {
      expect(version, `${name} already contains the separator`).not.toContain(VERSION_SEPARATOR);
    }
  });
});
