-- A counter the server can trust, for the endpoints worth abusing.
--
-- The API routes that create accounts, take cards, open billing portals and
-- delete restaurants are the ones where a burst of requests is either a script
-- or a very unlucky person. Neither should be able to hammer the Stripe API or
-- the Auth admin API through us, so each of those routes asks this table how
-- many times a caller has knocked in the current window.
--
-- Two decisions worth naming:
--
--   * The counter lives in Postgres, not in the function's memory. Serverless
--     instances are many and short-lived, so an in-process counter would give a
--     caller a fresh budget per instance — which is the same as no limit.
--
--   * The roll-over is one statement. A read-then-write would let two
--     simultaneous requests both read a stale count and both write `hits + 1`,
--     losing one attempt and under-counting exactly when it matters. The upsert
--     below decides the new window and increments in the same row lock, so
--     concurrent calls serialise and every attempt is counted.
--
-- The table has RLS on with no policies: nothing but the service role has any
-- business reading who has been rate-limited, and no client is granted execute
-- on either function.

create table if not exists public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits integer not null default 0
);

comment on table public.rate_limits is
  'Per-key request counters for API rate limiting. Window start is rolled and the count incremented in one upsert.';

alter table public.rate_limits enable row level security;

create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.rate_limits%rowtype;
begin
  insert into public.rate_limits as limits (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case
          when limits.window_start <= now() - make_interval(secs => p_window_seconds) then 1
          else limits.hits + 1
        end,
        window_start = case
          when limits.window_start <= now() - make_interval(secs => p_window_seconds) then now()
          else limits.window_start
        end
  returning * into v_row;

  return jsonb_build_object(
    'allowed', v_row.hits <= p_max,
    'hits', v_row.hits,
    'max', p_max,
    'reset_at', v_row.window_start + make_interval(secs => p_window_seconds)
  );
end;
$$;

-- Old windows are rubbish rather than history — a key that has not been touched
-- in a day can only expire into another window. The rate writer prunes on its
-- own schedule, which keeps this off any cron.
create or replace function public.rate_limits_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from public.rate_limits where window_start < now() - interval '1 day';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to postgres, service_role;

revoke all on function public.rate_limits_prune() from public, anon, authenticated;
grant execute on function public.rate_limits_prune() to postgres, service_role;
