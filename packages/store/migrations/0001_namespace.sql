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
