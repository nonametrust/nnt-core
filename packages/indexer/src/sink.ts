import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import type { Network } from "./mapper/context.js";

/** One file per backfill run, named by what it covers (contract section 1). */
export function outputFileName(network: Network, fromIso: string, toIso: string): string {
  const day = (iso: string) => iso.slice(0, 10);
  return `${network.replace(":", "-")}_${day(fromIso)}_${day(toIso)}.ndjson`;
}

/**
 * Written by `backfill` as records are mapped; `close()` waits for the
 * underlying stream to flush and reports the total line count. Opened with
 * `append: true` (see `OpenSinkOptions`) when a run resumes, so the lines an
 * interrupted run already wrote survive; opened without it (the default,
 * `--force`) the file starts empty.
 */
export interface Sink {
  write(line: object): void;
  close(): Promise<{ lines: number; path: string }>;
}

export interface OpenSinkOptions {
  /**
   * When true, an existing file at `path` is opened in append mode ("a") so
   * that a resumed run keeps the lines a previous, interrupted run already
   * wrote instead of truncating them. Default false (flag "w", as before).
   */
  append?: boolean;
  /**
   * A seam for tests: overrides the real file stream `openSink` would
   * otherwise open, so a test can substitute a writable that fails, to prove
   * a stream error fails `close()` instead of crashing the process.
   */
  createStream?: (p: string) => Writable;
}

export function openSink(path: string, options: OpenSinkOptions = {}): Sink {
  mkdirSync(dirname(path), { recursive: true });
  const stream = options.createStream
    ? options.createStream(path)
    : createWriteStream(path, { encoding: "utf8", flags: options.append ? "a" : "w" });
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
