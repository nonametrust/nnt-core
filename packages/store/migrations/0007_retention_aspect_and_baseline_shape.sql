-- The storage card: retention as unreadability on a clock, the tag keyed on
-- its aspect, and the two baseline shapes M2's arithmetic decided.
--
-- This file is grown across the tasks of one branch rather than split into
-- 0008, 0009 and so on, and that is deliberate. The card's promise is that
-- M3 opens with nothing on the storage card still open, so everything the
-- card carries lands in one applied step; a reviewer reads the file whole and
-- a deployment applies it whole. Growing it is safe only because it has been
-- applied nowhere: migrate.ts refuses an edited file that a ledger already
-- records (MigrationDrift), so the moment this file is applied anywhere it is
-- frozen like every other.
--
-- Sections, in the order they were grown:
--   1. baseline: the two shapes M2's arithmetic refuses
--   2. tag: the aspect it was always keyed on, retirement, and the guard
--   3. observation: the producer column, and the payload layout that moved
--   4. namespace_key: the month key, its guard, and what expiry may not do

-- Before anything else: this migration moves the byte layout of the payload
-- envelope, and a stored payload is sealed under the layout that was in force
-- when it was written. Adding `producer` and `ingested_at` to that envelope
-- makes every existing ciphertext fail to open, and it would fail to open
-- silently -- at the first read, far from here, as a CiphertextRejected that
-- names a tamper rather than a migration.
--
-- Nothing has been deployed, so today this refusal never fires and the layout
-- is free. It is written anyway, because "nothing is deployed" is a belief
-- about the world and this is the one place that can make it a fact the
-- database checks. Over stored rows the honest answer is a re-encryption,
-- which is a separate migration with a key schedule of its own, not a column
-- added quietly beside them.
do $$
begin
  if exists (select 1 from observation) then
    raise exception
      'migration 0007 re-keys the payload envelope and cannot run over stored observations; re-encrypting them is a separate migration';
  end if;
end $$;

-- === 1. baseline: the two shapes M2's arithmetic refuses =====================
--
-- 0006 landed this table with its own comment saying that "whether m2 is zero
-- when n is zero, and whether median and MAD arrive together, are properties
-- of M2's update and are left to it". M2 decided the second of those, so it
-- comes back to the table, together with the equality between the location
-- estimate and the mean. The first is NOT decided here: the arithmetic does
-- not refuse a zero count beside a positive m2 either, so there is nothing to
-- hold, and inventing a rule the arithmetic does not have would be a decision
-- this card has no authority to make. What the arithmetic refuses, the database must refuse too:
-- otherwise the store can write a row that M3's read path throws on, which is
-- a refusal on the pipeline rather than on an observation, and it surfaces far
-- from the writer that caused it.
--
-- The robust pair arrives together or not at all, and it is present exactly
-- when the counter is not zero. A row with a positive count and an empty pair
-- is the shape 0006's own fixture wrote and M2 now rejects: updated without
-- clipping, it moved a mean by a hundred and sixty thousand against a
-- half-unit bound.
alter table baseline
  add constraint baseline_pair_with_count
  check ((n = 0) = (median_est is null) and (median_est is null) = (mad_est is null));

-- The location estimate equals the mean, exactly. The equality is not a
-- tolerance and must not become one: float8 = float8 in Postgres is the same
-- bitwise-value comparison JavaScript's !== makes on the same two doubles, and
-- -0 = 0 holds on both sides. NaN never reaches here because 0006 refuses it
-- in the column check first.
--
-- A tolerance would admit exactly the row the M2 ledger measured: twenty in
-- the counter, a hundred in the mean and two hundred in the location moves
-- criterion three by 106/21 where its bound is 6/21.
alter table baseline
  add constraint baseline_location_is_mean
  check (median_est is null or median_est = mean);

-- === 2. tag: the aspect it was always keyed on, and retirement ==============
--
-- M2 keys the live tag on (namespace, channel, aspect) and tagReading takes
-- one live tag or none for that triple. The table carried only the channel,
-- so a deviation on one asset would refresh a tag another asset opened,
-- pooling at the tag layer exactly what the aspect vocabulary exists to keep
-- apart. The column is the fix; the unique index is what turns "the
-- arithmetic assumes one live tag per pair" from a promise into a constraint.
-- Added nullable, then made not-null, rather than with a default: the only
-- default that would satisfy the check below is a made-up aspect, and one
-- that does not satisfy it would be a column whose default its own constraint
-- refuses. The table is empty here and `set not null` says so out loud; over
-- rows it would fail rather than invent an aspect for them.
alter table tag add column aspect text;
alter table tag alter column aspect set not null;
alter table tag add constraint tag_aspect_nonempty check (length(aspect) > 0);

-- Retirement is named in the M0 spec, the M1 spec and the repository's own
-- docstring, and existed nowhere. The column lands here because the unique
-- index below is partial on it; the nightly operation that sets it is M4's.
alter table tag add column retired_at timestamptz;

-- Partial, so a retired tag frees the pair rather than blocking it forever.
create unique index tag_one_live_per_pair
  on tag (namespace_id, channel, aspect)
  where retired_at is null;

-- The guard. Every rule here is one M2's arithmetic computes, held against a
-- writer that does not go through it. NNT07 rather than NNT01: this table is
-- meant to be updated, so a refusal here is not an append-only violation and
-- an operator reading the class must not be told that it is. The application
-- maps it to TagAltered.
--
-- The forward-only instant is the load-bearing one. strengthAt reads the
-- decay curve from tagged_at, so a tag moved backward is credited with a
-- future it did not have, and the resulting strength is not wrong by a little.
create function tag_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'NNT07',
      message = 'a tag is never deleted; suppression is accelerated decay and retirement is a column';
  end if;
  if new.tag_id is distinct from old.tag_id
     or new.namespace_id is distinct from old.namespace_id
     or new.observation_id is distinct from old.observation_id
     or new.channel is distinct from old.channel
     or new.aspect is distinct from old.aspect then
    raise exception using
      errcode = 'NNT07',
      message = 'tag identity is fixed: tag_id, namespace_id, observation_id, channel and aspect do not change';
  end if;
  if new.tagged_at < old.tagged_at then
    raise exception using
      errcode = 'NNT07',
      message = 'tagged_at only moves forward: a refresh restamps the tag at the later instant, never at an earlier one';
  end if;
  -- A refresh moves the count by one; a suppression leaves it where it is.
  -- Nothing moves it by two, and nothing moves it down.
  if new.refresh_count not in (old.refresh_count, old.refresh_count + 1) then
    raise exception using
      errcode = 'NNT07',
      message = 'refresh_count stands or rises by one: a refresh is one repeat and a suppression is none';
  end if;
  if old.saturation_state = 'saturated' and new.saturation_state <> 'saturated' then
    raise exception using
      errcode = 'NNT07',
      message = 'saturation is one-way: a saturated tag does not return to open';
  end if;
  if old.retired_at is not null and new.retired_at is distinct from old.retired_at then
    raise exception using
      errcode = 'NNT07',
      message = 'retirement is one-way: the instant does not move and a retired tag is not revived';
  end if;
  -- Retirement takes a tag out of the live set; a refresh puts strength back
  -- into it. A refreshed retired tag is a row whose strength moves while
  -- nothing can see it, and whose pair another tag has since reopened.
  if old.retired_at is not null
     and (new.g0 is distinct from old.g0
          or new.tagged_at is distinct from old.tagged_at
          or new.refresh_count is distinct from old.refresh_count
          or new.saturation_state is distinct from old.saturation_state) then
    raise exception using
      errcode = 'NNT07',
      message = 'a retired tag is not refreshed: strength does not move after retirement';
  end if;
  -- The rule above reads old.retired_at, so one statement that retires and
  -- refreshes at once passes it: the row was live when the statement began.
  -- Retirement is M4's nightly operation and writes nothing but the instant.
  if old.retired_at is null and new.retired_at is not null
     and (new.g0 is distinct from old.g0
          or new.tagged_at is distinct from old.tagged_at
          or new.refresh_count is distinct from old.refresh_count
          or new.saturation_state is distinct from old.saturation_state) then
    raise exception using
      errcode = 'NNT07',
      message = 'one statement retires and refreshes: retirement writes its instant and nothing else';
  end if;
  if new.retired_at is not null and new.retired_at < new.tagged_at then
    raise exception using
      errcode = 'NNT07',
      message = 'retired_at is not before tagged_at: a tag cannot retire before it was opened';
  end if;
  -- The repository takes the greater of the two factors and its own test
  -- calls lowering one "a way to revive evidence that nothing in the design
  -- asks for". Held only there it was a promise; the house rule is that an
  -- invariant lives in the database.
  if new.suppression_factor < old.suppression_factor then
    raise exception using
      errcode = 'NNT07',
      message = 'suppression only rises: lowering the factor revives evidence the design never revives';
  end if;
  return new;
end
$$;

create trigger tag_guard_trigger
  before update or delete on tag
  for each row execute function tag_guard();


-- === 3. observation: the producer column, and the payload layout that moved ==
--
-- `producer` is the bare name of the component that delivered the
-- observation, and it is derived by `append` from the source the observation
-- carries -- never passed in beside it. That is the rule the table has held
-- since 0002: every column beside the payload comes from one parsed object,
-- so the columns and the evidence cannot disagree.
--
-- It becomes a column of its own for two reasons. The read path has to
-- rebuild the payload envelope from the row alone, and the envelope now binds
-- the producer, so the value must be on the row. And the per-producer cap
-- counts rows by it, which a value buried inside the ciphertext could not do.
--
-- The shape is the schema's own (sourceSchema.producer in @nonametrust/schema:
-- `.min(1).max(64)` and lowercase alphanumeric segments joined by single
-- hyphens, no leading, trailing or doubled hyphen). It is restated here
-- rather than referenced because a check constraint cannot import one, and it
-- is restated in FULL rather than loosened: a check that admits more than the
-- schema does is a check that lets a raw writer store what the repository
-- never could. That duplication is the cost, and it is the two-shapes rule M1
-- set -- the TypeScript refuses first and names the class, the table refuses
-- everyone.
--
-- The length bound is half of that and was missed on the first pass: the
-- regex matches a name of any length, so the check admitted a 65-character
-- producer while the schema refused it, and the paragraph above said
-- otherwise. `min(1)` needs no clause of its own -- the regex requires at
-- least one segment of at least one character -- but `max(64)` does.
--
-- The not-null is a third rule and not implied by either: `producer ~ '...'`
-- evaluates to NULL, not false, for a null producer, and a check constraint
-- passes on NULL.
alter table observation
  add column producer text not null
  constraint observation_producer_shape
  check (producer ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(producer) <= 64);


-- === 4. namespace_key: the month key, its guard, and what expiry may not do ==
--
-- Retention in this design is unreadability on a clock, not deletion. A
-- payload is sealed under a key per (namespace, calendar month); that month
-- key is wrapped under the namespace's own key, so there are two levels and
-- the outer one is the namespace. Shredding a month key makes that month
-- unreadable while every row, foreign key, audit entry and day seal stays
-- exactly where it is and stays verifiable.
--
-- The primary key is the pair, which is also what the wrap is bound to. That
-- binding is what stops a shred being evaded by a row copy: a wrapped key
-- moved into another namespace's row, or into another period's row of the
-- same namespace, no longer authenticates. Without it, copying a live key
-- out before the shred leaves a working copy behind, and shredding is the
-- only erasure this ledger has.
--
-- expires_at is written ONCE, at mint, from the period and the policy in
-- force (R2). Two reasons it is a column rather than a computation. The
-- database cannot hold a policy number it does not have, and putting
-- graceDays into SQL would give that number a second home that drifts from
-- retention.ts silently. And a guard that read now() would break the
-- injected-clock rule that every simulated-day test in this package depends
-- on; held against the row's own value, the early-shred refusal needs no
-- wall clock at all.
--
-- What that costs, stated plainly because R2's own note was one line: a later
-- policy that SHORTENS the grace does not shorten months already minted. The
-- sanctioned path is a migration that disables this trigger, updates
-- expires_at on the affected rows, and re-enables it -- the same shape the
-- tests use, and the same shape M2 chose for lowering the saturation ceiling
-- ("a policy change becomes a data migration, loudly rather than silently").
--
-- Three things that migration must do, all measured on 17.7 rather than
-- assumed.
--
-- ALL THREE STATEMENTS IN ONE TRANSACTION. This is the one that matters and
-- an earlier version of this comment did not say it. `alter table ... disable
-- trigger` is transactional, so inside a transaction it takes
-- ShareRowExclusiveLock and every other writer blocks until commit -- the
-- guard is never off for anyone else, and a rollback restores it. Run as
-- three statements in psql autocommit it is the opposite: the trigger is off
-- for EVERY session in between, and a concurrent UPDATE of expires_at from an
-- unrelated backend succeeds and is never refused afterwards. That was
-- measured, not feared. migrate.ts already wraps each file in a transaction,
-- so a migration file is safe by construction; a hand-run sequence is not.
--
-- Scope it `where shredded_at is null`: with the trigger off, lengthening a
-- grace over an already-expired row is refused by
-- namespace_key_shred_not_early and aborts the whole statement, and
-- SHORTENING one is admitted, which would rewrite the basis of a compliance
-- record that has already been acted on.
--
-- Set a lock_timeout. The ALTER queues behind every in-flight writer and
-- every writer queues behind it; without a timeout it waits indefinitely,
-- with one it fails cleanly as 55P03.
-- Without that sentence written down, the guard below reads as "expiry can
-- never change", which is not what is meant.
--
-- Note the asymmetry that makes fixing expiry at mint safe: a shred cannot be
-- undone, so re-deriving expiry at each sweep could only ever matter in the
-- shortening direction. Lengthening a grace cannot bring back a month that
-- has already gone.
create table namespace_key (
  namespace_id uuid not null references namespace (namespace_id),
  -- The first day of a UTC calendar month. Always read back as text: the
  -- driver parses a `date` at LOCAL midnight, so east of UTC a round-tripped
  -- 2026-09-01 returns as 2026-08-31T21:00Z and looks up the wrong month's
  -- key, silently. The check makes the column's own shape a fact.
  period date not null,
  -- Null once the month is expired, exactly as namespace.data_key_wrapped is
  -- null once the counterparty space is erased. One mechanism, two levels.
  key_wrapped bytea,
  expires_at timestamptz not null,
  shredded_at timestamptz,
  created_at timestamptz not null,
  primary key (namespace_id, period),
  constraint namespace_key_shred_consistent
    check ((key_wrapped is null) = (shredded_at is not null)),
  -- 29 is the wrapped-key header crypto.ts writes: one version byte, a
  -- twelve-byte nonce, a sixteen-byte tag. Anything that short holds no key,
  -- and without this an empty bytea would count as live above. The same
  -- number, from the same layout, as namespace_key_present on namespace --
  -- which is why wrapUnder was lifted out of the ring rather than copied.
  constraint namespace_key_present
    check (key_wrapped is null or octet_length(key_wrapped) > 29),
  -- A month cannot expire before it has closed, where "closed" means the UTC
  -- close and not the server's.
  --
  -- An earlier version of this comment said Postgres refuses a bare
  -- timestamptz comparison in a check because it is only stable. That is
  -- FALSE and review caught it: Postgres enforces immutability for index
  -- expressions and generated columns, never for CHECK, and
  -- `check (expires_at >= period + interval '1 month')` is accepted. The form
  -- below is still the right one, for the reason that actually holds --
  -- measured on the 17.7 cluster rather than reasoned about:
  --
  --   the naive form casts a plain timestamp to timestamptz using the
  --   SESSION's TimeZone, so for period 2026-03-01 it demands
  --   2026-04-01T04:00Z under America/New_York and admits 2026-03-31T21:00Z
  --   under Europe/Istanbul. It is wrong in both directions and which one
  --   depends on a setting no migration controls. With graceDays = 0 -- a
  --   policy assertRetentionPolicy explicitly admits -- the New York session
  --   refuses a legitimate mint outright.
  --
  -- `timezone('UTC', <timestamp>)` pins the conversion instead of inheriting
  -- it. It is also immutable, which matters for a different reason (an index
  -- on it would be legal), but that is not why it is here.
  --
  -- `>=` and not `>`: graceDays = 0 expires a month at its close, which is a
  -- policy and not a defect, and `>` would refuse every such mint.
  constraint namespace_key_expires_after_period
    check (expires_at >= timezone('UTC', (period + interval '1 month')::timestamp)),
  constraint namespace_key_period_is_month
    check (period = date_trunc('month', period::timestamp)::date),
  -- R2's guard. Expiry is not early, measured against the row's own value.
  --
  -- `>=` and not `>`: expirePeriods sweeps where `expires_at <= now` and sets
  -- `shredded_at = now`, so the very first sweep that may shred a month sets
  -- the instant to exactly expires_at. `>` would refuse Task 7 at its own
  -- boundary.
  constraint namespace_key_shred_not_early
    check (shredded_at is null or shredded_at >= expires_at)
);

-- Mirrors namespace_guard in 0001 and raises its own SQLSTATE, NNT06, for the
-- reason that one does not reuse NNT01: this table is MEANT to be updated
-- (that is what expiry is), so a refusal here says an update broke a rule,
-- not that the row was immutable.
create function namespace_key_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'NNT06',
      message = 'a month key is never deleted; a month is expired by shredding its key';
  end if;
  if new.namespace_id is distinct from old.namespace_id
     or new.period is distinct from old.period
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'NNT06',
      message = 'month key identity is fixed: namespace_id, period and created_at do not change';
  end if;
  -- Its own rule and its own message, because its reason is its own: expiry
  -- is fixed at mint from the policy in force, and moving it on a live row
  -- would retroactively change how long evidence stays readable with nothing
  -- recording that it happened. A policy change that must move it is a
  -- migration that disables this trigger.
  if new.expires_at is distinct from old.expires_at then
    raise exception using
      errcode = 'NNT06',
      message = 'expires_at is fixed at mint; changing retention for a minted month is a migration';
  end if;
  if old.shredded_at is not null
     and (new.shredded_at is distinct from old.shredded_at
          or new.key_wrapped is not null) then
    raise exception using
      errcode = 'NNT06',
      message = 'an expired month stays expired: the instant does not move and no key is put back';
  end if;
  -- R14. A live month key is never replaced, only nulled by a shred. The
  -- namespace table deliberately admits a live re-wrap, because the master
  -- key may be rotated and every namespace key is re-wrapped under the new
  -- master; no such reason exists one level down, since a month key is
  -- wrapped under the namespace data key and M1 rules that key is never
  -- rotated. Without this branch a live month can be silently re-keyed,
  -- which strands every payload already sealed under the old key while the
  -- row still says the month is live -- and the read reports it as a tamper,
  -- naming the ciphertext rather than the write that caused it.
  --
  -- Review found this hole by noticing that the row-copy test depended on
  -- it: the test moved a wrapped key between live rows and read the refusal
  -- from the cipher. That test now disables this trigger, which is honest,
  -- because the envelope's threat model assumes exactly that.
  if old.key_wrapped is not null
     and new.key_wrapped is not null
     and new.key_wrapped is distinct from old.key_wrapped then
    raise exception using
      errcode = 'NNT06',
      message = 'a live month key is not replaced; the only move is to null with a shred instant';
  end if;
  return new;
end
$$;

create trigger namespace_key_guarded
  before update or delete on namespace_key
  for each row execute function namespace_key_guard();
