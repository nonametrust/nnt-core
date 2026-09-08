import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Network } from "./mapper/context.js";

/** One file per backfill run, named by what it covers (contract section 1). */
export function outputFileName(network: Network, fromIso: string, toIso: string): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `${network.replace(":", "-")}_${day(fromIso)}_${day(toIso)}.ndjson`;
}

export interface Sink {
  write(line: object): void;
  close(): Promise<{ lines: number; path: string }>;
}

export function openSink(path: string): Sink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { encoding: "utf8" });
  let lines = 0;
  return {
    write(line) {
      stream.write(JSON.stringify(line) + "\n");
      lines++;
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve({ lines, path })));
      });
    },
  };
}
