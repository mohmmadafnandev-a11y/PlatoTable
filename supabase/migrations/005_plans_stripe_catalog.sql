-- 005 — subscription_plans becomes a Stripe-backed catalog.
--
-- Additive only: no column is dropped or renamed, so the existing onboarding RPC,
-- the restaurant admin's plan read, and the subscriptions list keep working
-- untouched. Every new column is nullable or defaulted, so applying this to the
-- current (empty) table is a no-op for existing readers.
--
-- Why the interval lives here: a plan is billed either monthly or yearly, and
-- Stripe models that as `recurring.interval` + `recurring.interval_count` on a
-- Price. `duration_days` already existed for the billing-cycle display, so it is
-- kept and derived from the interval (see the trigger below) rather than
-- replaced — that would break every existing consumer.

alter table public.subscription_plans
  add column if not exists interval         text        not null default 'month',
  add column if not exists interval_count   integer     not null default 1,
  add column if not exists stripe_product_id text,
  add column if not exists stripe_price_gbp  text,
  add column if not exists stripe_price_sar  text,
  -- Proof the plan is actually in Stripe, and the reason it is not when it is
  -- not. Storing the error is what lets the screen say *why* a plan failed to
  -- sync instead of silently showing it as linked.
  add column if not exists stripe_synced_at  timestamptz,
  add column if not exists stripe_sync_error text;

-- Guard rails. Named so a failure is diagnosable rather than a bare constraint
-- violation, and added conditionally because `add constraint` has no `if not
-- exists`.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_interval_check') then
    alter table public.subscription_plans
      add constraint subscription_plans_interval_check
      check (interval in ('month', 'year'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_interval_count_check') then
    alter table public.subscription_plans
      add constraint subscription_plans_interval_count_check
      check (interval_count between 1 and 36);
  end if;

  -- A price may not be negative. NULL stays legal: GBP and SAR are optional,
  -- because a plan need not be sold in every market.
  if not exists (select 1 from pg_constraint where conname = 'subscription_plans_price_non_negative') then
    alter table public.subscription_plans
      add constraint subscription_plans_price_non_negative
      check (
        price_usd >= 0 and price_aed >= 0 and price_pkr >= 0
        and (price_gbp is null or price_gbp >= 0)
        and (price_sar is null or price_sar >= 0)
      );
  end if;
end $$;

-- Two plans called "Basic" would make the onboarding dropdown ambiguous and
-- would create two Stripe products with the same name. Case-insensitive, since
-- "Basic" and "basic" are the same plan to a reader.
create unique index if not exists subscription_plans_name_unique
  on public.subscription_plans (lower(name));

-- One Stripe product per plan. Partial, so the many not-yet-synced rows (NULL)
-- do not collide with each other.
create unique index if not exists subscription_plans_stripe_product_unique
  on public.subscription_plans (stripe_product_id)
  where stripe_product_id is not null;

-- `duration_days` is the existing display field for the billing cycle, and
-- onboarding shows it directly. Deriving it from the interval here means the two
-- can never disagree — a "1 year" plan can no longer report a 30 day cycle
-- because a caller forgot to update the second column.
create or replace function public.subscription_plans_sync_duration()
returns trigger
language plpgsql
as $$
begin
  new.duration_days := case new.interval
    when 'year' then 365 * new.interval_count
    else 30 * new.interval_count
  end;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists subscription_plans_sync_duration on public.subscription_plans;
create trigger subscription_plans_sync_duration
  before insert or update of interval, interval_count
  on public.subscription_plans
  for each row execute function public.subscription_plans_sync_duration();

-- Existing rows had no interval column, so every one of them is monthly by
-- default. Recompute so their duration_days agrees with the new derivation.
update public.subscription_plans set duration_days = 30 * interval_count;

-- RLS is unchanged and already correct: `plans_full_admin` grants super admins
-- ALL, `plans_platform_read` lets support/billing read, and restaurant admins
-- can read exactly the plan their own subscription points at.
