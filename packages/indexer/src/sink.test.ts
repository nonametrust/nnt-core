import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterAll } from "vitest";
import { openSink, outputFileName } from "./sink.js";

const dir = mkdtempSync(join(tmpdir(), "nnt-sink-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sink", () => {
  it("names the file after the network and the range", () => {
    expect(outputFileName("stellar:pubnet", "2026-08-01T00:00:00.000Z", "2026-08-31T23:59:59.000Z"))
      .toBe("stellar-pubnet_2026-08-01_2026-08-31.ndjson");
  });

  it("writes one JSON object per line and counts them", async () => {
    const path = join(dir, "out.ndjson");
    const s = openSink(path);
    s.write({ a: 1 });
    s.write({ b: 2 });
    const r = await s.close();
    expect(r).toEqual({ lines: 2, path });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
  });
});
