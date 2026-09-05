-- The whole validated observation is stored as one encrypted blob, with a few
-- derived columns beside it for querying. Reading decrypts the blob and
-- re-parses it through the schema, so the round trip proves the stored form
-- and the schema agree rather than proving a hand-written mapper is its own
-- inverse.
--
-- dated_at comes from datedAt() in @nonametrust/schema and is null for a
-- state, so this package reaches an observation's dates through that one
-- function and needs no exemption in gates/single-date-reader.test.ts. That
-- gate scans TypeScript only, which is why this SQL comment may name the
-- fields plainly while the TypeScript beside it may not: the gate matches
-- the names inside comments and string literals as well as in code.
--
-- The unique constraint on the key is named because the repository matches on
-- that name: a unique violation on it is the one insert failure that means
-- "a concurrent writer stored this first", and every other failure is a
-- failure. Postgres would name it observation_idempotency_key_key on its own,
-- but a name the code depends on is written down, not inferred.
create table observation (
  observation_id     uuid primary key,
  idempotency_key    text collate "C" not null,
  namespace_id       uuid not null references namespace (namespace_id),
  channel            text not null,
  kind               text not null,
  evidence_kind      text not null check (evidence_kind in ('event','state')),
  dated_at           timestamptz,
  ingested_at        timestamptz not null,
  payload_nonce      bytea not null,
  payload_tag        bytea not null,
  payload_ciphertext bytea not null,
  constraint observation_idempotency unique (idempotency_key),
  -- The invariant in both directions, as two constraints so a violation names
  -- the direction that failed. A state with a date is the study's S3 defect:
  -- a standing condition credited to every time window. An event without one
  -- is the same fault mirrored: evidence that happened at no time, which no
  -- window can place and no decay can age. The repository derives both
  -- columns from one parsed object and cannot write either row; these refuse
  -- them from any other writer.
  constraint observation_state_is_undated
    check (evidence_kind = 'event' or dated_at is null),
  constraint observation_event_is_dated
    check (evidence_kind = 'state' or dated_at is not null)
);

create index observation_by_namespace on observation (namespace_id, dated_at desc);

-- Append-only, held by the database.
--
-- A rewrite rule of the DO INSTEAD NOTHING form is deliberately not used: it
-- swallows the write silently, which turns a loud bug into a quiet one. This
-- raises, and the application maps NNT01 to AppendOnlyViolation.
--
-- The second line of defence named in the design is revoking UPDATE and DELETE
-- from the deployed application role. That belongs to role setup, not to this
-- migration, and the test cluster runs as the owner so it cannot be exercised
-- here. The trigger is the tested half; say so in the ledger.
create function observation_append_only() returns trigger language plpgsql as $$
begin
  raise exception using
    errcode = 'NNT01',
    message = 'observation is append-only: ' || tg_op || ' is refused';
end
$$;

create trigger observation_no_update
  before update or delete on observation
  for each row execute function observation_append_only();
