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
-- Sections, in the order they were grown, each naming the task that added
-- it. Task 10's reviewer reads this file top to bottom as one migration, so
-- every section says what it holds AND what it deliberately leaves open:
--   1. baseline: the two shapes M2's arithmetic refuses (Task 1)
--   2. tag: the aspect it was always keyed on, retirement, the guard (Task 2)
--   3. observation: the producer column and the payload layout (Task 4b)
--   4. namespace_key: the month key, its guard, what expiry may not do (Task 5)
--   5. observation: the period it is keyed on, the key row it needs (Task 6)
--   6. observation: no counterparty is observed after its erasure (Task 8)
--   7. permanent_record: the payload a rescue keeps (Task 9)

-- Before anything else: this migration re-keys the payload envelope, in two
-- ways that each make every stored ciphertext unopenable, and a stored
-- payload is sealed under the layout AND the key that were in force when it
-- was written.
--
-- Section 3 adds `producer` and `ingested_at` to the envelope's associated
-- data, so the bytes a read rebuilds no longer match the bytes a write
-- bound. Section 5 then moves the seal itself from the namespace key to the
-- month key, which is the larger of the two and was not in this paragraph
-- while only section 3 existed. Either alone would do it; both are here.
--
-- And it would fail SILENTLY -- at the first read, far from here, as a
-- CiphertextRejected that names a tamper rather than a migration.
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

-- === 1. baseline: the two shapes M2's arithmetic refuses (Task 1) ============
--
-- 0006 landed this table with its own comment saying that "whether m2 is zero
-- when n is zero, and whether median and MAD arrive together, are properties
-- of M2's update and are left to it". M2 decided the second of those, so it
-- comes back to the table, together with the equality between the location
-- estimate and the mean. The first is NOT decided here: the arithmetic does
-- not refuse a zero count beside a positive m2 either, so there is nothing to
-- hold, and inventing a rule the arithmetic does not have would be a decision
-- this card has no authority to make. What the arithmetic refuses, the
-- database must refuse too:
-- otherwise the store can write a row that M3's read path throws on, which is
-- a refusal on the pipeline rather than on an observation, and it surfaces far
-- from the writer that caused it.
--
-- The table is empty here and that is why these can be added as checks at
-- all; over rows either would fail, loudly, and the failure would be the
-- 23514 naming the constraint rather than the preamble's refusal -- which
-- covers the payload envelope only and says nothing about baselines.
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

-- === 2. tag: the aspect it was always keyed on, and retirement (Task 2) =====
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


-- WHAT THIS SECTION LEAVES OPEN, and it is more than the retirement job.
-- The guard below holds the direction of `tagged_at` and the shape of a
-- count move, and it holds neither of these: a live tag's `g0` may be
-- rewritten to anything by any writer, and a tag may move from `open` to
-- `saturated` with its count unchanged. Nothing in M2's arithmetic produces
-- the second and nothing refuses it; both belong on M4's card beside
-- retirement rather than being invented here. INSERT is unguarded too, as
-- everywhere in this schema -- the checks are what cover it.
--
-- Retirement is named in the M0 spec, the M1 spec and the repository's own
-- docstring, and existed nowhere. The column lands here because the unique
-- index below is partial on it; the nightly operation that sets it is M4's.
alter table tag add column retired_at timestamptz;
-- R11 as a check as well as a guard branch. The guard fires on UPDATE and
-- DELETE, like every guard in this schema, so a raw INSERT could write a tag
-- retired eleven days before it was opened and nothing refused it -- measured,
-- not supposed. A tag cannot retire before it exists, whichever statement
-- writes it.
alter table tag add constraint tag_retired_after_opened
  check (retired_at is null or retired_at >= tagged_at);

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

create trigger tag_guarded
  before update or delete on tag
  for each row execute function tag_guard();


-- === 3. observation: the producer column and the payload layout (Task 4b) ===
--
-- WHAT THIS SECTION LEAVES OPEN. The column is a name and nothing more. The
-- cap on how fast one producer may deliver is counted in a repository, under
-- an advisory lock, and not by this table: no constraint here bounds a rate,
-- and none could without a clock the database is not allowed to read. And
-- nothing binds a producer to a namespace or to anything else -- the name is
-- free text until deliveries are signed, which is why R3 rules the cap a
-- tripwire for our own indexer rather than a defence against an attacker.
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


-- === 4. namespace_key: the month key and its guard (Task 5) =================
--
-- Retention in this design is unreadability on a clock, not deletion. A
-- payload is to be sealed under a key per (namespace, calendar month); that
-- month key is wrapped under the namespace's own key, so there are two levels
-- and the outer one is the namespace. Shredding a month key makes that month
-- unreadable while every row, foreign key, audit entry and day seal stays
-- exactly where it is and stays verifiable.
--
-- This section builds the table, its constraints and its guard. It does NOT
-- make any payload depend on a month key: the observation layer still seals
-- under the namespace key until Task 6 wires it, so at the commit that adds
-- this section, expiring a month makes nothing unreadable.
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
-- ALL THREE STATEMENTS IN ONE TRANSACTION. This is the one that matters.
-- `alter table ... disable
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
--
-- All of which is written down because without the sanctioned path above --
-- the migration that disables this trigger, moves `expires_at` and puts it
-- back -- the guard below reads as "expiry can never change", and that is
-- not what is meant.
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
  -- Named for THIS table: `namespace_key_present` already exists on
  -- `namespace` (0001), and two constraints of one name in one schema make an
  -- operator's error line ambiguous about which table refused.
  constraint namespace_key_wrapped_present
    check (key_wrapped is null or octet_length(key_wrapped) > 29),
  -- A month cannot expire before it has closed, where "closed" means the UTC
  -- close and not the server's.
  --
  -- Immutability is NOT why the form below is the right one, though it is
  -- the first reason anyone reaches for. Postgres enforces immutability for
  -- index expressions and generated columns and never for CHECK, so
  -- `check (expires_at >= period + interval '1 month')` is accepted --
  -- measured on the 17.7 cluster. The reason that actually holds is:
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
  --
  -- The UPPER bound is not decoration. This table has no INSERT guard (the
  -- trigger below is update/delete only, like every guard in this schema) and
  -- periodKey is on-conflict-do-nothing, so a planted row WINS over the
  -- legitimate mint. Planted with expires_at in 2999, the month is never
  -- reached by the sweep and its payloads stay readable for a thousand years.
  -- Measured by review, not imagined.
  --
  -- Ten years is deliberately generous rather than tight: it is not a policy
  -- number, it is the line between a grace and a mistake, and a policy that
  -- genuinely wanted longer would be a migration. The repository additionally
  -- refuses a row whose expiry is not the one its own policy computes, which
  -- is the same plant arriving before the mint rather than after it.
  constraint namespace_key_expires_in_range
    check (expires_at >= timezone('UTC', (period + interval '1 month')::timestamp)
       and expires_at <= timezone('UTC', (period + interval '10 years')::timestamp)),
  constraint namespace_key_period_is_month
    check (period = date_trunc('month', period::timestamp)::date),
  -- `infinity` is a date, and every check above was written as though it were
  -- not: date_trunc leaves it alone so the month check passes, and both
  -- halves of the range check compare infinity with itself so they pass too.
  -- The row is then live for ever, because the sweep selects `expires_at <=
  -- now` and infinity never is -- a month key that no retention policy can
  -- ever reach, which is the one row this table exists to make impossible.
  -- Planted by review; the same shape as the 2999 plant two constraints up,
  -- arriving through a value rather than through a number.
  --
  -- One constraint closes it and the second is not needed: with `period`
  -- finite, an infinite `expires_at` already fails the range check's upper
  -- bound. `observation.period` is a foreign key into this table, so an
  -- infinite month cannot appear there either.
  constraint namespace_key_period_finite check (isfinite(period)),
  -- R2's guard. Expiry is not early, measured against the row's own value.
  --
  -- `>=` and not `>`: expirePeriods sweeps where `expires_at <= now` and sets
  -- `shredded_at = now`, so the very first sweep that may shred a month sets
  -- the instant to exactly expires_at. `>` would refuse Task 7 at its own
  -- boundary.
  constraint namespace_key_shred_not_early
    check (shredded_at is null or shredded_at >= expires_at)
);

-- The sweep's access path. `expirePeriods` selects `key_wrapped is not null
-- and expires_at <= now`, which without this is a sequential scan over every
-- month key the store has ever minted -- including the shredded ones, which
-- only ever accumulate and are exactly the rows it can never act on again.
-- The partial predicate is the point: the index holds the live months, so it
-- shrinks as retention does its work rather than growing with the table.
--
-- Recorded as unmeasured. No cardinality here justifies an index yet, and a
-- planner on a small table will ignore it; it is the shape of the query that
-- justifies it, and the shape is fixed by R18. What the test beside it holds
-- is that the access path EXISTS, not that it is used, because "the planner
-- chose it today" is not a rule and a test that asserted it would fail on the
-- first table small enough to seq-scan.
create index namespace_key_due on namespace_key (expires_at) where key_wrapped is not null;

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
  -- The row-copy test moves a wrapped key between live rows and reads the
  -- refusal from the cipher, so it disables this trigger to get there --
  -- honest, because the envelope's threat model assumes exactly that. It
  -- does so as three autocommit statements and is therefore NOT an example
  -- of the sanctioned migration path described above; in a single-session
  -- test nothing else can reach the table in between.
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


-- === 5. observation: the period and the key row it requires (Task 6) =======
-- `observation` is altered here a second time, and the order is a
-- dependency rather than an accident: this section needs `namespace_key`,
-- which section 4 creates. The per-section task attributions live in the
-- table of contents at the top of this file and are not repeated here.
--
-- The month an observation's payload is keyed under, derived from INGEST time
-- and not from the event's own instant. A state has no dated instant at all,
-- and a backfill keyed on the event's month would be born expired -- which
-- contradicts the one rule this design does not bend, that no observation is
-- dropped at write time. R1 argues it; this column is where it becomes a
-- fact, and the check below is what stops the two drifting.
--
-- A new observation therefore lands in the month it is written in, and under
-- the shipped ninety-day grace that month cannot already be expired. Not
-- "never", and the difference is a policy this schema admits: with a zero
-- grace -- a
-- policy the arithmetic admits -- a month expires at its own close, and a
-- sweep at 00:00 on the first can shred the month an append captured its
-- instant in moments earlier. Measured, not supposed. The plan's §2c records
-- it; the mechanism is Task 8's, because the fix is a shape for what `append`
-- returns.
alter table observation add column period date not null;

-- The immutable form, and the choice is measured rather than stylistic.
--
-- `date_trunc('month', ingested_at)` alone is STABLE: it truncates in the
-- session's zone, so an instant at 2026-09-30T23:30Z files under October
-- fourteen hours east of Greenwich. `date_trunc('month', ingested_at, 'UTC')`
-- is immutable on its own but is a timestamptz, and `timestamptz::date`
-- converts in the session's zone too, so the whole expression is stable
-- again -- verified by putting each in an index, which is the only thing
-- that enforces immutability (a CHECK does not, which this file learned the
-- hard way one section up).
--
-- `timezone('UTC', ingested_at)` returns a plain timestamp, and every step
-- after it is session-independent.
alter table observation
  add constraint observation_period_from_ingested_at
  check (period = date_trunc('month', timezone('UTC', ingested_at))::date);

-- No payload without a key row to open it under. Without this the ordering in
-- `append` would be the only thing keeping the two together, and an ordering
-- is not a constraint: a raw writer, or a future path that forgot to mint,
-- would store a payload that nothing can ever decrypt and no error would say
-- so until the first read.
--
-- It points at the pair, not at the namespace, because the key is per pair.
alter table observation
  add constraint observation_period_key
  foreign key (namespace_id, period) references namespace_key (namespace_id, period);

-- For the per-producer cap in Task 8, which counts
-- `where producer = ? and ingested_at > now - window`. Descending on the
-- instant because the count always looks at the recent end. Without it every
-- append scans the table. It sits in THIS section and not beside the
-- `producer` column two sections up, which is where an earlier version of
-- this comment claimed it was: the column arrived with Task 4b and the
-- access path with Task 6, 270 lines apart. Worth saying plainly rather than
-- claiming a tidiness the file does not have -- a column and its index
-- landing in different sections is the kind of thing the next reader should
-- be told, not reassured about.
create index observation_by_producer_ingested on observation (producer, ingested_at desc);


-- === 6. observation: no counterparty is observed after its erasure (Task 8) ==
--
-- R19's owed gate, and it is owed because a sentence turned out to be false.
-- The M1 ledger says "a shredded counterparty can never be observed again"
-- and calls it a product consequence. Nothing enforced it. `append` reads the
-- namespace key, mints or opens a month key, and only then inserts; nothing
-- spans those steps, so an erasure request committing in between left a row
-- whose `ingested_at` is LATER than `namespace.key_shredded_at`. Measured by
-- an adversarial review on this branch, not imagined: the payload was
-- unreadable, because the outer key was already gone, but the row existed and
-- the erasure's own timestamp was no longer the last word about that
-- counterparty.
--
-- The foreign key does not help. `observation.namespace_id` references
-- `namespace`, and a shredded namespace is still a row, so the reference is
-- satisfied. The append-only trigger does not help either: like every guard
-- in this schema it is UPDATE and DELETE only, by design, because INSERT is
-- the operation this table exists for.
--
-- WHY A TRIGGER RATHER THAN A CHECK. A check constraint sees only the row
-- being written, and the fact that decides this lives in another table. A
-- foreign key to a partial index of live namespaces would be the declarative
-- form, and Postgres will not reference a partial index; it would also make
-- the shred itself fail rather than the write, which is backwards -- an
-- erasure request must never be refused because data exists.
--
-- WHY `for share`. Without it the trigger reads under the statement's own
-- snapshot, which closes the window this section is about (the shred commits
-- before the INSERT statement begins) and leaves a narrower one (the shred
-- commits while it runs). The share lock makes the two serialise: an erasure
-- in flight blocks until this insert commits and then sees it, or this insert
-- waits and then reads the shred. Share locks do not conflict with each
-- other, so concurrent appends to one namespace still do not queue; only a
-- shred, which takes a row-exclusive lock, does -- and a shred is rare and
-- may wait.
--
-- What this does NOT claim, and the boundary is narrower than the sentence it
-- enforces. It orders COMMITS, not instants. `shred` reads its instant in the
-- application before its UPDATE is sent, and that UPDATE can wait -- on the
-- pool, or on this very trigger's FOR SHARE held by an insert already in
-- flight -- so an append committing during that wait can carry an
-- `ingested_at` later than the recorded `key_shredded_at`. Review measured
-- exactly that. Taking the instant server-side would fix it and is refused:
-- this store reads no wall clock outside clock.ts, and that rule is worth
-- more than the ordering of two timestamps nobody compares.
--
-- So the enforceable sentence is "no observation commits after the erasure
-- commits", and the M1 ledger's "can never be observed again" is true in that
-- sense and not in the stronger one its words suggest.
--
-- It also does not make an erasure retroactive, and §2c's limits on what a
-- shred removes from the disk are untouched. It is the mechanism behind one
-- sentence, not the sentence.
-- The month half, added by the branch review. The gate above refuses a write
-- into an ERASED counterparty space and refused nothing about an EXPIRED
-- MONTH of a live one -- and neither did anything else. `observation_period_key`
-- is satisfied by a SWEPT `namespace_key` row exactly as well as by a live
-- one, because a foreign key asks whether the row exists and not what is in
-- it. A raw insert naming a month whose key was shredded committed with no
-- error: a row the store can never serve, filed under a key that no longer
-- exists. Planted by review; it committed.
--
-- It closes a window in the repository's own path too. `append` reads the
-- month key and then inserts, and a sweep committing between the two let the
-- append resolve `{created: true}` for a row whose very next `get` raised
-- PayloadExpired. The `for share` below makes the sweep's UPDATE and this
-- insert serialise, on exactly the argument the namespace half makes.
--
-- A SEPARATE SQLSTATE, and that is the point rather than an accident. An
-- expired month is not an erasure request: the counterparty space is intact
-- and its other months still read. An operator told "erased on request"
-- about a month the retention clock took would go looking for a request
-- nobody made. It is the same distinction that makes `PayloadExpired` a
-- different class from `NamespaceShredded`, now with a SQLSTATE as well.
--
-- The function is named for what it checks, which is no longer the namespace
-- alone: both halves answer one question, "may anything be written here".
create function observation_target_writable() returns trigger language plpgsql as $$
declare
  erased boolean;
  expired boolean;
begin
  select data_key_wrapped is null into erased
  from namespace where namespace_id = new.namespace_id for share;
  -- `not found` is impossible under the foreign key and is left to it: a
  -- null `erased` here would mean the reference is broken, which is the
  -- foreign key's refusal to make and not this trigger's.
  if erased then
    raise exception using
      errcode = 'NNT08',
      message = 'namespace ' || new.namespace_id ||
                ' was erased on request; no observation is written for it afterwards';
  end if;
  -- Checked SECOND, so an erased namespace is reported as erased even when
  -- its months are also gone. The erasure is the fact an operator needs.
  select key_wrapped is null into expired
  from namespace_key
  where namespace_id = new.namespace_id and period = new.period for share;
  if expired then
    raise exception using
      errcode = 'NNT09',
      message = 'the month ' || new.period || ' of namespace ' || new.namespace_id ||
                ' was shredded; no observation is written under an expired month';
  end if;
  return new;
end
$$;

create trigger observation_target_writable_on_insert
  before insert on observation
  for each row execute function observation_target_writable();


-- === 7. permanent_record: the payload a rescue keeps (Task 9) ===============
--
-- The card's whole sentence is that a captured trace outlives its month. Until
-- this section `promote` copied metadata and never opened the observation, so a
-- promotion after a month expired SUCCEEDED and rescued nothing: the
-- retroactive-rescue mechanism quietly producing an empty rescue, with no error
-- anywhere and a record that looks complete. §1 of the plan found it by
-- reading
-- the shipped code rather than the design.
--
-- The three columns hold the observation re-sealed under the NAMESPACE key,
-- not the month key. That is the point: the month key dies on the retention
-- clock and the namespace key does not, so a rescue survives its month and
-- still dies with an erasure request. Copying the month-sealed ciphertext
-- instead would produce a record that expires with the thing it was meant to
-- outlive -- the fourth path in the plan's risk list, and the one an
-- implementer reaches for because it looks like less work.
--
-- NOT NULL, because a record without a payload is the empty rescue this
-- section exists to make impossible. The table is empty here; over rows this
-- would fail, which is the same refusal the preamble makes for the whole file.
--
-- The append-only trigger from 0004 stays and now covers these too: a record
-- is written once, and the payload bound into it cannot be swapped afterwards
-- without the trigger being disabled.
--
-- WHAT THIS SECTION LEAVES OPEN, three things.
--
-- The database cannot tell a namespace-sealed payload from a month-sealed
-- one copied across: both are bytea of the same shape, and the rule that a
-- rescue must be re-sealed under the outer key lives in TypeScript alone.
-- The expire-then-read test is what holds it.
--
-- There is no header-length check on these three columns, where
-- `namespace_key_wrapped_present` has one. A zero-length ciphertext is
-- refused by NOT NULL and by nothing else.
--
-- And 0004's own open item has changed shape rather than closed: it asks
-- what promotion into a shredded namespace should do, and `promote` now
-- opens the observation before writing, so the refusal arrives from the
-- payload path as well as from the early check. Which of the two should own
-- it is M4's to settle.
alter table permanent_record add column payload_nonce bytea not null;
alter table permanent_record add column payload_tag bytea not null;
alter table permanent_record add column payload_ciphertext bytea not null;


-- === 8. Every trigger function names where it looks (Task 11's review) =====
--
-- Every guard in this schema reads its tables UNQUALIFIED -- `from namespace`,
-- `from namespace_key`, `from audit_entry` -- and an unqualified name is
-- resolved through the session's `search_path`, which has the implicit
-- `pg_temp` at the FRONT unless a function says otherwise. So
--
--   create temp table namespace (namespace_id uuid primary key,
--                                data_key_wrapped bytea);
--   insert into namespace values ('<the erased one>', '\x00');
--
-- makes the erasure gate ask a table the writer just made up, and the insert
-- it exists to refuse commits. Measured on 17.7: NNT08 before the temp table,
-- `INSERT 0 1` after it, with the real `namespace.data_key_wrapped` still
-- null and no session setting changed.
--
-- This is not a theoretical privilege. TEMP is granted to PUBLIC by default,
-- while `alter table ... disable trigger` needs ownership and `create schema`
-- needs CREATE on the database -- both of which the non-owning application
-- role `0002` anticipates is denied. Measured with exactly that role: the
-- disable and the schema routes were refused and this one was not. It is the
-- single route that hands such a role the capability the deployment takes
-- away, so "no observation commits after the erasure commits" was false for
-- the writer the sentence is about.
--
-- Pinned for EVERY trigger function in this schema and not only the ones this
-- migration added, because the same hole is in `0001`-`0006`'s guards and
-- fixing one of nine would be worse than fixing none: it would read as done.
--
-- Two details the measurement forced. `pg_temp` is listed LAST and
-- explicitly: leaving it out of the list is exactly what puts it first. And
-- the schema cannot be a literal, because the test harness installs this
-- store into a schema per test file and a deployment chooses its own, so it
-- is taken from `current_schema()` at migration time -- the schema these
-- functions were just created in.
do $$
declare fn text; here text := current_schema();
begin
  for fn in
    select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = here
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('alter function %s set search_path = %I, pg_temp', fn, here);
  end loop;
end $$;
