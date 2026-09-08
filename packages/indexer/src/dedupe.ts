import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Deduplication is a correctness property: a duplicated trace makes the
 * tagging pipeline believe the evidence is twice as strong. Within a run the
 * key set catches a repeat, which is a defect (spec 5.6) and fails the run.
 * Across runs the delivery test compares two files' key sets and expects
 * both differences empty.
 */
export class KeySet {
  private readonly set = new Set<string>();
  add(key: string): boolean {
    if (this.set.has(key)) return false;
    this.set.add(key);
    return true;
  }
  has(key: string): boolean {
    return this.set.has(key);
  }
  size(): number {
    return this.set.size;
  }
  keys(): string[] {
    return [...this.set];
  }
}

export async function readKeys(ndjsonPath: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const rl = createInterface({ input: createReadStream(ndjsonPath, "utf8"), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as { idempotencyKey?: unknown };
    if (typeof parsed.idempotencyKey !== "string") {
      throw new Error(`${ndjsonPath} line ${n}: no idempotencyKey; not a validated observation`);
    }
    keys.add(parsed.idempotencyKey);
  }
  return keys;
}

export function compareKeys(previous: Set<string>, current: Set<string>): { onlyInPrevious: string[]; onlyInCurrent: string[] } {
  return {
    onlyInPrevious: [...previous].filter((k) => !current.has(k)).sort(),
    onlyInCurrent: [...current].filter((k) => !previous.has(k)).sort(),
  };
}
