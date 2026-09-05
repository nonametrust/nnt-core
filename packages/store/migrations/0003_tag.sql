-- A tag is a limbo entry. It stores what it was tagged with and when, and it
-- does not store how strong it is now: strength is a function of g0, elapsed
-- time, the channel half-life and the suppression factor, so any historical
-- strength is reproducible and no background writer has to exist.
--
-- Suppression is accelerated decay, not deletion. suppression_factor
-- multiplies elapsed time in the decay, so a suppressed tag falls faster and
-- never disappears by being removed.
--
-- The checks on g0 and suppression_factor are a floor, not the guard. Postgres
-- orders NaN above every other double, so `NaN >= 0` is true here and a NaN g0
-- would pass; and greatest(g0, NaN) is NaN, which would poison a tag's g0 on
-- refresh. The repository refuses a non-finite value before it reaches this
-- table, and tag.test.ts pins that refusal.
create table tag (
  tag_id             uuid primary key,
  namespace_id       uuid not null references namespace (namespace_id),
  observation_id     uuid not null references observation (observation_id),
  channel            text not null,
  g0                 double precision not null check (g0 >= 0),
  tagged_at          timestamptz not null,
  refresh_count      integer not null default 0 check (refresh_count >= 0),
  saturation_state   text not null default 'open'
                     check (saturation_state in ('open','saturated')),
  suppression_factor double precision not null default 1 check (suppression_factor >= 1)
);

create index tag_live_by_namespace on tag (namespace_id, tagged_at desc);
