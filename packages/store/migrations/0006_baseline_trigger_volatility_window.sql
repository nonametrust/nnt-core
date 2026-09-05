-- The four tables M2 and M3 fill, landed now so those milestones add code and
-- not migrations. Nothing here is computed: every number is stored as given.
--
-- Every float column is held finite, for the reason 0003_tag.sql gives for
-- g0: Postgres orders NaN above every other double, so `x >= 0` admits NaN
-- and Infinity, and `x > 0` does too. `< 'infinity'` refuses both, because
-- NaN is not less than anything and Infinity is not less than itself; a
-- signed column adds `> '-infinity'` for the other end. The cost of leaving
-- this open is worst on baseline: a NaN in a running mean is permanent,
-- since every later update is NaN plus something, and one such row blinds
-- that aspect for that counterparty with no error anywhere.
--
-- What a sign check says here is what the column means, not how it is
-- updated. A sum of squared deviations and a MAD cannot be negative under
-- any estimator; a mean and a median can be. Whether m2 is zero when n is
-- zero, and whether median and MAD arrive together, are properties of M2's
-- update and are left to it.

-- Welford state, robust state, and the two timescales. Mutable by design: a
-- baseline is current state, not evidence. The arithmetic is M2's.
--
-- The counter is `n` and not `count`, which in hand-written SQL reads as the
-- aggregate; the TypeScript field is `count`, and the repository maps it.
create table baseline (
  namespace_id uuid not null references namespace (namespace_id),
  channel      text not null,
  aspect       text not null,
  n            bigint not null default 0 check (n >= 0),
  mean         double precision not null default 0
               check (mean > '-infinity'::float8 and mean < 'infinity'::float8),
  m2           double precision not null default 0
               check (m2 >= 0 and m2 < 'infinity'::float8),
  median_est   double precision
               check (median_est > '-infinity'::float8 and median_est < 'infinity'::float8),
  mad_est      double precision
               check (mad_est >= 0 and mad_est < 'infinity'::float8),
  fast_mean    double precision not null default 0
               check (fast_mean > '-infinity'::float8 and fast_mean < 'infinity'::float8),
  fast_m2      double precision not null default 0
               check (fast_m2 >= 0 and fast_m2 < 'infinity'::float8),
  slow_mean    double precision not null default 0
               check (slow_mean > '-infinity'::float8 and slow_mean < 'infinity'::float8),
  slow_m2      double precision not null default 0
               check (slow_m2 >= 0 and slow_m2 < 'infinity'::float8),
  updated_at   timestamptz not null,
  primary key (namespace_id, channel, aspect)
);

-- Named trigger_event and not trigger. `trigger` is a non-reserved keyword and
-- works unquoted, verified on PostgreSQL 17.7, but a table called trigger
-- beside a dozen SQL triggers costs legibility on every future read.
--
-- status and tier are text with a check rather than enum types. A Postgres
-- enum cannot lose a value without rewriting the type, and the tiered failure
-- policy is M3's to settle; a check constraint is a one-line migration to
-- change and an enum is not. The tier's values are not checked at all here,
-- for the same reason: what the tiers are is that policy.
--
-- observation_id and namespace_id are one foreign key against the pair
-- 0003_tag.sql made unique on observation, as tag and permanent_record have:
-- two independent keys would let a trigger be filed under a namespace its
-- observation is not about, and the nightly job would then open a window on
-- the wrong counterparty. The pair on this table is unique in turn, so that
-- hot_window can hold the same property against it.
--
-- surprise is a robust z-score in the design. Whether it is signed is M2's
-- to settle, so only finiteness is held: an infinite surprise ranks against
-- nothing, and a baseline with zero spread can produce one, which is the
-- arithmetic's case to bound before it reaches this row.
create table trigger_event (
  trigger_id     uuid primary key,
  namespace_id   uuid not null references namespace (namespace_id),
  observation_id uuid not null,
  status         text not null,
  tier           text,
  cluster_id     uuid,
  surprise       double precision not null
                 check (surprise > '-infinity'::float8 and surprise < 'infinity'::float8),
  created_at     timestamptz not null,
  constraint trigger_event_status_known
    check (status in ('candidate','verified','harm_confirmed')),
  constraint trigger_event_tier_needs_harm
    check (tier is null or status = 'harm_confirmed'),
  constraint trigger_event_in_namespace unique (trigger_id, namespace_id),
  constraint trigger_event_observation_in_namespace
    foreign key (observation_id, namespace_id)
    references observation (observation_id, namespace_id)
);

-- A volatility is a magnitude, so it is non-negative; whether it has a
-- floor above zero is M3's mean reversion to settle, so zero is admitted.
create table volatility (
  namespace_id uuid primary key references namespace (namespace_id),
  q_hat        double precision not null
               check (q_hat >= 0 and q_hat < 'infinity'::float8),
  updated_at   timestamptz not null
);

-- A window that closes when it opens captures nothing, so the bound is
-- strict. scale multiplies a window's length in M3, and a scale of zero or
-- of NaN is a window of no length or of no meaning.
create table hot_window (
  window_id    uuid primary key,
  namespace_id uuid not null references namespace (namespace_id),
  trigger_id   uuid not null,
  opens_at     timestamptz not null,
  closes_at    timestamptz not null,
  scale        double precision not null
               check (scale > 0 and scale < 'infinity'::float8),
  constraint hot_window_ordered check (closes_at > opens_at),
  constraint hot_window_trigger_in_namespace
    foreign key (trigger_id, namespace_id)
    references trigger_event (trigger_id, namespace_id)
);

-- Deferred from 0004: permanent_record.rescued_by points at a trigger, and
-- trigger_event did not exist when that migration ran. 0004 declared the
-- column with no constraint, on purpose, and this is the only place one is
-- added.
alter table permanent_record
  add constraint permanent_record_rescued_by_fk
  foreign key (rescued_by) references trigger_event (trigger_id);
