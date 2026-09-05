-- The audit chain: one row per decision, each hashed over the one before it,
-- so that anyone holding the table can establish that no stored decision was
-- rewritten after the fact.
--
-- Two halves hold this, and the boundary between them is deliberate. The
-- database holds linkage and hash integrity, below: a new row follows the
-- current head and its hash is the hash of its own canonical form. The
-- verifier in src/audit/chain.ts holds fidelity: that `canonical` is a
-- faithful rendering of the row's own fields. Re-deriving a canonical JSON
-- form here, in plpgsql, would make the chain's meaning depend on a Postgres
-- version's jsonb rendering staying byte-identical, and a chain that must
-- verify in a year cannot rest on that. So each half is held where it can be
-- held, and neither is claimed to be the other.
create table audit_entry (
  seq            bigint generated always as identity primary key,
  occurred_at    timestamptz not null,
  policy_version text not null,
  kind           text not null,
  body           jsonb not null,
  -- The exact string that was hashed. It is stored rather than recomputed
  -- because a chain that must verify in a year cannot rest on a Postgres
  -- version's jsonb rendering staying byte-identical.
  canonical      text not null,
  prev_sha256    bytea not null,
  entry_sha256   bytea not null unique,
  -- The verifier re-renders occurred_at as ISO 8601 with milliseconds, which
  -- is all a JavaScript Date carries. A row whose instant had microseconds
  -- could never be re-derived to its own canonical form, and would be
  -- reported broken at the first audit. Refusing it at the write is cheaper
  -- than finding it then.
  constraint audit_entry_occurred_at_millis
    check (occurred_at = date_trunc('milliseconds', occurred_at))
);

-- A day's seal: the chain head as of that day's close, HMAC'd under a key
-- derived from the master key, so a history rewritten and re-chained without
-- that key does not match its seals. The nightly job that calls sealDay is a
-- later milestone; the table and the function land here.
create table audit_day (
  day             date primary key,
  terminal_seq    bigint not null references audit_entry (seq),
  terminal_sha256 bytea not null,
  hmac            bytea not null,
  sealed_at       timestamptz not null
);

-- Held on every insert: the row follows the current head, and its hash is
-- sha256 over its predecessor's hash and its own canonical form. The hash is
-- recomputed here with the built-in sha256 over the same bytes the writer
-- hashed in Node, so the two implementations check each other at the insert
-- rather than one trusting the other; a divergence between them is refused
-- now, not discovered at audit time.
--
-- The advisory lock is transaction-scoped. Taken at the trigger's start, it
-- is held until the inserting transaction commits or rolls back, so a second
-- writer's trigger cannot read the head until the first row is either
-- visible or gone. Without it two concurrent appends would both read the
-- same predecessor, both pass this check, and fork the chain into two rows
-- claiming the same prev_sha256. The trigger function is volatile, so the
-- select below takes a fresh snapshot once the lock is granted and sees a
-- row the first writer committed meanwhile. A transaction lock, unlike the
-- session lock the migration runner takes on one pinned connection, has no
-- unlock call that could land on the wrong pooled connection: it ends with
-- the transaction and cannot leak.
--
-- new.seq is already assigned when a BEFORE INSERT trigger runs, verified on
-- 17.7, and it was drawn by nextval before the lock above was taken. So the
-- head is read with no filter on seq. A writer that drew N and then queued
-- behind a transaction already holding the lock, which drew N+1 and
-- committed following the same head, must find N+1 as the head and be
-- refused. Filtered to `seq < N`, it would find the old head, pass, and two
-- committed rows would claim one predecessor: a permanent linkage break at
-- N+1 that no verifier could tell from a tamper. A BEFORE ROW trigger cannot
-- see its own row and can see the rows inserted earlier in its own
-- statement, verified on 17.7 with a two-row insert whose second row
-- followed its first; that is the visibility this wants. The head's sequence
-- must also be below the new row's, so that sequence order is chain order
-- as a property the database holds rather than an accident of scheduling.
create function audit_entry_chain() returns trigger language plpgsql as $$
declare head_seq bigint; prev bytea; expected bytea;
begin
  -- Two concurrent appends would otherwise read the same predecessor and both
  -- claim to follow it. The lock serialises them for the transaction.
  perform pg_advisory_xact_lock(8140202601);

  select seq, entry_sha256 into head_seq, prev from audit_entry order by seq desc limit 1;
  if prev is null then
    prev := decode(repeat('00', 32), 'hex');
  end if;
  if new.prev_sha256 is distinct from prev
     or (head_seq is not null and head_seq >= new.seq) then
    raise exception using
      errcode = 'NNT02',
      message = 'audit entry does not follow the chain head';
  end if;

  expected := sha256(new.prev_sha256 || convert_to(new.canonical, 'UTF8'));
  if new.entry_sha256 is distinct from expected then
    raise exception using
      errcode = 'NNT03',
      message = 'audit entry hash does not match its canonical form';
  end if;
  return new;
end
$$;

create trigger audit_entry_chained
  before insert on audit_entry
  for each row execute function audit_entry_chain();

-- Append-only, held by the database, as observation and permanent_record
-- are. A chain whose rows can be updated in place is not a chain: the hash
-- would still link while the body said something else, which is exactly the
-- rewrite the verifier exists to find, and a DELETE of the head leaves
-- nothing behind it to disagree. NNT01 is shared with the other append-only
-- tables, since it is one concept; the table name is in the message.
--
-- audit_day is under the same function. Without the derived key a seal
-- cannot be forged, but with UPDATE and DELETE open the seals after a
-- rewrite point could be removed and leave a gap where the evidence of when
-- the rewrite happened used to be. With the trigger, removing a seal costs
-- the same privilege as removing a chain row. A re-run of the nightly job
-- over the same head finds its own seal and returns, so nothing legitimate
-- ever needs to write a seal twice.
create function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception using
    errcode = 'NNT01',
    message = tg_table_name || ' is append-only: ' || tg_op || ' is refused';
end
$$;

create trigger audit_entry_no_rewrite
  before update or delete on audit_entry
  for each row execute function audit_append_only();

create trigger audit_day_no_rewrite
  before update or delete on audit_day
  for each row execute function audit_append_only();
