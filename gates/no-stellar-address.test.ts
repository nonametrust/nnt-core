import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// No tracked file in this repository may contain a Stellar account id. The
// study this engine comes from shipped five real, checksum-valid addresses in
// fixtures its README called synthetic, and the artefacts behind this project
// identify defrauded accounts. The repository goes public at the v0 tag, so the
// gate sits at the root and covers every tracked file rather than one package:
// a second package or a root document is scanned the day it is added.
//
// The gate rejects anything shaped like a StrKey account (G + 55) or muxed
// account (M + 68) over the base32 alphabet, checksum-valid or not, so a
// synthetic identifier has to be obviously synthetic: short, like GOLDADDRESS.
// A test that needs a real-shaped key generates one at run time and never
// writes it to a file.

const root = fileURLToPath(new URL("../", import.meta.url));
const strkey = /\b(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})\b/;

// The index rather than the working tree: a file that has been `git add`ed is
// scanned before it is committed, and nothing gitignored is ever listed.
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0);
}

describe("tracked files", () => {
  // The sibling repository's gate reported green the day it was added, because
  // it enumerated tracked files while not yet tracked itself and so never
  // scanned its own file. This gate vouches for nothing until it can see
  // itself in the list.
  it("include this gate, so it cannot report green while untracked", () => {
    const self = relative(root, fileURLToPath(import.meta.url));
    expect(trackedFiles(), `${self} is not tracked; git add it before trusting this gate`)
      .toContain(self);
  });

  it("contain no Stellar-shaped account id", () => {
    const offenders: string[] = [];
    for (const rel of trackedFiles()) {
      const file = join(root, rel);
      // stat follows a symlink. A tracked path that is not a file (a symlink
      // to a directory) has no lines to scan; a tracked path missing from
      // the working tree throws, which is the safe direction.
      if (!statSync(file).isFile()) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (strkey.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "these lines contain a Stellar-shaped address:\n" + offenders.join("\n"))
      .toEqual([]);
  });
});
