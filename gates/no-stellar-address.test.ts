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
//
// There is no boundary on either side, on purpose. The first version used \b,
// and an underscore is a word character, so `ADDR_G...` slipped past it, as did
// a key with a letter glued to its end. A lookaround excluding the base32
// alphabet fixes the underscore but not the letter, because every letter is in
// the alphabet: `G...a` can never be caught by a boundary that refuses letters.
// A key that leaks is a leak whatever sits next to it, so the shape is matched
// wherever it occurs. A key is also caught lowercased, since a lowercased key
// is still the key. Each case is matched as a whole, all upper or all lower,
// rather than with the `i` flag: a mixed-case run is not a key anyone
// lowercased, and admitting it would let a base64 digest in the lockfile trip
// the gate by chance, while a single-case run of 56 inside base64 is not a
// realistic accident. Proven against a keypair generated at run time in five
// forms, bare, underscore-prefixed, letter-suffixed, letter-prefixed and
// lowercased; see the M0 final fix report.

const root = fileURLToPath(new URL("../", import.meta.url));
const strkey = /G[A-Z2-7]{55}|M[A-Z2-7]{68}|g[a-z2-7]{55}|m[a-z2-7]{68}/;

// Paths come from the index, content from the working tree. So a staged file
// is scanned before it is committed and nothing gitignored is ever listed, but
// an address staged and then scrubbed locally passes here; CI, running on the
// committed tree, is what catches that one.
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
