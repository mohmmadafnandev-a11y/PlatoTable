-- ============================================================================
-- Plato Table — 002_onboarding.sql
--
-- Purpose
--   Make restaurant onboarding actually work end to end from the Super Admin
--   panel, and make `/<slug>` able to resolve a tenant.
--
-- Corrective and additive only. No table is dropped, no column is removed, no
-- row is deleted. Every statement is idempotent and safe to re-run.
--
-- What this resolves
--   1. GBP and SAR were rejected by five separate CHECK constraints, plus a
--      hardcoded list inside onboard_restaurant(). Widening one table was not
--      enough: a GBP restaurant would onboard and then fail at the
--      subscriptions insert.
--   2. onboard_restaurant() priced plans with
--      `case p_currency when 'USD' ... when 'AED' ... else price_pkr end`.
--      A GBP restaurant selecting a plan was therefore billed the PKR amount.
--      The mapping now raises instead of guessing.
--   3. The reserved subdomain list existed only in JavaScript, so a restaurant
--      slugged "admin" or "api" could be created and would shadow a real route.
--   4. `/<slug>` had no way to resolve a tenant at all: public_tenant_by_slug()
--      did not exist, so every slug rendered "Menu unavailable".
--   5. The onboarding form collects a country and internal notes, and
--      restaurants had nowhere to store either.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Currency: every column that stores one, including the platform default.
--    These are checked together because they are one invariant, and widening
--    only some of them fails later in the onboarding transaction rather than
--    at the boundary.
-- ---------------------------------------------------------------------------

alter table public.restaurants drop constraint if exists restaurants_currency_check;
alter table public.restaurants add constraint restaurants_currency_check
  check (currency in ('PKR', 'USD', 'AED', 'GBP', 'SAR'));

alter table public.subscriptions drop constraint if exists subscriptions_currency_check;
alter table public.subscriptions add constraint subscriptions_currency_check
  check (currency in ('PKR', 'USD', 'AED', 'GBP', 'SAR'));

alter table public.payment_transactions drop constraint if exists payment_transactions_currency_check;
alter table public.payment_transactions add constraint payment_transactions_currency_check
  check (currency in ('PKR', 'USD', 'AED', 'GBP', 'SAR'));

alter table public.wallet_transactions drop constraint if exists wallet_transactions_currency_check;
alter table public.wallet_transactions add constraint wallet_transactions_currency_check
  check (currency in ('PKR', 'USD', 'AED', 'GBP', 'SAR'));

alter table public.platform_settings drop constraint if exists platform_settings_default_currency_check;
alter table public.platform_settings add constraint platform_settings_default_currency_check
  check (default_currency in ('PKR', 'USD', 'AED', 'GBP', 'SAR'));

-- ---------------------------------------------------------------------------
-- 2. Plan pricing per currency.
--    Nullable on purpose: no price means "not sold in this currency", which is
--    a fact the onboarding RPC must respond to rather than paper over.
-- ---------------------------------------------------------------------------

alter table public.subscription_plans add column if not exists price_gbp numeric(12, 2);
alter table public.subscription_plans add column if not exists price_sar numeric(12, 2);

-- Recorded when a tenant consumes its free trial, so re-onboarding cannot grant
-- a second one. Both the onboarding endpoint and api/stripe/attach.js reference
-- this column and neither could work without it: onboarding failed outright on
-- the write, one statement after it had already created the tenant.
alter table public.subscriptions add column if not exists trial_used_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Restaurant columns the onboarding form collects.
-- ---------------------------------------------------------------------------

alter table public.restaurants add column if not exists country text;
alter table public.restaurants add column if not exists notes text;

-- is_active gates the public menu surfaces. Onboarding marks a restaurant
-- complete in the same transaction that creates it, so a half-created tenant can
-- never be served to a customer.
alter table public.restaurants add column if not exists is_active boolean not null default true;
alter table public.restaurants add column if not exists onboarding_completed boolean not null default false;

-- ---------------------------------------------------------------------------
-- 4. Reserved subdomains, enforced at the data layer.
--    This mirrors shared/slug.js. It is duplicated rather than derived because
--    these names are ROUTES: changing them is a code change, and a code change
--    should be accompanied by a migration. The form and the endpoint are the
--    friendly gate; this constraint is the one that cannot be bypassed.
-- ---------------------------------------------------------------------------

alter table public.restaurants drop constraint if exists restaurants_subdomain_not_reserved;
alter table public.restaurants add constraint restaurants_subdomain_not_reserved check (
  subdomain not in (
    'admin', 'api', 'assets', 'scan', 'login', 'logout', 'settings',
    'restaurants', 'subscriptions', 'plans', 'notifications', 'analytics',
    'team', 'logs', 'revenue', 'transactions', 'urls', 'dashboard', 'billing',
    'payment', 'help', 'support', 'about', 'contact', 'terms', 'privacy',
    'signup', 'signin', 'signout', 'register', 'auth',
    'new', 'null', 'undefined'
  )
);

-- ---------------------------------------------------------------------------
-- 5. onboard_restaurant()
--    The deployed API calls this by named argument, and p_country/p_notes are
--    appended with defaults, so no caller changes.
--
--    The 12-argument version has to be dropped rather than replaced: changing a
--    parameter list makes `create or replace` add an OVERLOAD instead of
--    replacing, and PostgREST then sees two candidates for the same named
--    arguments and refuses the call as ambiguous. Drop and create run inside
--    this transaction, so no session ever observes a missing function.
-- ---------------------------------------------------------------------------

drop function if exists public.onboard_restaurant(
  text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid
);

-- The 14-argument form is dropped for idempotency: an earlier revision of this
-- migration created it, and re-running should converge rather than leave both.
-- OUT parameters are not part of a function's identity, so the argument list is
-- the same 14 input types either way.
drop function if exists public.onboard_restaurant(
  text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid, text, text
);

create or replace function public.onboard_restaurant(
  p_name text,
  p_subdomain text,
  p_owner_email text,
  p_owner_user_id uuid,
  p_phone text default null,
  p_currency text default 'PKR',
  p_plan_id uuid default null,
  p_trial_days integer default 7,
  p_admin_url text default null,
  p_user_url text default null,
  p_custom_domain text default null,
  p_super_admin_id uuid default null,
  p_country text default null,
  p_notes text default null
)
-- The output columns are named out_* on purpose. Naming them restaurant_id and
-- subscription_id made every reference to a column of that name inside the body
-- ambiguous, and PL/pgSQL refuses to guess: "column reference restaurant_id is
-- ambiguous" (42702). That error was invisible until now because the previous
-- version failed one statement earlier, on a column that did not exist.
returns table(out_restaurant_id uuid, out_subscription_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_restaurant_id uuid;
  v_subscription_id uuid;
  v_plan public.subscription_plans%rowtype;
  v_amount numeric(12,2);
  v_trial_start timestamptz := now();
  v_trial_end timestamptz;
  v_country text := nullif(btrim(coalesce(p_country, '')), '');
begin
  if p_super_admin_id is null or not exists (
    select 1 from public.super_admins
    where id = p_super_admin_id and role = 'super_admin' and is_active
  ) then
    raise exception 'Only active super admins may onboard restaurants';
  end if;

  if p_name is null or btrim(p_name) = ''
     or p_subdomain is null or p_subdomain !~ '^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$'
     or p_owner_email is null or btrim(p_owner_email) = ''
     or p_owner_user_id is null
     or p_currency not in ('PKR', 'USD', 'AED', 'GBP', 'SAR')
     or p_trial_days < 0 or p_trial_days > 365 then
    raise exception 'Invalid restaurant onboarding data';
  end if;

  -- Reserved names are routes, not restaurants. Checked here as well as by the
  -- CHECK constraint so the caller gets a usable message rather than a
  -- constraint violation.
  if p_subdomain in (
    'admin', 'api', 'assets', 'scan', 'login', 'logout', 'settings',
    'restaurants', 'subscriptions', 'plans', 'notifications', 'analytics',
    'team', 'logs', 'revenue', 'transactions', 'urls', 'dashboard', 'billing',
    'payment', 'help', 'support', 'about', 'contact', 'terms', 'privacy',
    'signup', 'signin', 'signout', 'register', 'auth',
    'new', 'null', 'undefined'
  ) then
    raise exception 'The subdomain % is reserved by the platform', p_subdomain;
  end if;

  if v_country is not null and length(v_country) > 80 then
    raise exception 'The country name is too long';
  end if;

  if length(btrim(coalesce(p_notes, ''))) > 2000 then
    raise exception 'Internal notes must be 2000 characters or fewer';
  end if;

  if exists (select 1 from public.restaurants where subdomain = p_subdomain) then
    raise exception 'The subdomain % is already in use', p_subdomain;
  end if;

  if p_plan_id is not null then
    select * into v_plan from public.subscription_plans where id = p_plan_id and is_active;
    if not found then raise exception 'The selected subscription plan is not active'; end if;

    -- Explicit per-currency mapping. The previous `else price_pkr` branch
    -- silently billed a different market's price to any currency it did not
    -- recognise, which is a money bug, not a formatting one.
    v_amount := case p_currency
      when 'USD' then v_plan.price_usd
      when 'AED' then v_plan.price_aed
      when 'PKR' then v_plan.price_pkr
      when 'GBP' then v_plan.price_gbp
      when 'SAR' then v_plan.price_sar
    end;

    if v_amount is null then
      raise exception 'The % plan has no % price configured. Add it in Plans & pricing before onboarding a % restaurant.',
        v_plan.name, p_currency, p_currency;
    end if;
  else
    v_amount := 0;
  end if;

  v_trial_end := v_trial_start + make_interval(days => p_trial_days);

  insert into public.restaurants (name, subdomain, owner_email, phone, currency, country, notes, onboarding_completed)
  values (
    btrim(p_name),
    p_subdomain,
    lower(btrim(p_owner_email)),
    nullif(btrim(p_phone), ''),
    p_currency,
    v_country,
    nullif(btrim(coalesce(p_notes, '')), ''),
    true
  )
  returning id into v_restaurant_id;

  insert into public.restaurant_admins (restaurant_id, user_id, username, role, is_active)
  values (v_restaurant_id, p_owner_user_id, lower(btrim(p_owner_email)), 'owner', true);

  insert into public.subscriptions (
    restaurant_id, plan_id, provider, status, currency, amount, trial_start, trial_end
  ) values (
    v_restaurant_id, p_plan_id, 'manual', 'trialing', p_currency, v_amount, v_trial_start, v_trial_end
  ) returning id into v_subscription_id;

  insert into public.settings (restaurant_id)
  values (v_restaurant_id)
  on conflict on constraint settings_restaurant_id_key do nothing;

  if nullif(btrim(p_admin_url), '') is not null
     or nullif(btrim(p_user_url), '') is not null
     or nullif(btrim(p_custom_domain), '') is not null then
    insert into public.restaurant_urls (restaurant_id, admin_url, user_url, custom_domain)
    values (
      v_restaurant_id,
      nullif(btrim(p_admin_url), ''),
      nullif(btrim(p_user_url), ''),
      nullif(btrim(p_custom_domain), '')
    );
  end if;

  insert into public.activity_logs (super_admin_id, restaurant_id, action, details)
  values (
    p_super_admin_id,
    v_restaurant_id,
    'restaurant.onboarded',
    jsonb_build_object(
      'owner_email', lower(btrim(p_owner_email)),
      'plan_id', p_plan_id,
      'trial_days', p_trial_days,
      'currency', p_currency,
      'country', v_country
    )
  );

  return query select v_restaurant_id, v_subscription_id;
end;
$function$;

-- Two restaurants must not claim the same custom domain: the router would have
-- no way to choose, and the second tenant would silently never be reachable.
create unique index if not exists restaurant_urls_custom_domain_key
  on public.restaurant_urls (lower(custom_domain))
  where custom_domain is not null;

-- ---------------------------------------------------------------------------
-- 6. public_tenant_by_slug()
--    What `/<slug>` needs before anyone is signed in: enough to brand the page
--    and nothing more. No owner email, no billing, no Stripe identifiers.
--    SECURITY DEFINER because the caller is anonymous and restaurants is
--    protected by RLS; the projection below is the entire exposure.
-- ---------------------------------------------------------------------------

create or replace function public.public_tenant_by_slug(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'id', restaurant.id,
    'name', restaurant.name,
    'logo_url', restaurant.logo_url,
    'currency', restaurant.currency,
    'subdomain', restaurant.subdomain,
    'phone', restaurant.phone,
    'contact_email', restaurant.contact_email,
    'address', restaurant.address
  )
  from public.restaurants restaurant
  where restaurant.subdomain = lower(btrim(coalesce(p_slug, '')))
    and restaurant.is_active
  limit 1;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Grant hygiene.
--    anon reaches exactly two functions: the QR menu and this branding lookup.
--    Everything else stays service_role only, as established by migration 001.
-- ---------------------------------------------------------------------------

revoke all on function public.public_tenant_by_slug(text) from public;
grant execute on function public.public_tenant_by_slug(text) to anon, authenticated;

revoke all on function public.onboard_restaurant(
  text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid, text, text
) from public;
revoke execute on function public.onboard_restaurant(
  text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid, text, text
) from anon, authenticated;
grant execute on function public.onboard_restaurant(
  text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid, text, text
) to service_role;

notify pgrst, 'reload schema';

commit;
