-- A tag is a limbo entry. It stores what it was tagged with and when, and it
-- does not store how strong it is now: strength is a function of g0, elapsed
-- time, the channel half-life and the suppression factor, so any historical
-- strength is reproducible and no background writer has to exist.
--
-- Suppression is accelerated decay, not deletion. suppression_factor
-- multiplies elapsed time in the decay, so a suppressed tag falls faster and
-- never disappears by being removed.
--
-- g0 and suppression_factor are held finite by both layers. Postgres orders
-- NaN above every other double, so `g0 >= 0` alone admits NaN and Infinity,
-- and greatest(g0, NaN) is NaN: one such row, written by a backfill or a raw
-- session, would poison every later refresh. `< 'infinity'` refuses both,
-- because NaN is not less than anything and Infinity is not less than
-- itself. The repository refuses the same values first, with the RangeError
-- its callers assert on; this is the rule the next writer cannot go around.
--
-- A tag names an observation and the counterparty it is about, and those two
-- must agree: the pair is one foreign key, against a unique pair on
-- observation, so a tag cannot be filed under a namespace its observation
-- does not belong to and then surface there in listLive.
alter table observation
  add constraint observation_in_namespace unique (observation_id, namespace_id);

create table tag (
  tag_id             uuid primary key,
  namespace_id       uuid not null references namespace (namespace_id),
  observation_id     uuid not null,
  channel            text not null,
  g0                 double precision not null
                     check (g0 >= 0 and g0 < 'infinity'::float8),
  tagged_at          timestamptz not null,
  refresh_count      integer not null default 0 check (refresh_count >= 0),
  saturation_state   text not null default 'open'
                     check (saturation_state in ('open','saturated')),
  suppression_factor double precision not null default 1
                     check (suppression_factor >= 1 and suppression_factor < 'infinity'::float8),
  constraint tag_observation_in_namespace
    foreign key (observation_id, namespace_id)
    references observation (observation_id, namespace_id)
);

create index tag_live_by_namespace on tag (namespace_id, tagged_at desc);
