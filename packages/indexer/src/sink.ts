import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
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

/**
 * `createStream` is a seam for tests: it defaults to a real file stream, but
 * a test can substitute a writable that fails, to prove a stream error fails
 * `close()` instead of crashing the process.
 */
export function openSink(path: string, createStream: (p: string) => Writable = (p) => createWriteStream(p, { encoding: "utf8" })): Sink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createStream(path);
  let lines = 0;
  let failure: Error | undefined;
  stream.on("error", (e: Error) => {
    failure ??= e;
  });
  return {
    write(line) {
      stream.write(JSON.stringify(line) + "\n");
      lines++;
    },
    close() {
      return new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        stream.once("error", (e: Error) => {
          failure ??= e;
          reject(failure);
        });
        stream.end((err?: Error | null) => {
          if (failure) reject(failure);
          else if (err) reject(err);
          else resolve({ lines, path });
        });
      });
    },
  };
}
