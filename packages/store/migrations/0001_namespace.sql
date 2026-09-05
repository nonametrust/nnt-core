-- A namespace is a counterparty's identity, and the identifier is compared
-- byte for byte.
--
-- COLLATE "C" is written out rather than relied upon. Equality under any
-- deterministic collation is already byte equality, so on a normally created
-- cluster this column behaves correctly without the clause. It is here because
-- the failure it prevents is silent and total: under a nondeterministic ICU
-- collation two spellings fold into one logical namespace, and evidence about
-- two counterparties is summed into one with no error anywhere. That is the
-- exact failure the idempotency key's namespace part exists to prevent, and
-- the two now agree instead of one assuming the other.
--
-- What was verified, on Postgres 17.7 built with ICU, and what was not. With
-- the clause removed, the case test still passes under a deterministic ICU
-- database default, "und" and even "und-u-ks-level2", because a deterministic
-- collation breaks its ties bytewise. With the column under a nondeterministic
-- ICU collation, the case test fails exactly as described above, and passes
-- again once the column is put back under "C". Postgres 17 has no
-- way to make a nondeterministic collation a database default, so on this
-- major the clause guards against no cluster that can be initialised. It
-- stays because the column's identity must not depend on how a later cluster,
-- or a later major, is initialised.
--
-- Postgres text cannot hold a NUL byte, so the schema's NUL rule needs no
-- restatement here.
create table namespace (
  namespace_id     uuid primary key,
  kind             text not null check (kind in ('wallet','domain','endpoint','merchant')),
  ns_id            text collate "C" not null check (length(ns_id) > 0),
  -- Null once shredded. The key lives here and not on observation because
  -- shredding is an UPDATE and observation accepts none.
  data_key_wrapped bytea,
  key_shredded_at  timestamptz,
  created_at       timestamptz not null,
  constraint namespace_identity unique (kind, ns_id),
  constraint namespace_shred_consistent
    check ((data_key_wrapped is null) = (key_shredded_at is not null)),
  -- 29 is the wrapped-key header crypto.ts writes: one version byte, a
  -- twelve-byte nonce, a sixteen-byte tag. A value no longer than that holds
  -- no key, and without this check an empty bytea would count as "live" under
  -- the consistency check above. namespace.test.ts pins the number against
  -- what the key ring actually produces.
  constraint namespace_key_present
    check (data_key_wrapped is null or octet_length(data_key_wrapped) > 29)
);

-- The identity row is the one row every other table hangs from, and this is
-- the guard that makes it as fixed as the rows beneath it. observation is
-- append-only, but the row it hangs from was not: one UPDATE of kind and
-- ns_id re-attributes every observation, tag, permanent record, trigger and
-- baseline of one counterparty to another identity, and every payload still
-- opens under the new name, because the wrap is bound to namespace_id and
-- not to the identity pair. And a shred could be undone: a copy of the
-- wrapped key taken before it, written back with key_shredded_at cleared,
-- satisfies the consistency check above. NamespaceRepository.ensure uses
-- `do nothing` on conflict so that it never undoes a shred; that closed one
-- path in application code while the table left the rest open, which is the
-- shape the design says to avoid.
--
-- Three refusals, one SQLSTATE. No DELETE, ever: the row is what every
-- foreign key points at, and erasure is by shredding, which keeps it. No
-- change to namespace_id, kind, ns_id or created_at: the identity and the
-- moment it was first seen are facts, not state. And no way back from a
-- shred: once key_shredded_at is set it does not move and no wrapped key is
-- accepted beside it, whatever the consistency check would say.
--
-- What stays open, on purpose: data_key_wrapped on a live row. A re-wrap
-- under a rotated master key is exactly that UPDATE, and closing it would
-- make rotation a migration. The first shred passes because old.key_shredded_at
-- is null then; a repeated shred passes because the repository's coalesce
-- keeps the first timestamp and writes a null key.
--
-- NNT05 rather than NNT01: this table is meant to be updated, so a refusal
-- here is not an append-only violation, and an operator reading the class
-- must not be told that it is. The application maps it to NamespaceAltered.
create function namespace_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = 'NNT05',
      message = 'namespace is never deleted; erasure is by shredding the key';
  end if;
  if new.namespace_id is distinct from old.namespace_id
     or new.kind is distinct from old.kind
     or new.ns_id is distinct from old.ns_id
     or new.created_at is distinct from old.created_at then
    raise exception using
      errcode = 'NNT05',
      message = 'namespace identity is fixed: namespace_id, kind, ns_id and created_at do not change';
  end if;
  if old.key_shredded_at is not null
     and (new.key_shredded_at is distinct from old.key_shredded_at
          or new.data_key_wrapped is not null) then
    raise exception using
      errcode = 'NNT05',
      message = 'a shredded namespace stays shredded: the timestamp does not move and no key is put back';
  end if;
  return new;
end
$$;

create trigger namespace_guarded
  before update or delete on namespace
  for each row execute function namespace_guard();
