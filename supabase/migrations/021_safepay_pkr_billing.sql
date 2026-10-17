-- 021 — Safepay subscriptions, PKR billing, and the webhook event ledger.
--
-- Three changes, all in service of one decision: the platform takes money
-- through Safepay, in PKR, instead of through Stripe in dollars.
--
--   1. `subscription_plans` gains the Safepay plan tokens. A Safepay plan is
--      immutable in the same way a Stripe price is — the amount is fixed when it
--      is created — so a plan whose price changes gets a *new* token, exactly as
--      it used to get a new Stripe price. Two tokens per plan: one carrying the
--      trial period and one without, because Safepay's trial lives on the plan,
--      and a cancel-and-resubscribe would otherwise hand out a second free trial.
--
--   2. The money moves to PKR: plan prices, the restaurant's currency, the
--      subscription, and any payments already recorded. Dollar figures are
--      converted at the rate already stored in `currency_rates`, and the plan the
--      business actually sells is set to the price on the shelf (PKR 2,000/month)
--      rather than a converted one.
--
--   3. `billing_events` — Safepay asks every integration to persist the raw
--      webhook before acting on it and to process each event exactly once. This
--      is that table: RLS on, no policies, nothing but the service role can read
--      or write it.
--
-- Nothing here assumes a rate exists: a missing rate leaves the figure it found,
-- so a price can never be silently converted to zero.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Safepay plan tokens on the catalogue.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.subscription_plans
  add column if not exists safepay_plan_id text,
  add column if not exists safepay_plan_id_trial text,
  add column if not exists safepay_synced_at timestamptz,
  add column if not exists safepay_sync_error text,
  add column if not exists safepay_sync jsonb;

comment on column public.subscription_plans.safepay_plan_id is
  'Safepay plan token for renewals (no trial period). Re-created when the price or interval changes.';
comment on column public.subscription_plans.safepay_plan_id_trial is
  'Safepay plan token that carries the trial period, used when the restaurant has never trialled.';
comment on column public.subscription_plans.safepay_sync is
  'The two payloads that produced the tokens above, so a save can tell whether Safepay needs new ones.';

create unique index if not exists subscription_plans_safepay_plan_unique
  on public.subscription_plans (safepay_plan_id)
  where safepay_plan_id is not null;

create unique index if not exists subscription_plans_safepay_plan_trial_unique
  on public.subscription_plans (safepay_plan_id_trial)
  where safepay_plan_id_trial is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One currency: PKR.
-- ─────────────────────────────────────────────────────────────────────────────
-- Plans first: a plan priced only in dollars is converted, so nothing is left on
-- sale at the old figure. `currency_rates` stores one USD-based row, so the PKR
-- rate is read out of its jsonb.
update public.subscription_plans p
set price_pkr = round(coalesce(p.price_usd, 0) * rate.value, 2)
from (
  select (rates ->> 'PKR')::numeric as value
  from public.currency_rates
  where base = 'USD'
  limit 1
) rate
where coalesce(p.price_pkr, 0) = 0
  and coalesce(p.price_usd, 0) > 0
  and rate.value is not null;

-- The plan on the shelf, priced to match the Safepay plan the operator created
-- (PKR 2,000 per month). Every other plan keeps its converted figure and can be
-- re-priced from the panel.
update public.subscription_plans set price_pkr = 2000 where name = 'Basic Monthly';

-- The currencies the platform no longer sells in are written as 0, which is the
-- honest value for "not sold in this currency": `resolvePlanPrice` reads 0 as
-- unpriced and refuses, whereas a leftover figure would keep selling a dollar
-- price the platform no longer honours.
update public.subscription_plans
set price_usd = 0, price_aed = 0, price_gbp = 0, price_sar = 0
where price_usd <> 0 or price_aed <> 0 or price_gbp <> 0 or price_sar <> 0;

-- Every restaurant bills in rupees. The old constraint is dropped first — it
-- permits only USD, so it would refuse this very update. The new one is
-- narrowed rather than re-pointed so a future write path cannot quietly
-- reintroduce a second currency; the other money tables keep their wider check
-- on purpose, because a webhook records whatever a historic charge was in.
alter table public.restaurants drop constraint if exists restaurants_currency_check;

update public.restaurants set currency = 'PKR' where currency <> 'PKR';

alter table public.restaurants
  add constraint restaurants_currency_check check (currency = 'PKR');

-- A subscription on a catalogue plan is re-priced from that plan, so the figure
-- the restaurant is billed matches the figure the plan screen advertises.
update public.subscriptions s
set currency = 'PKR',
    amount = case
      when coalesce(p.price_pkr, 0) > 0 then p.price_pkr
      else coalesce(round(s.amount * rate.value, 2), s.amount)
    end
from public.subscription_plans p,
     (
       select (rates ->> 'PKR')::numeric as value
       from public.currency_rates
       where base = 'USD'
       limit 1
     ) rate
where p.id = s.plan_id
  and s.currency <> 'PKR';

-- Bespoke and unassigned rows have no plan to read a price from, so their own
-- figure is converted.
update public.subscriptions s
set currency = 'PKR',
    amount = coalesce(round(s.amount * rate.value, 2), s.amount)
from (
  select (rates ->> 'PKR')::numeric as value
  from public.currency_rates
  where base = 'USD'
  limit 1
) rate
where s.currency <> 'PKR'
  and s.plan_id is null;

-- Money already collected.
update public.payment_transactions t
set currency = 'PKR',
    amount = coalesce(round(t.amount * rate.value, 2), t.amount)
from (
  select (rates ->> 'PKR')::numeric as value
  from public.currency_rates
  where base = 'USD'
  limit 1
) rate
where t.currency <> 'PKR';

-- Wallet movements, when the table is present in this deployment.
do $$
begin
  if to_regclass('public.wallet_transactions') is not null then
    execute $sql$
      update public.wallet_transactions w
      set currency = 'PKR',
          amount = coalesce(round(w.amount * rate.value, 2), w.amount)
      from (
        select (rates ->> 'PKR')::numeric as value
        from public.currency_rates
        where base = 'USD'
        limit 1
      ) rate
      where w.currency <> 'PKR'
    $sql$;
  end if;
end;
$$;

update public.platform_settings set default_currency = 'PKR' where default_currency <> 'PKR';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Safepay is a provider, and a webhook can write 'safepay' rows.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.subscriptions drop constraint if exists subscriptions_provider_check;
alter table public.subscriptions
  add constraint subscriptions_provider_check check (provider in ('stripe', 'manual', 'safepay'));

alter table public.payment_transactions drop constraint if exists payment_transactions_provider_check;
alter table public.payment_transactions
  add constraint payment_transactions_provider_check check (provider in ('stripe', 'manual', 'safepay'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The webhook event ledger.
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per delivered event, keyed on Safepay's own event id so a retry is a
-- no-op. `processed_at`/`process_error` are what makes a webhook that failed
-- inside our handler recoverable: the raw payload is still here to replay.
create table if not exists public.billing_events (
  id text primary key,
  provider text not null default 'safepay',
  type text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_error text
);

comment on table public.billing_events is
  'Raw Safepay webhook deliveries, keyed on the provider event id. Dedupe and the replay source of truth.';

create index if not exists billing_events_received_idx
  on public.billing_events (received_at desc);

create index if not exists billing_events_unprocessed_idx
  on public.billing_events (received_at)
  where processed_at is null;

alter table public.billing_events enable row level security;

-- No policies: the ledger is operator data, and only the server (service role)
-- reads or writes it.
revoke all on public.billing_events from public, anon, authenticated;
grant select, insert, update on public.billing_events to postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The public plan catalogue reads PKR and the Safepay tokens.
-- ─────────────────────────────────────────────────────────────────────────────
-- `billable_pkr` is what the subscribe button gates on, so it now answers "is
-- there a Safepay plan to send this restaurant to?" rather than "does Stripe
-- hold a price for it?".
create or replace function public.public_plans()
returns jsonb
language sql
stable security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(plan order by plan ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'interval', p.interval,
      'interval_count', p.interval_count,
      'duration_days', p.duration_days,
      'trial_days', p.trial_days,
      'features', p.features,
      'price_usd', p.price_usd,
      'price_aed', p.price_aed,
      'price_pkr', p.price_pkr,
      'price_gbp', p.price_gbp,
      'price_sar', p.price_sar,
      'safepay_plan_id', p.safepay_plan_id,
      'safepay_plan_id_trial', p.safepay_plan_id_trial,
      'billable_pkr', (p.safepay_plan_id is not null or p.safepay_plan_id_trial is not null),
      'billable_usd', false,
      'billable_aed', false,
      'billable_gbp', false,
      'billable_sar', false
    ) as plan
    from public.subscription_plans p
    where p.is_active
      and p.is_public
  ) x
$$;
