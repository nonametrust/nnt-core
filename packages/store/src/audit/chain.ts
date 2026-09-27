import { createHash, createHmac } from "node:crypto";
import { sql, type Selectable } from "kysely";
import type { Clock } from "../clock.js";
import type { KeyRing } from "../crypto.js";
import { refuseWriteInsideTransaction, type Db, type Schema } from "../db.js";
import { DayNotClosed, NothingToSeal, SealMismatch, mapPgError } from "../errors.js";

/**
 * The audit chain. Each entry is hashed over the one before it, so that a
 * decision, once stored, cannot be rewritten without every later hash
 * changing, and anyone holding the table can establish that none was.
 *
 * Two halves hold the chain, and the boundary between them is the point.
 *
 * The database holds linkage and hash integrity: the trigger in
 * 0005_audit.sql refuses an insert that does not follow the current head
 * (NNT02) or whose hash is not sha256 over its predecessor's hash and its own
 * canonical form (NNT03), and refuses every UPDATE and DELETE (NNT01).
 *
 * The verifier here holds fidelity: that `canonical` is a faithful rendering
 * of the row's own fields. That check is not in the database on purpose.
 * Re-deriving a canonical JSON form in plpgsql would make the chain's meaning
 * depend on a Postgres version's jsonb rendering staying byte-identical, and
 * a chain that must verify in a year cannot rest on that. So the string that
 * was hashed is stored beside the fields it was rendered from, the database
 * vouches for the hash over that string, and `verify` vouches for the string.
 * Neither half is claimed to be the other.
 *
 * The two hash implementations check each other. `append` computes the hash
 * in Node and the trigger recomputes it in SQL over the same bytes, so a
 * divergence between them is refused at the insert rather than discovered at
 * audit time.
 */

export interface AuditEntryInput {
  policyVersion: string;
  kind: string;
  body: unknown;
}

export interface StoredAuditEntry {
  seq: string;
  occurredAt: Date;
  policyVersion: string;
  kind: string;
  body: unknown;
  canonical: string;
  prevSha256: Buffer;
  entrySha256: Buffer;
}

/**
 * Which of the verifier's four checks a row failed. `linkage`: its
 * prev_sha256 is not the preceding entry's hash, or the genesis constant for
 * the first row. `entry_hash`: its entry_sha256 is not sha256 over its
 * prev_sha256 and its stored canonical string; the database's half. `canonical`:
 * its stored canonical string is not the rendering of its own fields as this
 * side reads them; the verifier's half. `body`: the stored body is not, as a
 * jsonb value, the body inside its canonical string; the verifier's half
 * again, asked of the database, for a rewrite below the precision a
 * JavaScript number carries. The checks run in that order, so a rewritten
 * canonical reports as a hash break and a rewritten body as a fidelity
 * break, and a rewrite only SQL can see is named as such.
 */
export type VerifyFailure = "linkage" | "entry_hash" | "canonical" | "body";

export type VerifyResult = { ok: true } | { ok: false; brokenAt: string; reason: VerifyFailure };

/**
 * The genesis constant: thirty-two zero bytes, the predecessor of the first
 * entry. The trigger carries the same constant as `decode(repeat('00', 32),
 * 'hex')`. A first row that follows anything else is a chain grafted onto a
 * history that was removed, and `verify` names it.
 */
export const GENESIS_SHA256: Buffer = Buffer.alloc(32);

/**
 * The advisory-lock key the trigger takes for the inserting transaction, and
 * the one `append` takes before it reads the head, so writers through this
 * class queue instead of losing. Exported for the reason migrate.ts exports
 * its own: so a test that reasons about the lock asks about this key.
 */
export const CHAIN_LOCK_KEY = 8140202601;

/**
 * The label under which the day seal's HMAC key is derived from the master
 * key. Fixed and documented here, because the seal made under it today must
 * be checkable in a year. A different purpose derives under a different
 * label; this one is never reused.
 */
export const AUDIT_DAY_SEAL_LABEL = "nnt/audit-day-seal/v1";

// The parts of the canonical form are joined on a newline. It cannot occur
// inside any of them: the instant is ISO 8601, the body is JSON in which a
// newline inside a string is escaped, and the two free strings are refused
// if they carry one. Without a separator no part can contain, two entries
// with different fields could share one canonical form, and a chain in
// which that is possible can be forged. NUL, which crypto.ts uses for the
// same job, is not available here: `canonical` is a text column, and
// Postgres text cannot hold a NUL byte.
const SEPARATOR = "\n";

// The first part, so that a change to the layout below is a different
// version rather than a silent reinterpretation of every stored string.
const FORM_VERSION = "nnt-audit/1";

const ONE_DAY_MS = 86_400_000;

const COLUMNS = [
  "seq", "occurred_at", "policy_version", "kind", "body", "canonical", "prev_sha256", "entry_sha256",
] as const;

// Rows come back in pages of this many, keyed on seq rather than offset, so
// a table of any size verifies in bounded memory and a page boundary cannot
// skip or repeat a row while another writer appends.
const PAGE = 1000;

/**
 * The exact string that is hashed for an entry. Deterministic and stable:
 * object keys are sorted at every depth, array order is kept because it is
 * meaningful, the instant is rendered one way, and the parts are joined on a
 * separator no part can contain.
 *
 * There is no `seq` in it. The identity column is assigned during the
 * insert, so `append` cannot know it beforehand, and reserving it first
 * would cost a round trip to hash a value the linkage already encodes.
 * `verify` re-derives each row's form from the four fields that are in it.
 */
export function canonicalForm(e: {
  occurredAt: Date;
  policyVersion: string;
  kind: string;
  body: unknown;
}): string {
  return render(e).canonical;
}

function render(e: {
  occurredAt: Date;
  policyVersion: string;
  kind: string;
  body: unknown;
}): { bodyJson: string; canonical: string } {
  if (Number.isNaN(e.occurredAt.getTime())) {
    throw new RangeError("an audit entry's instant is not a valid date");
  }
  for (const [name, value] of [["kind", e.kind], ["policyVersion", e.policyVersion]] as const) {
    if (value.includes(SEPARATOR)) {
      throw new RangeError(`an audit entry's ${name} contains a newline, the canonical form's separator`);
    }
    refuseUnstorable(value, `an audit entry's ${name}`);
  }
  const bodyJson = canonicalJson(e.body);
  if (bodyJson === undefined) {
    throw new RangeError("an audit entry's body has no JSON rendering; there is nothing to store");
  }
  const canonical = [FORM_VERSION, e.occurredAt.toISOString(), e.policyVersion, e.kind, bodyJson]
    .join(SEPARATOR);
  return { bodyJson, canonical };
}

/**
 * JSON with object keys sorted at every depth, and otherwise the semantics
 * of JSON.stringify, because that is what the driver would apply and what
 * jsonb will hold: `toJSON` is honoured, an undefined-valued key is absent,
 * an undefined element is null, negative zero is zero, and a string is
 * escaped so that nothing in it reads as structure. Returns undefined for a
 * value JSON has no rendering of. Departs from JSON.stringify in one place:
 * a number that is not finite is refused rather than written as null, since
 * a decision recorded about NaN and one recorded about null must not share
 * a form.
 *
 * Mirroring the driver matters more than it looks. `verify` re-derives this
 * from the body after Postgres has parsed and rendered it, and every
 * normalisation jsonb applies must already have been applied here, or a
 * faithful row would be reported as a tampered one.
 */
function canonicalJson(value: unknown): string | undefined {
  let v = value;
  if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
    v = (v as { toJSON(): unknown }).toJSON();
  }
  if (v instanceof Number || v instanceof String || v instanceof Boolean) v = v.valueOf();
  switch (typeof v) {
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "boolean":
      return v ? "true" : "false";
    case "string":
      refuseUnstorable(v, "an audit entry's body string");
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v)) {
        throw new RangeError(`an audit entry's body contains ${String(v)}, which JSON cannot carry`);
      }
      return JSON.stringify(v);
    case "bigint":
      throw new RangeError("an audit entry's body contains a bigint, which JSON cannot carry");
    case "object":
      break;
  }
  if (v === null) return "null";
  if (Array.isArray(v)) {
    return `[${v.map((item) => canonicalJson(item) ?? "null").join(",")}]`;
  }
  const record = v as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const rendered = canonicalJson(record[key]);
    if (rendered === undefined) continue;
    refuseUnstorable(key, "an audit entry's body key");
    members.push(`${JSON.stringify(key)}:${rendered}`);
  }
  return `{${members.join(",")}}`;
}

// A high surrogate with no low one after it, or a low one with no high one
// before it.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Two things a JavaScript string can hold that the row cannot: a NUL, which
// neither a text column nor a jsonb string accepts, and a lone surrogate,
// which jsonb refuses and which the wire encoding would otherwise replace
// with U+FFFD, storing a string the writer did not give. Either would come
// back from `append` as the driver's error; the refusal belongs here, as a
// RangeError this package owns, before anything is hashed.
function refuseUnstorable(s: string, what: string): void {
  if (s.includes("\u0000")) {
    throw new RangeError(`${what} contains NUL, which the database cannot store`);
  }
  if (LONE_SURROGATE.test(s)) {
    throw new RangeError(`${what} contains a lone surrogate, which is not a character`);
  }
}

/**
 * sha256 over the predecessor's hash and the canonical string's UTF-8 bytes,
 * the same bytes the trigger hashes as `prev_sha256 || convert_to(canonical,
 * 'UTF8')`. Exported so that a verifier outside this class computes the
 * hash one way.
 */
export function entrySha256(prevSha256: Buffer, canonical: string): Buffer {
  return createHash("sha256").update(prevSha256).update(Buffer.from(canonical, "utf8")).digest();
}

export class AuditChain {
  constructor(
    private readonly db: Db,
    // Public and readonly so a composition root can assert every repository
    // shares one clock -- see `surface.test.ts`. Exposing it is not a check: a
    // reader of one repository still cannot tell whose clock this is.
    readonly clock: Clock,
    private readonly ring: KeyRing,
  ) {}

  /**
   * Appends an entry that follows the current head. The head is read and the
   * row written under the trigger's own advisory lock, taken here first, so
   * two concurrent appends through this class queue and both land rather
   * than one of them losing. The lock is transaction-scoped: it ends with
   * the transaction on the connection that took it, so there is no unlock
   * that could land on another pooled connection and no lock that can
   * outlive the append. The trigger takes it again, which within one
   * transaction is a no-op, and checks the row for itself.
   *
   * The row comes back from `returning`, so what is reported is what was
   * stored, with the sequence the database assigned.
   */
  async append(e: AuditEntryInput): Promise<StoredAuditEntry> {
    refuseWriteInsideTransaction(this.db, "AuditChain.append");
    const occurredAt = this.clock.now();
    const { bodyJson, canonical } = render({
      occurredAt, policyVersion: e.policyVersion, kind: e.kind, body: e.body,
    });
    try {
      return await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(${sql.lit(CHAIN_LOCK_KEY)})`.execute(trx);
        const head = await headOf(trx);
        const prevSha256 = head ? head.entry_sha256 : GENESIS_SHA256;
        const row = await trx
          .insertInto("audit_entry")
          .values({
            occurred_at: occurredAt,
            policy_version: e.policyVersion,
            kind: e.kind,
            body: bodyJson,
            canonical,
            prev_sha256: prevSha256,
            entry_sha256: entrySha256(prevSha256, canonical),
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        return toStored(row);
      });
    } catch (err) {
      throw mapPgError(err) ?? err;
    }
  }

  async head(): Promise<StoredAuditEntry | null> {
    const row = await headOf(this.db);
    return row ? toStored(row) : null;
  }

  /**
   * Walks the table in sequence order and returns the first entry that
   * disagrees with the chain, with which check it failed. Each row is
   * checked for linkage to the one before it, for its hash over its stored
   * canonical string, for that string being the rendering of its own fields,
   * and for its body being, as a jsonb value, the body inside that string;
   * the first two are what the trigger held at the insert, the last two are
   * what only this side can hold.
   *
   * The fourth check is asked of the database, and it is the one place SQL
   * touches the canonical form. jsonb keeps more numeric precision than a
   * JavaScript double, so a rewrite of `0.1` to `0.10000000000000000001`
   * re-derives to the same canonical string here and the third check cannot
   * see it, while a SQL reader can. The comparison is jsonb *equality*, a
   * value comparison that is stable across versions in the way a `::text`
   * rendering is not, so it does not reintroduce the dependency the boundary
   * exists to avoid: nothing here asks Postgres to render JSON, only to say
   * whether two values are the same. The cast is guarded, since a canonical
   * string rewritten into something that is not JSON would otherwise fail
   * the whole page instead of naming its row; the hash check names that row
   * first in any case.
   *
   * An empty table verifies. There is nothing in it to be wrong, and a fresh
   * deployment passes its first audit rather than failing it for having no
   * history. A first row whose predecessor is not the genesis constant is
   * named as the break, since a chain that starts mid-way is one whose
   * beginning was removed.
   *
   * What this walk cannot see: a deleted head. Nothing follows it to
   * disagree. That is what the day seal is for.
   */
  async verify(): Promise<VerifyResult> {
    let prev = GENESIS_SHA256;
    let after: string | null = null;
    for (;;) {
      let query = this.db
        .selectFrom("audit_entry")
        .select([
          ...COLUMNS,
          sql<boolean>`case
            when pg_input_is_valid(split_part(canonical, E'\\n', 5), 'jsonb')
            then body = split_part(canonical, E'\\n', 5)::jsonb
            else false
          end`.as("body_matches"),
        ])
        .orderBy("seq")
        .limit(PAGE);
      if (after !== null) query = query.where("seq", ">", after);
      const rows = await query.execute();
      for (const row of rows) {
        if (!row.prev_sha256.equals(prev)) {
          return { ok: false, brokenAt: row.seq, reason: "linkage" };
        }
        if (!row.entry_sha256.equals(entrySha256(row.prev_sha256, row.canonical))) {
          return { ok: false, brokenAt: row.seq, reason: "entry_hash" };
        }
        const expected = canonicalForm({
          occurredAt: row.occurred_at, policyVersion: row.policy_version, kind: row.kind, body: row.body,
        });
        if (row.canonical !== expected) {
          return { ok: false, brokenAt: row.seq, reason: "canonical" };
        }
        if (!row.body_matches) {
          return { ok: false, brokenAt: row.seq, reason: "body" };
        }
        prev = row.entry_sha256;
        after = row.seq;
      }
      if (rows.length < PAGE) return { ok: true };
    }
  }

  /**
   * Seals a day: records the chain head as of that day's close, in UTC, and
   * an HMAC-SHA256 over the day and that head's hash under the key the seal
   * label derives from the master key. A history rewritten and re-chained
   * without that key does not match its seals, and a head deleted after the
   * seal no longer matches the seal's terminal hash. The day is in the
   * HMAC's input as well as the row, so a seal cannot be moved to another
   * day and still hold.
   *
   * The head as of the close, not the last entry that occurred on the day:
   * a day on which nothing was decided is still a day the chain stood at
   * some head, and a seal for every day is what an auditor walks. The head
   * at close, when a day is first sealed, is the entry with the highest
   * sequence number whose instant precedes the close. That is the tie rule
   * under writer clock skew: an entry with a higher sequence but an earlier
   * instant is under the seal, and one with a lower sequence but a later
   * instant is not; the seal follows the instants the entries themselves
   * carry, which is what the chain hashes over. A day before the first
   * entry has no head to seal and is refused by class.
   *
   * That rule is applied once, at the first seal, and never re-derived
   * against an existing one. The chain trigger makes sequence order the
   * chain order, but nothing makes the instant monotone: it comes from the
   * injected clock, and a wall clock stepped back across midnight, a
   * restored virtual machine or any caller with a fixed clock appends an
   * entry whose instant falls before a sealed day's close. Recomputed, that
   * day's head would move, and every later re-run would raise, permanently,
   * about rows that went in through the live trigger and were never a
   * tamper. The seal states that at the close of a given day the head was a
   * particular entry with a particular hash. A later backdated entry does
   * not falsify that statement.
   *
   * A day that has not closed on the clock is refused. A seal fixes a head
   * that later entries of an open day would contradict, and the table
   * refuses rewrites, so it could not be corrected.
   *
   * Re-running is the normal case for a nightly job, not an error. A day
   * already sealed is checked against the entry it sealed: the row at the
   * stored terminal sequence must still carry the stored terminal hash, and
   * the stored HMAC must still verify over it. When both hold the run
   * returns; when either fails it is SealMismatch, since a sealed entry no
   * longer under its hash, or a seal no longer under its key, is a rewrite,
   * which is the signal the seal exists to give, and it is raised rather
   * than overwritten. Two runs arriving at once both find no seal and both
   * insert; the loser's unique violation is caught once and it re-reads, so
   * it too returns or raises by the same check.
   *
   * This does not verify the chain first. The seal states what the head
   * was; `verify` states that the chain is internally consistent. A seal
   * over a broken chain does not hide the break, and refusing to seal would
   * remove the auditor's means of bounding when the break happened, since
   * the last good seal is that evidence. A walk of the whole table inside
   * every seal would also grow with the table for no gain. The nightly job
   * calls `verify` first and refuses to seal when it fails.
   */
  async sealDay(day: string): Promise<void> {
    const close = dayClose(day);
    if (this.clock.now().getTime() < close.getTime()) {
      throw new DayNotClosed(`${day} has not closed; it cannot be sealed before ${close.toISOString()}`);
    }
    const key = this.ring.deriveKey(AUDIT_DAY_SEAL_LABEL);
    for (let attempt = 0; ; attempt++) {
      const existing = await this.db
        .selectFrom("audit_day")
        .select(["terminal_seq", "terminal_sha256", "hmac"])
        .where(sql<boolean>`day = ${day}::date`)
        .executeTakeFirst();
      if (existing) {
        // Checked against the entry it sealed, not against a recomputed
        // head: see the tie rule above for why a recomputed head is not
        // the seal's statement.
        const sealed = await this.db
          .selectFrom("audit_entry")
          .select(["entry_sha256"])
          .where("seq", "=", existing.terminal_seq)
          .executeTakeFirst();
        const entryStands = sealed !== undefined && sealed.entry_sha256.equals(existing.terminal_sha256);
        const sealVerifies = sealHmac(key, day, existing.terminal_sha256).equals(existing.hmac);
        if (entryStands && sealVerifies) return;
        throw new SealMismatch(
          entryStands
            ? `${day} is sealed, and its seal no longer verifies under the derived key`
            : `${day} is sealed over entry ${existing.terminal_seq}, which no longer carries the hash it was sealed under`,
        );
      }
      const terminal = await this.db
        .selectFrom("audit_entry")
        .select(["seq", "entry_sha256"])
        .where("occurred_at", "<", close)
        .orderBy("seq", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!terminal) {
        throw new NothingToSeal(`nothing had been appended to the audit chain by the close of ${day}`);
      }
      try {
        await this.db
          .insertInto("audit_day")
          .values({
            day,
            terminal_seq: terminal.seq,
            terminal_sha256: terminal.entry_sha256,
            hmac: sealHmac(key, day, terminal.entry_sha256),
            sealed_at: this.clock.now(),
          })
          .execute();
        return;
      } catch (err) {
        // The driver's raw 23505, looked at before any mapping: mapPgError
        // would turn it into ConstraintViolation, and to this loop a
        // duplicate is the race it exists for, not a failure.
        if (attempt > 0 || !isUniqueViolation(err)) throw err;
      }
    }
  }
}

/**
 * HMAC-SHA256 over the day and a terminal hash under the derived seal key.
 * The day is in the input so a seal cannot be moved to another day; the
 * same function makes a seal and checks one, so the two cannot drift.
 */
function sealHmac(key: Buffer, day: string, terminalSha256: Buffer): Buffer {
  return createHmac("sha256", key).update(Buffer.from(day, "utf8")).update(terminalSha256).digest();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

// The instant at which `day`, a calendar date in UTC, ends: the first
// millisecond of the next day. The string must be exactly a date, so that
// "2026-09-07T00:00:00Z" and "yesterday" are refused rather than parsed into
// some day the caller did not name.
function dayClose(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError(`a day to seal is YYYY-MM-DD, got ${JSON.stringify(day)}`);
  }
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) {
    throw new RangeError(`${day} is not a calendar date`);
  }
  return new Date(start.getTime() + ONE_DAY_MS);
}

type Row = Selectable<Schema["audit_entry"]>;

async function headOf(db: Db): Promise<Row | undefined> {
  return db.selectFrom("audit_entry").select(COLUMNS).orderBy("seq", "desc").limit(1).executeTakeFirst();
}

function toStored(row: Row): StoredAuditEntry {
  return {
    seq: row.seq,
    occurredAt: row.occurred_at,
    policyVersion: row.policy_version,
    kind: row.kind,
    body: row.body,
    canonical: row.canonical,
    prevSha256: row.prev_sha256,
    entrySha256: row.entry_sha256,
  };
}
