-- Close the advisor's findings that are worth closing, and leave the ones that
-- are not.
--
-- Everything in this schema is SECURITY DEFINER, because these functions read
-- tables the caller has no policy for. That makes the EXECUTE grant the whole
-- security boundary: a function that is reachable by `anon` runs as its owner,
-- not as the visitor.
--
-- Two groups are deliberately NOT revoked:
--
--   * the platform read model (super_admin_*), which the panel calls as a signed
--     in user. Each one already opens by refusing a caller who is not platform
--     staff, so the grant is reachable but not usable. Revoking it would break
--     the dashboard rather than secure it.
--   * the public functions (get_scan_menu, public_plans, public_platform_contact,
--     public_tenant_by_slug, public_tenant_login), which are the product: a
--     visitor who has not signed in is supposed to be able to scan a table and
--     read a plan list.
--
-- What is revoked is everything only the server should ever reach: money
-- conversion, the rate writer, the billing sweep, and every trigger function.
-- A trigger function is not a callable API at all, so it is revoked from anon,
-- authenticated and PUBLIC.

-- ── Trigger functions are not endpoints ───────────────────────────────────
do $$
declare
  signature text;
begin
  for signature in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to postgres, service_role', signature);
  end loop;
end $$;

-- ── Server-only helpers ──────────────────────────────────────────────────
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.convert_money(numeric, text, text)',
    'public.currency_rate(text, text)',
    'public.currency_rates_state()',
    'public.refresh_currency_rates(jsonb, text, text)',
    'public.billing_sweep(boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', signature);
    execute format('grant execute on function %s to postgres, service_role', signature);
  end loop;
end $$;

-- ── The staff read model is never for an anonymous session ───────────────
do $$
declare
  signature text;
begin
  foreach signature in array array[
    'public.super_admin_restaurants()',
    'public.super_admin_dashboard(text)',
    'public.super_admin_analytics(text)',
    'public.super_admin_upcoming_payments(integer)',
    'public.super_admin_role()'
  ] loop
    execute format('revoke all on function %s from public, anon', signature);
    execute format('grant execute on function %s to authenticated, postgres, service_role', signature);
  end loop;
end $$;

-- A trigger function that only reads its own row still gets a fixed search
-- path: it is the one warning the advisor raised against a function rather than
-- a grant, and setting it costs nothing here because the body names no table.
alter function public.subscription_plans_sync_duration() set search_path = '';
