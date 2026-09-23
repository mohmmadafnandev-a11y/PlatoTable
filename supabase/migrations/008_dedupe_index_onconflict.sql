-- 008 — make the notification dedupe index usable by ON CONFLICT.
--
-- Found by running the sweep for real: every insert failed with
-- `there is no unique or exclusion constraint matching the ON CONFLICT
-- specification`, so the sweep reported work it had not actually done.
--
-- The cause is that 006 created the index as PARTIAL:
--
--     create unique index ... on system_notifications (dedupe_key)
--       where dedupe_key is not null;
--
-- Postgres will not infer a partial index from a bare `on conflict (dedupe_key)`
-- — the predicate has to be repeated in the conflict clause. Rather than repeat
-- `where dedupe_key is not null` in eleven places (and invite the next author to
-- forget it), the index is made whole, which needs no predicate at all.
--
-- This is safe and behaves identically: in Postgres, NULLs are not equal to each
-- other, so a plain unique index still permits any number of operator-written
-- broadcasts that have no dedupe key. The original comment claimed the partial
-- form was required for that; it was not, which is what made this easy to miss.

drop index if exists public.system_notifications_dedupe_unique;

create unique index if not exists system_notifications_dedupe_unique
  on public.system_notifications (dedupe_key);
