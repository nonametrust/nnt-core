-- A promotion preserves the instant the evidence carried, not the instant it
-- was promoted. The day-12 address change surfaces on day twenty-one still
-- dated day twelve; that is the whitepaper's scenario and the reason this
-- column exists. Stamped with the promotion instant instead, the evidence
-- would look nine days younger than it is and every window computed from it
-- downstream would be wrong.
--
-- The trigger is why it is a claim and not a hope. A test can prove the
-- repository copies the timestamp today; the trigger proves that every writer
-- does, including one written next month against the table directly.
--
-- observation_id and namespace_id are one foreign key against the pair
-- 0003_tag.sql made unique on observation, for the reason tag has the same:
-- two independent keys would let a record be filed under a namespace its
-- observation does not belong to, and surface in that counterparty's brief.
-- There is no single-column key on observation_id beside it; both columns
-- are not null, so the pair check cannot be skipped and a matching pair
-- entails the observation exists.
create table permanent_record (
  record_id         uuid primary key,
  observation_id    uuid not null,
  namespace_id      uuid not null references namespace (namespace_id),
  original_dated_at timestamptz not null,
  promoted_at       timestamptz not null,
  -- References trigger_event. The migration that creates that table adds the
  -- constraint, and nowhere else does.
  rescued_by        uuid,
  -- The confidence at promotion: a historical fact, not a cached strength,
  -- which is why tag's no-strength-column gate stops at tag. `<= 1` refuses
  -- NaN along with anything above one, because NaN is not less than or equal
  -- to anything; `>= 0` on its own would admit it, since Postgres orders NaN
  -- above every other double.
  confidence        double precision not null,
  constraint permanent_record_confidence check (confidence >= 0 and confidence <= 1),
  constraint permanent_record_once unique (observation_id),
  constraint permanent_record_observation_in_namespace
    foreign key (observation_id, namespace_id)
    references observation (observation_id, namespace_id)
);

-- One property, held on every insert and update: original_dated_at is the
-- source observation's own dated_at. It is checked against the live row at
-- the moment of the write, under read committed, so a writer that copied a
-- value and then wrote it late is still measured against what the source
-- says now. That the source cannot change is observation's append-only
-- trigger's job; this one only has to look.
--
-- The update leg is defence in depth. The table is append-only, below, and
-- that trigger sorts first and refuses every update before this one runs.
-- This leg is for the day that trigger is disabled, and the test proves it
-- by doing exactly that inside a transaction it rolls back.
--
-- A source that does not exist is left to the foreign key. Refusing it here
-- would report a nonexistent observation as an altered timestamp, and a
-- caller debugging the wrong problem is worse than one refused twice.
--
-- A state has no dated_at, so a record naming a state with any instant at
-- all disagrees with its source and is refused here; one naming it with null
-- passes this check and is refused by the column. Either way no record of a
-- state exists, which is the point: a standing condition has no instant to
-- preserve, and inventing one is how a state ends up credited to a window.
--
-- What no trigger holds: a promotion into a shredded namespace. The
-- observation row survives a shred and its instant is still readable, so
-- the database sees nothing wrong with the record. The repository refuses
-- it, because a promotion exists to make evidence surface in a later brief,
-- and evidence whose content can never be read again can only produce a
-- reason nobody can explain.
create function permanent_record_keeps_its_date() returns trigger language plpgsql as $$
declare source_dated timestamptz;
begin
  select dated_at into source_dated from observation where observation_id = new.observation_id;
  if not found then
    return new;
  end if;
  if source_dated is distinct from new.original_dated_at then
    raise exception using
      errcode = 'NNT04',
      message = 'a promotion must carry the observation''s own instant, not the promotion instant';
  end if;
  return new;
end
$$;

create trigger permanent_record_date_preserved
  before insert or update on permanent_record
  for each row execute function permanent_record_keeps_its_date();

-- Append-only, held by the database, as observation is. Every column is
-- fixed at promotion time and has no designed writer afterwards: the
-- confidence is the confidence at promotion, a historical fact, and a fact
-- with an UPDATE path is not one. What breaks otherwise is concrete: any
-- session could move promoted_at, rewrite confidence, repoint a record at
-- another observation carrying the same instant, which the date trigger
-- above cannot see, or DELETE a record and remove evidence from a day-21
-- brief with no trace. Nothing is lost by refusing: erasure is by key
-- shredding, and a promotion that must be reversed is a new fact, not a
-- rewrite of this one.
--
-- NNT01 is shared with observation, since it is one concept; the table name
-- is in the message so the two are told apart.
create function permanent_record_append_only() returns trigger language plpgsql as $$
begin
  raise exception using
    errcode = 'NNT01',
    message = tg_table_name || ' is append-only: ' || tg_op || ' is refused';
end
$$;

create trigger permanent_record_append_only
  before update or delete on permanent_record
  for each row execute function permanent_record_append_only();
