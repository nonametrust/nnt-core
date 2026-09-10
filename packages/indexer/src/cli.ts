#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { selectAccounts } from "./accounts.js";
import { systemClock } from "./clock.js";
import { Counters } from "./counters.js";
import { compareKeys, readKeys } from "./dedupe.js";
import { HorizonClient } from "./horizon/client.js";
import { HorizonReader } from "./horizon/reader.js";
import type { Network } from "./mapper/context.js";
import { renderReport } from "./report.js";
import { backfill } from "./run.js";
import { openSink, outputFileName } from "./sink.js";
import type { AccountId, LedgerRange } from "./source/types.js";
import { loadState, saveState } from "./state.js";

const NETWORKS: Record<Network, string> = {
  "stellar:pubnet": "https://horizon.stellar.org",
  "stellar:testnet": "https://horizon-testnet.stellar.org",
};

const USAGE = `usage:
  nnt-indexer select-accounts --network <stellar:pubnet|stellar:testnet> --from <ISO> --to <ISO> [--n 100] [--max-appearances 50] [--max-retries 8] --out accounts.txt
  nnt-indexer backfill --network <net> --accounts <file> --from <ISO> --to <ISO> [--out-dir out] [--state <file>] [--cache-dir cache] [--force] [--compare <ndjson>] [--min-interval-ms 1250] [--max-retries 8] [--horizon-url <url>]
  nnt-indexer follow --network <net> --accounts <file> [--state <file>] [--cache-dir cache] [--max-retries 8]
  nnt-indexer report --counters <file>`;

interface Io {
  log(s: string): void;
  error(s: string): void;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io = console): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "select-accounts":
        return await cmdSelect(rest, io);
      case "backfill":
        return await cmdBackfill(rest, io, false);
      case "follow":
        return await cmdBackfill(rest, io, true);
      case "report":
        return await cmdReport(rest, io);
      default:
        io.error(USAGE);
        return 2;
    }
  } catch (e) {
    io.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function network(value: string | undefined, io: Io): Network | null {
  if (value === "stellar:pubnet" || value === "stellar:testnet") return value;
  io.error(`--network must be stellar:pubnet or stellar:testnet, received ${String(value)}`);
  return null;
}

function toIsoDay(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${s}`);
  return d.toISOString();
}

const DEFAULT_CLI_MAX_RETRIES = 8;

interface HorizonOpts {
  horizonUrl?: string | undefined;
  cacheDir?: string | undefined;
  minIntervalMs?: string | undefined;
  maxRetries?: string | undefined;
}

function horizon(net: Network, opts: HorizonOpts, counters: Counters): HorizonReader {
  const client = new HorizonClient({
    baseUrl: opts.horizonUrl ?? NETWORKS[net],
    clock: systemClock,
    counters,
    maxRetries: opts.maxRetries !== undefined ? Number(opts.maxRetries) : DEFAULT_CLI_MAX_RETRIES,
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.minIntervalMs ? { minIntervalMs: Number(opts.minIntervalMs) } : {}),
  });
  return new HorizonReader(client, counters);
}

async function cmdSelect(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      network: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      n: { type: "string", default: "100" },
      "max-appearances": { type: "string", default: "50" },
      out: { type: "string" },
      "cache-dir": { type: "string" },
      "horizon-url": { type: "string" },
      "max-retries": { type: "string" },
    },
  });
  const net = network(values.network, io);
  if (!net || !values.from || !values.to || !values.out) {
    io.error(USAGE);
    return 2;
  }
  if (values["max-retries"] !== undefined && !Number.isFinite(Number(values["max-retries"]))) {
    io.error("--max-retries must be a number");
    io.error(USAGE);
    return 2;
  }
  const counters = new Counters();
  const reader = horizon(net, { horizonUrl: values["horizon-url"], cacheDir: values["cache-dir"], maxRetries: values["max-retries"] }, counters);
  const range = await reader.resolveRange(toIsoDay(values.from), toIsoDay(values.to));
  const r = await selectAccounts(reader, { range, n: Number(values.n), maxAppearances: Number(values["max-appearances"]) });
  await writeFile(values.out, r.accounts.join("\n") + "\n", "utf8");
  io.log(
    `selected ${r.accounts.length} of ${r.candidates} candidates over ledgers ${range.from}-${range.to}; excluded ${r.excludedBusy} busy, ${r.excludedMissing} missing; ${counters.get("requests")} requests`,
  );
  return 0;
}

async function cmdBackfill(args: string[], io: Io, follow: boolean): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      network: { type: "string" },
      accounts: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "out-dir": { type: "string", default: "out" },
      state: { type: "string" },
      "cache-dir": { type: "string" },
      force: { type: "boolean", default: false },
      compare: { type: "string" },
      "min-interval-ms": { type: "string" },
      "max-retries": { type: "string" },
      "horizon-url": { type: "string" },
    },
  });
  const net = network(values.network, io);
  if (!net || !values.accounts) {
    io.error(USAGE);
    return 2;
  }
  if (values["min-interval-ms"] !== undefined && !Number.isFinite(Number(values["min-interval-ms"]))) {
    io.error("--min-interval-ms must be a number");
    io.error(USAGE);
    return 2;
  }
  if (values["max-retries"] !== undefined && !Number.isFinite(Number(values["max-retries"]))) {
    io.error("--max-retries must be a number");
    io.error(USAGE);
    return 2;
  }
  const started = systemClock.now().getTime();
  const counters = new Counters();
  const reader = horizon(
    net,
    { horizonUrl: values["horizon-url"], cacheDir: values["cache-dir"], minIntervalMs: values["min-interval-ms"], maxRetries: values["max-retries"] },
    counters,
  );
  const accounts = (await readFile(values.accounts, "utf8")).split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
  const statePath = values.state ?? `state-${net.replace(":", "-")}.json`;
  const state = await loadState(statePath, net);
  const retentionFloor = await reader.retentionFloor();
  state.retentionFloor = retentionFloor;

  let fromIso: string;
  let toIso: string;
  let range: LedgerRange;
  let rangeFor: ((account: AccountId) => LedgerRange) | undefined;
  if (follow) {
    const latest = await reader.latestLedger();
    // Accounts do not share a frontier: a lagging or newly added account
    // must be read from its own last completed ledger, not from the pooled
    // maximum, or ledgers between its frontier and the pool's get skipped.
    rangeFor = (account: AccountId): LedgerRange => {
      const completed = state.accounts[account]?.completed ?? [];
      const lastTo = completed.length > 0 ? Math.max(...completed.map((c) => c.to)) : retentionFloor - 1;
      const from = Math.max(retentionFloor, lastTo + 1);
      if (from > latest) return { from: latest + 1, to: latest };
      return { from, to: latest };
    };
    range = { from: retentionFloor, to: latest };
    fromIso = systemClock.now().toISOString();
    toIso = fromIso;
  } else {
    if (!values.from || !values.to) {
      io.error(USAGE);
      return 2;
    }
    fromIso = toIsoDay(values.from);
    toIso = toIsoDay(values.to);
    range = await reader.resolveRange(fromIso, toIso);
  }

  const name = follow ? `${net.replace(":", "-")}_follow_${range.from}_${range.to}.ndjson` : outputFileName(net, fromIso, toIso);
  const outPath = join(values["out-dir"], name);
  const sink = openSink(outPath, { append: !values.force });
  const result = await backfill({
    reader,
    accounts,
    range,
    ctx: { network: net, producerVersion: "0.1.0" },
    sink,
    state,
    saveState: () => saveState(statePath, state),
    counters,
    clock: systemClock,
    force: values.force,
    ...(rangeFor ? { rangeFor } : {}),
  });
  const { lines } = await sink.close();

  let compare: { previous: string; onlyInPrevious: number; onlyInCurrent: number } | undefined;
  if (values.compare) {
    const cmp = compareKeys(await readKeys(values.compare), await readKeys(outPath));
    compare = { previous: values.compare, onlyInPrevious: cmp.onlyInPrevious.length, onlyInCurrent: cmp.onlyInCurrent.length };
  }
  const meta = {
    network: net,
    fromIso,
    toIso,
    range,
    retentionFloor,
    runDate: systemClock.now().toISOString(),
    accounts: accounts.length,
    wallClockMs: systemClock.now().getTime() - started,
    mode: follow ? ("follow" as const) : ("backfill" as const),
    ...(compare ? { compare } : {}),
  };
  const { json, markdown } = renderReport(counters.snapshot(), meta);
  await writeFile(outPath.replace(/\.ndjson$/, ".counters.json"), json, "utf8");
  await writeFile(outPath.replace(/\.ndjson$/, ".report.md"), markdown, "utf8");
  io.log(
    `${lines} observations -> ${outPath}; ${result.accountsDone} accounts done, ${result.accountsSkipped} skipped; ${counters.totalDrops()} drops; ${counters.get("requests")} requests`,
  );
  if (result.duplicateKeys > 0) {
    io.error(`${result.duplicateKeys} duplicate keys inside one run: a contract question, not a warning`);
    return 1;
  }
  if (compare && (compare.onlyInPrevious > 0 || compare.onlyInCurrent > 0)) {
    io.error("key sets differ between runs");
    return 1;
  }
  return 0;
}

interface SavedCounters {
  meta: Parameters<typeof renderReport>[1];
  counts: Record<string, number>;
  drops: Record<string, number>;
  dropSamples: Record<string, string[]>;
}

async function cmdReport(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, options: { counters: { type: "string" } } });
  if (!values.counters) {
    io.error(USAGE);
    return 2;
  }
  const saved = JSON.parse(await readFile(values.counters, "utf8")) as SavedCounters;
  io.log(renderReport({ counts: saved.counts, drops: saved.drops, dropSamples: saved.dropSamples }, saved.meta).markdown);
  return 0;
}

if (process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
