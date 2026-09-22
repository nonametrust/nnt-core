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
-- The regex is the schema's own (sourceSchema.producer in @nonametrust/schema:
-- lowercase alphanumeric segments joined by single hyphens, no leading,
-- trailing or doubled hyphen). It is restated here rather than referenced
-- because a check constraint cannot import one, and it is restated in full
-- rather than loosened: a check that admits more than the schema does is a
-- check that lets a raw writer store what the repository never could. That
-- duplication is the cost, and it is the two-shapes rule M1 set -- the
-- TypeScript refuses first and names the class, the table refuses everyone.
alter table observation
  add column producer text not null
  constraint observation_producer_shape check (producer ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
