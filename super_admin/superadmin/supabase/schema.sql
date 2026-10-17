-- Plato Table Super Admin migration
-- Run once in the SAME Supabase project as the restaurant app.
-- This script only adds new platform tables/functions; it never drops or
-- changes existing restaurant tables.

create table if not exists public.super_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  role text not null default 'super_admin' check (role in ('super_admin', 'support', 'billing')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  price_usd numeric(10,2) not null default 19 check (price_usd >= 0),
  price_aed numeric(10,2) not null default 79 check (price_aed >= 0),
  price_pkr numeric(12,2) not null default 2000 check (price_pkr >= 0),
  duration_days integer not null default 30 check (duration_days > 0),
  trial_days integer not null default 7 check (trial_days >= 0),
  features jsonb not null default '[]'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.subscription_plans add column if not exists stripe_price_usd text;
alter table public.subscription_plans add column if not exists stripe_price_aed text;
alter table public.subscription_plans add column if not exists stripe_price_pkr text;

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  plan_id uuid references public.subscription_plans(id) on delete set null,
  provider text not null default 'stripe' check (provider in ('stripe', 'manual')),
  provider_customer_id text unique,
  provider_subscription_id text unique,
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'suspended', 'canceled')),
  currency text not null default 'PKR' check (currency in ('USD', 'AED', 'PKR')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  trial_start timestamptz,
  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  last_payment_status text check (last_payment_status in ('paid', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscriptions_trial_dates check (trial_end is null or trial_start is null or trial_end >= trial_start),
  constraint subscriptions_period_dates check (current_period_end is null or current_period_start is null or current_period_end >= current_period_start)
);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  provider text not null default 'stripe' check (provider in ('stripe', 'manual')),
  provider_transaction_id text unique,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null check (currency in ('USD', 'AED', 'PKR')),
  status text not null check (status in ('succeeded', 'failed', 'refunded')),
  payment_method text,
  card_last4 text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_brand text,
  invoice_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.system_notifications (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  type text not null default 'info' check (type in ('info', 'warning', 'critical', 'success')),
  title text not null,
  message text not null,
  background_color text not null default 'white' check (background_color in ('white', 'red', 'green', 'yellow')),
  is_read boolean not null default false,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  super_admin_id uuid references public.super_admins(id) on delete set null,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_urls (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  admin_url text,
  user_url text,
  custom_domain text,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurant_urls_has_mapping check (admin_url is not null or user_url is not null or custom_domain is not null)
);

create table if not exists public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null check (currency in ('USD', 'AED', 'PKR')),
  type text not null check (type in ('credit', 'debit', 'payout')),
  source text not null check (source in ('stripe', 'manual', 'refund')),
  restaurant_id uuid references public.restaurants(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  stripe_payout_id text unique,
  notes text,
  created_at timestamptz not null default now()
);

-- Required by the System Settings screen. Secrets stay in Vercel/Supabase
-- Edge Function environment variables, never in this table.
create table if not exists public.platform_settings (
  id boolean primary key default true check (id),
  platform_name text not null default 'Plato Table',
  support_email text,
  support_phone text,
  default_currency text not null default 'PKR' check (default_currency in ('USD', 'AED', 'PKR')),
  default_trial_days integer not null default 7 check (default_trial_days >= 0),
  grace_period_days integer not null default 3 check (grace_period_days >= 0),
  trial_enabled boolean not null default true,
  notifications_enabled boolean not null default true,
  maintenance_mode boolean not null default false,
  maintenance_message text,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

create index if not exists subscriptions_status_idx on public.subscriptions(status);
create index if not exists subscriptions_restaurant_idx on public.subscriptions(restaurant_id);
create index if not exists transactions_restaurant_created_idx on public.payment_transactions(restaurant_id, created_at desc);
create index if not exists notifications_restaurant_created_idx on public.system_notifications(restaurant_id, created_at desc);
create index if not exists activity_logs_created_idx on public.activity_logs(created_at desc);
create unique index if not exists restaurant_urls_one_primary_idx on public.restaurant_urls(restaurant_id) where is_primary;

-- Avoid policy recursion by checking the authenticated user through a definer
-- function. Never grant this capability to anon users.
create or replace function public.super_admin_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.super_admins where user_id = auth.uid() and is_active = true limit 1;
$$;
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.super_admin_role() = 'super_admin', false);
$$;
create or replace function public.is_platform_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.super_admin_role() is not null;
$$;

revoke all on function public.super_admin_role() from public;
revoke all on function public.is_super_admin() from public;
revoke all on function public.is_platform_staff() from public;
grant execute on function public.super_admin_role() to authenticated;
grant execute on function public.is_super_admin() to authenticated;
grant execute on function public.is_platform_staff() to authenticated;

alter table public.super_admins enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.system_notifications enable row level security;
alter table public.activity_logs enable row level security;
alter table public.restaurant_urls enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.platform_settings enable row level security;

-- Platform staff can read all operational data. Only full super admins can
-- mutate platform configuration; billing may mutate subscription records.
drop policy if exists super_admins_self_read on public.super_admins;
create policy super_admins_self_read on public.super_admins for select to authenticated using (user_id = auth.uid() or public.is_super_admin());
drop policy if exists super_admins_full_admin on public.super_admins;
create policy super_admins_full_admin on public.super_admins for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists plans_platform_read on public.subscription_plans;
create policy plans_platform_read on public.subscription_plans for select to authenticated using (public.is_platform_staff());
drop policy if exists plans_full_admin on public.subscription_plans;
create policy plans_full_admin on public.subscription_plans for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists subscriptions_platform_read on public.subscriptions;
create policy subscriptions_platform_read on public.subscriptions for select to authenticated using (public.is_platform_staff());
drop policy if exists subscriptions_billing_write on public.subscriptions;
create policy subscriptions_billing_write on public.subscriptions for all to authenticated using (public.super_admin_role() in ('super_admin', 'billing')) with check (public.super_admin_role() in ('super_admin', 'billing'));

drop policy if exists transactions_platform_read on public.payment_transactions;
create policy transactions_platform_read on public.payment_transactions for select to authenticated using (public.is_platform_staff());
drop policy if exists transactions_full_admin on public.payment_transactions;
create policy transactions_full_admin on public.payment_transactions for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

drop policy if exists notifications_platform_staff on public.system_notifications;
create policy notifications_platform_staff on public.system_notifications for all to authenticated using (public.is_platform_staff()) with check (public.is_platform_staff());
drop policy if exists activity_platform_read on public.activity_logs;
create policy activity_platform_read on public.activity_logs for select to authenticated using (public.is_platform_staff());
drop policy if exists activity_platform_insert on public.activity_logs;
create policy activity_platform_insert on public.activity_logs for insert to authenticated with check (public.is_platform_staff());
drop policy if exists urls_platform_staff on public.restaurant_urls;
create policy urls_platform_staff on public.restaurant_urls for all to authenticated using (public.is_platform_staff()) with check (public.is_platform_staff());
drop policy if exists wallet_platform_read on public.wallet_transactions;
create policy wallet_platform_read on public.wallet_transactions for select to authenticated using (public.is_platform_staff());
drop policy if exists wallet_full_admin on public.wallet_transactions;
create policy wallet_full_admin on public.wallet_transactions for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists settings_platform_read on public.platform_settings;
create policy settings_platform_read on public.platform_settings for select to authenticated using (public.is_platform_staff());
drop policy if exists settings_full_admin on public.platform_settings;
create policy settings_full_admin on public.platform_settings for all to authenticated using (public.is_super_admin()) with check (public.is_super_admin());

-- Read-only platform RPC used by the Super Admin UI. It avoids weakening the
-- existing restaurant RLS policies while exposing only platform staff data.
create or replace function public.super_admin_restaurants()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', restaurant.id,
    'name', restaurant.name,
    'owner_email', restaurant.owner_email,
    'phone', restaurant.phone,
    'contact_email', restaurant.contact_email,
    'subdomain', restaurant.subdomain,
    'currency', restaurant.currency,
    'created_at', restaurant.created_at,
    'subscription', case when subscription.id is null then null else jsonb_build_object(
      'id', subscription.id, 'status', subscription.status, 'amount', subscription.amount,
      'currency', subscription.currency, 'trial_end', subscription.trial_end,
      'current_period_end', subscription.current_period_end
    ) end,
    'urls', coalesce((select jsonb_agg(jsonb_build_object('id', url.id, 'admin_url', url.admin_url, 'user_url', url.user_url, 'custom_domain', url.custom_domain, 'is_primary', url.is_primary)) from public.restaurant_urls url where url.restaurant_id = restaurant.id), '[]'::jsonb)
  ) order by restaurant.created_at desc), '[]'::jsonb)
  from public.restaurants restaurant
  left join public.subscriptions subscription on subscription.restaurant_id = restaurant.id
  where public.is_platform_staff();
$$;
revoke all on function public.super_admin_restaurants() from public;
grant execute on function public.super_admin_restaurants() to authenticated;

-- The onboarding API creates the Auth user first, then invokes this single
-- transaction for every application-table write. It is deliberately callable
-- only by the Supabase service-role backend, never a browser session.
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
  p_super_admin_id uuid default null
)
returns table (restaurant_id uuid, subscription_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_restaurant_id uuid;
  v_subscription_id uuid;
  v_plan public.subscription_plans%rowtype;
  v_amount numeric(12,2) := 0;
  v_trial_start timestamptz := now();
  v_trial_end timestamptz;
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
     or p_currency not in ('USD', 'AED', 'PKR')
     or p_trial_days < 0 or p_trial_days > 365 then
    raise exception 'Invalid restaurant onboarding data';
  end if;

  if p_plan_id is not null then
    select * into v_plan from public.subscription_plans where id = p_plan_id and is_active;
    if not found then raise exception 'The selected subscription plan is not active'; end if;
    v_amount := case p_currency
      when 'USD' then v_plan.price_usd
      when 'AED' then v_plan.price_aed
      else v_plan.price_pkr
    end;
  end if;

  v_trial_end := v_trial_start + make_interval(days => p_trial_days);

  insert into public.restaurants (name, subdomain, owner_email, phone, currency)
  values (btrim(p_name), p_subdomain, lower(btrim(p_owner_email)), nullif(btrim(p_phone), ''), p_currency)
  returning id into v_restaurant_id;

  -- Supabase Auth is the credential authority. This legacy required column is
  -- intentionally an irreversible value that is not derived from the password.
  insert into public.restaurant_admins (restaurant_id, user_id, username, password_hash, role, is_active)
  values (v_restaurant_id, p_owner_user_id, lower(btrim(p_owner_email)), md5(p_owner_user_id::text), 'admin', true);

  insert into public.subscriptions (
    restaurant_id, plan_id, provider, status, currency, amount, trial_start, trial_end
  ) values (
    v_restaurant_id, p_plan_id, 'manual', 'trialing', p_currency, v_amount, v_trial_start, v_trial_end
  ) returning id into v_subscription_id;

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
    jsonb_build_object('owner_email', lower(btrim(p_owner_email)), 'plan_id', p_plan_id, 'trial_days', p_trial_days)
  );

  return query select v_restaurant_id, v_subscription_id;
end;
$$;
revoke all on function public.onboard_restaurant(text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid) from public;
grant execute on function public.onboard_restaurant(text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid) to service_role;

-- Bootstrap steps:
-- 1. Create the first Auth user in Supabase Authentication.
-- 2. Replace the values below with that Auth user's UUID, email, and name.
-- insert into public.super_admins (user_id, email, name, role)
-- values ('AUTH_USER_UUID', 'platotable@gmail.com', 'Platform Owner', 'super_admin');

-- Trial eligibility is permanent. It is set at trial start or when a restaurant
-- chooses to pay immediately, and must never be cleared on cancellation.
alter table public.subscriptions add column if not exists trial_used_at timestamptz;
update public.subscriptions
set trial_used_at = coalesce(trial_start, created_at)
where trial_used_at is null and (status = 'trialing' or provider = 'stripe');

-- Super admins can maintain the restaurant profile. Restaurant-owner policies
-- remain separate and are not weakened for non-platform users.
drop policy if exists restaurants_super_admin_manage on public.restaurants;
create policy restaurants_super_admin_manage on public.restaurants for all to authenticated
using (public.is_super_admin()) with check (public.is_super_admin());

notify pgrst, 'reload schema';
