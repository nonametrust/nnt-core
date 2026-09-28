import {
  ConstraintViolation,
  type AuditEntryInput,
  type Clock,
  type RecordTriggerEvent,
} from "@nonametrust/store";
import { brief, type BriefInput, type BriefOutput, type BriefPolicies, type BriefReads } from "./brief.js";
import type { Composed } from "./compose.js";
import type { IdSource } from "./ids.js";
import type { RiskTier } from "./audit-body.js";
import type { Related } from "./relatedness.js";

/**
 * The writes a brief performs, and nothing else.
 *
 * Narrow for the same reason `BriefReads` is: the wrapper is the only thing in the
 * brief path holding a writer, and a port with two methods says exactly which two
 * writes a brief may make. It also makes the retry and inconsistency rules below
 * testable without constructing a repository, which `compose-gate.test.ts` refuses
 * outside the composition root.
 */
export interface BriefWrites {
  record(input: RecordTriggerEvent): Promise<unknown>;
  append(input: AuditEntryInput): Promise<unknown>;
}

/** Everything the wrapper needs. Built from a composition by `briefDeps`. */
export interface BriefDeps {
  readonly reads: BriefReads;
  readonly writes: BriefWrites;
  /** The composition's clock. `at` is read from it, once per brief. */
  readonly clock: Clock;
  readonly ids: IdSource;
}

/**
 * What a caller asks for.
 *
 * **IT HAS NO `at` AND NO IDS**, and that is the rule rather than an omission. `at`
 * is an input to the CORE, which is what makes replay possible and therefore makes
 * it plantable: measured with `at = now - 3d`, `TriggerEventRepository.record`
 * bounds only the FUTURE (R34) and `AuditChain.append` stamps its own `occurredAt`,
 * so the trigger landed at day 8 and the audit row at day 11 with no error at all.
 *
 * The rule that closes it is structural, not a comparison: the replay entry point
 * is the core, which is handed a read-only port and cannot write, and the only
 * thing that can write takes its instant from the clock.
 */
export interface BriefRequest {
  readonly intent: Related;
  readonly observationId: string;
  readonly amount: number;
  readonly unit: string;
  readonly riskTier: RiskTier;
  readonly ownTagIds: readonly string[];
  readonly surprise: number | null;
  readonly policies: BriefPolicies;
}

/**
 * A trigger is committed and its chain entry is not.
 *
 * R24 rules this for ingest -- a committed write with no chain entry is a NAMED
 * inconsistency and not a rollback -- and the ledger extends it to the brief
 * verbatim. There is nothing to roll back even in principle: `record` and `append`
 * are separate statements, and `AuditChain.append` refuses to run inside a
 * transaction, so the two cannot be made atomic by wrapping them.
 */
export class AuditEntryMissing extends Error {}

/**
 * The two constraints a repeat of one `trigger_id` can violate.
 *
 * BOTH, because which one Postgres reports is not something this code should
 * depend on: `trigger_id` is the primary key AND half of
 * `trigger_event_in_namespace unique (trigger_id, namespace_id)`, and index order
 * decides which fires. The store's own docstring names the primary key; this admits
 * either, since both mean the row is already there.
 */
const TRIGGER_ID_TAKEN: ReadonlySet<string> = new Set([
  "trigger_event_pkey",
  "trigger_event_in_namespace",
]);

/**
 * Whether this failure means the row this call was trying to write is already
 * there.
 *
 * ONLY a 23505, and only on a constraint over `trigger_id`. A 23503 (foreign key)
 * or 23514 (check) on the same table means the row was REFUSED, not that it landed,
 * and a `Deadlocked` is retryable under R7 -- reading either as "landed" would turn
 * a refusal into a brief that silently recorded nothing.
 *
 * WHAT THIS CANNOT TELL, stated because the store says so: the same id with
 * DIFFERENT contents raises the same 23505 on the same constraint as an identical
 * retry. So "landed" means "a row with this id exists", not "a row with these
 * contents exists".
 *
 * AND WHERE IT IS REACHABLE FROM. Not through `runBrief`, which mints a fresh
 * `triggerId` on every call -- a retry through this entry point is a new brief with
 * new ids, and the ledger records that two briefs on one intent writing two
 * candidate triggers is CORRECT, each being its own decision citing the same
 * intent. The branch is for a caller that carries an id across a retry, which is
 * Task 8's path, and it is held here by the tests rather than left for Task 8 to
 * discover.
 */
function triggerAlreadyLanded(e: unknown): boolean {
  return (
    e instanceof ConstraintViolation &&
    e.sqlstate === "23505" &&
    e.constraint !== null &&
    TRIGGER_ID_TAKEN.has(e.constraint)
  );
}

/** The read and write ports of one composition. */
export function briefDeps(composed: Composed, ids: IdSource): BriefDeps {
  return {
    reads: {
      readClear: (observationId: string) => composed.observations.readClear(observationId),
      listLive: (namespaceId: string) => composed.tags.listLive(namespaceId),
    },
    writes: {
      record: (input: RecordTriggerEvent) => composed.triggers.record(input),
      append: (input: AuditEntryInput) => composed.audit.append(input),
    },
    clock: composed.clock,
    ids,
  };
}

/**
 * The supported entry point: read the instant, mint the ids, decide, perform.
 *
 * The core decides and performs nothing; this performs and decides nothing. That
 * split is what R1's replay claim rests on, and it is the reason the core takes
 * `at`, `briefId` and `triggerId` as arguments instead of reaching for them.
 *
 * THE ORDER IS TRIGGER THEN CHAIN ENTRY, and it is the order the core returns them
 * in. It matters on failure rather than on success: a chain entry appended before
 * the trigger would describe a decision whose evidence row does not exist yet,
 * while a trigger recorded first and then a failed append is a row that exists
 * without its entry -- which R24 names rather than hides.
 */
export async function runBrief(deps: BriefDeps, request: BriefRequest): Promise<BriefOutput> {
  // ONE read of the clock per brief, so the trigger's `at` and the body's `at` are
  // the same instant rather than two instants a slow brief pulls apart.
  const at = deps.clock.now();
  // Both minted unconditionally, so the sequence does not depend on the outcome. An
  // id sequence that skipped whenever a brief found no surprise would make two runs
  // over different corpora impossible to line up.
  const briefId = deps.ids.next();
  const triggerId = deps.ids.next();

  const input: BriefInput = {
    at,
    briefId,
    triggerId,
    intent: request.intent,
    observationId: request.observationId,
    amount: request.amount,
    unit: request.unit,
    riskTier: request.riskTier,
    ownTagIds: request.ownTagIds,
    surprise: request.surprise,
    policies: request.policies,
  };

  const out = await brief(input, deps.reads);

  let triggerRecorded = false;
  if (out.effects.trigger !== null) {
    try {
      await deps.writes.record(out.effects.trigger);
      triggerRecorded = true;
    } catch (e) {
      if (!triggerAlreadyLanded(e)) throw e;
      // The row is there, written by the attempt this one is a retry of, so the
      // chain entry is still owed.
      triggerRecorded = true;
    }
  }

  try {
    await deps.writes.append(out.effects.audit);
  } catch (cause) {
    if (!triggerRecorded) throw cause;
    throw new AuditEntryMissing(
      `trigger ${triggerId} is recorded and brief ${briefId} has no chain entry: ` +
        `the write is committed and cannot be rolled back, so this is a named ` +
        `inconsistency rather than a failure that undid itself`,
      { cause },
    );
  }

  return out;
}
