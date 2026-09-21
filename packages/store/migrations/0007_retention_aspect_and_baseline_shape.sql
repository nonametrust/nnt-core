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

-- === 1. baseline: the two shapes M2's arithmetic refuses =====================
--
-- 0006 landed this table with its own comment saying that "whether m2 is zero
-- when n is zero, and whether median and MAD arrive together, are properties
-- of M2's update and are left to it". M2 has since decided, so they come back
-- to the table. What the arithmetic refuses, the database must refuse too:
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
