import { describe, it, expect } from "vitest";
import { CHANNELS, channelSchema, evidenceKindSchema } from "./channel.js";

describe("channels", () => {
  it("carries exactly the seven agreed channels", () => {
    expect([...CHANNELS]).toEqual([
      "address_integrity",
      "latency",
      "price",
      "protocol",
      "volume",
      "cluster_proximity",
      "content",
    ]);
  });

  it("rejects a channel that is not on the list", () => {
    expect(channelSchema.safeParse("memo").success).toBe(false);
  });

  it("accepts only event and state as evidence kinds", () => {
    expect(evidenceKindSchema.safeParse("event").success).toBe(true);
    expect(evidenceKindSchema.safeParse("state").success).toBe(true);
    expect(evidenceKindSchema.safeParse("fact").success).toBe(false);
  });
});
