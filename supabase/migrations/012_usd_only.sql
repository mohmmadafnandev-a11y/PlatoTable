-- 012 — one currency: USD.
--
-- The platform sold plans in PKR, AED, GBP and SAR, every screen carried a
-- currency of its own, and the same restaurant could be read in one currency
-- while being billed in another. That is gone: plans are priced in dollars, a
-- restaurant is billed in dollars, and every figure in both panels and on the
-- landing page is a dollar figure.
--
-- This migration makes the stored data agree with that decision rather than
-- leaving the screens to translate on the way out. Historical rows are the only
-- reason it has to convert anything:
--
--   * A plan priced only outside USD is converted into USD with the rates in
--     `currency_rates`, then every legacy price column is set to 0. Zero is the
--     honest value for "this plan is not sold in that currency": `resolvePlanPrice`
--     treats it as unpriced and checkout refuses, whereas leaving the old figure
--     would keep selling a dirham price the platform no longer honours.
--   * Restaurants, subscriptions, payments and wallet entries are rewritten in
--     USD. A subscription that sits on a catalogue plan takes that plan's USD
--     price, so the recurring amount matches what the plan screen says; anything
--     without a USD plan price — a bespoke plan, a manual row — is converted from
--     the currency it was recorded in.
--
-- The `stripe_price_*` ids of withdrawn currencies are deliberately left in
-- place. They are the only handle on those Stripe Price objects, and the next
-- save of a plan deactivates exactly the prices it still holds an id for. Nulling
-- them here would strand live test-mode prices in Stripe with nothing pointing
-- at them.
--
-- Nothing here assumes a rate exists. `convert_money` returns null for an unknown
-- pair, and every statement falls back to the amount it already had, so a missing
-- rate can never blank out a price or set one to zero.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Plans: one USD price, and no other currency on sale.
-- ─────────────────────────────────────────────────────────────────────────────
update public.subscription_plans
set price_usd = coalesce(
  round(
    coalesce(
      convert_money(nullif(price_pkr, 0), 'PKR', 'USD'),
      convert_money(nullif(price_aed, 0), 'AED', 'USD'),
      convert_money(nullif(price_gbp, 0), 'GBP', 'USD'),
      convert_money(nullif(price_sar, 0), 'SAR', 'USD')
    ),
    2
  ),
  price_usd,
  0
)
where coalesce(price_usd, 0) = 0;

update public.subscription_plans
set price_aed = 0,
    price_pkr = 0,
    price_gbp = 0,
    price_sar = 0
where price_aed <> 0 or price_pkr <> 0 or price_gbp <> 0 or price_sar <> 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Every restaurant bills in dollars.
-- ─────────────────────────────────────────────────────────────────────────────
update public.restaurants
set currency = 'USD'
where currency <> 'USD';

-- Narrowed, not merely re-pointed: onboarding now sends USD, and a wider check
-- would let a future write path quietly reintroduce a second currency. The other
-- money tables keep their wider check on purpose — the Stripe webhook records
-- whatever a historic subscription charges, and a rejected write there would
-- lose a real payment rather than an unwanted currency.
alter table public.restaurants drop constraint if exists restaurants_currency_check;
alter table public.restaurants
  add constraint restaurants_currency_check check (currency = 'USD');

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Subscriptions in USD.
-- ─────────────────────────────────────────────────────────────────────────────
-- Bespoke and unassigned rows first: their amount is whatever they were recorded
-- with, converted.
update public.subscriptions
set currency = 'USD',
    amount = coalesce(round(convert_money(amount, currency, 'USD'), 2), amount)
where currency <> 'USD' and plan_id is null;

-- A subscription on a catalogue plan is re-priced from that plan, so the figure
-- the restaurant is billed matches the figure the plan screen advertises.
update public.subscriptions s
set currency = 'USD',
    amount = case
      when coalesce(p.price_usd, 0) > 0 then p.price_usd
      else coalesce(round(convert_money(s.amount, s.currency, 'USD'), 2), s.amount)
    end
from public.subscription_plans p
where p.id = s.plan_id
  and s.currency <> 'USD';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Payments and wallet movements already collected.
-- ─────────────────────────────────────────────────────────────────────────────
update public.payment_transactions
set currency = 'USD',
    amount = coalesce(round(convert_money(amount, currency, 'USD'), 2), amount)
where currency <> 'USD';

update public.wallet_transactions
set currency = 'USD',
    amount = coalesce(round(convert_money(amount, currency, 'USD'), 2), amount)
where currency <> 'USD';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Platform settings.
-- ─────────────────────────────────────────────────────────────────────────────
update public.platform_settings
set default_currency = 'USD'
where default_currency <> 'USD';
