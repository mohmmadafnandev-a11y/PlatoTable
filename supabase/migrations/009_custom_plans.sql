-- 009 — custom plans: any number of days, and plans that belong to one tenant.
--
-- Requirement: when onboarding a restaurant the operator must be able to either
-- pick a catalogue plan (monthly / yearly) or define a custom one — "90 days for
-- PKR 5,000, no trial" — and have that plan exist in Plans & pricing and in
-- Stripe like any other.
--
-- The alternative was a separate one-off column set on `subscriptions`, but that
-- would have created a second kind of subscription that the renewals calendar,
-- the sweep, checkout and the plan screens would all have to special-case. A
-- custom plan is still a plan; it just bills on days instead of months.
--
-- Additive only.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. A plan needs to be able to bill every N days.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.subscription_plans drop constraint if exists subscription_plans_interval_check;
alter table public.subscription_plans
  add constraint subscription_plans_interval_check
  check (interval in ('day', 'month', 'year'));

-- The old bound was 36, which silently ruled out a 45 or 90 day custom plan —
-- and `interval: 'day', interval_count: 90` is exactly how Stripe is told to
-- bill every 90 days. Stripe accepts up to 365 for a day interval.
alter table public.subscription_plans drop constraint if exists subscription_plans_interval_count_check;
alter table public.subscription_plans
  add constraint subscription_plans_interval_count_check
  check (interval_count between 1 and 365);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Which plans are for one restaurant, and which are for sale.
-- ─────────────────────────────────────────────────────────────────────────────
-- `is_custom` records that the plan was created for a single restaurant from the
-- onboarding form. `is_public` is what keeps those out of the onboarding plan
-- dropdown, so two years of bespoke deals do not bury the three real plans.
-- They are separate flags because a plan can legitimately be off-catalogue
-- without being bespoke.
alter table public.subscription_plans
  add column if not exists is_custom boolean not null default false,
  add column if not exists is_public boolean not null default true;

create index if not exists subscription_plans_public_active_idx
  on public.subscription_plans (is_public, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. duration_days must agree with a day interval.
-- ─────────────────────────────────────────────────────────────────────────────
-- The 005 trigger mapped every non-year interval to 30 days, so a 90 day plan
-- would have reported a 30 day cycle on every screen that shows one. The trigger
-- stays the single source of this derivation.
create or replace function public.subscription_plans_sync_duration()
returns trigger
language plpgsql
as $$
begin
  new.duration_days := case new.interval
    when 'day' then new.interval_count
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

-- Correct existing rows so a stored duration cannot disagree with its interval.
update public.subscription_plans
set duration_days = case interval
  when 'day' then interval_count
  when 'year' then 365 * interval_count
  else 30 * interval_count
end;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. A custom plan is priced in one currency, and that is not a defect.
-- ─────────────────────────────────────────────────────────────────────────────
-- `price_usd`, `price_aed` and `price_pkr` are NOT NULL, so a custom plan priced
-- only in PKR stores 0 for the other two. Zero already means "not sold in this
-- currency" everywhere it is read: `resolvePlanPrice` returns null for it and
-- checkout refuses with a sentence naming the missing price. What must not
-- happen is 0 being treated as a real price of zero, which is why checkout
-- treats a missing price as a refusal rather than a free subscription.
--
-- Nothing to change in the schema — this comment exists so the 0 is not
-- "cleaned up" later by someone reading it as bad data.
