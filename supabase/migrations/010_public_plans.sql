-- 010 — let a restaurant read the catalogue it is allowed to buy.
--
-- The problem this fixes was found by looking at the real screen: a restaurant
-- admin's plan dropdown offered exactly one option — the plan it was already on.
-- `restaurant_admin_plan_read` is scoped to the caller's own subscription, which
-- is correct for reading *your* plan and wrong for choosing one. A restaurant
-- with no plan saw nothing at all, so "add a billing method" could only ever
-- renew the plan the platform had already assigned.
--
-- Fixed with an RPC rather than a wider table policy, for two reasons:
--
--   1. RLS cannot restrict columns. A policy permissive enough to list the
--      catalogue would also hand out `stripe_product_id`, `stripe_price_*` and
--      every other internal column. This returns a fixed, deliberate shape.
--   2. The catalogue is what a buyer needs, and that is a query, not a table.
--      When the pricing page is added later it calls the same function.
--
-- Additive only: no policy is dropped or narrowed, so nothing that reads plans
-- today changes behaviour.

create or replace function public.public_plans()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(jsonb_agg(plan order by plan ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'interval', p.interval,
      'interval_count', p.interval_count,
      -- `duration_days` is what the billing screen counts down against, and it is
      -- derived from the interval by a trigger, so it is sent rather than
      -- recomputed in the browser.
      'duration_days', p.duration_days,
      'trial_days', p.trial_days,
      'features', p.features,
      'price_usd', p.price_usd,
      'price_aed', p.price_aed,
      'price_pkr', p.price_pkr,
      'price_gbp', p.price_gbp,
      'price_sar', p.price_sar,
      -- Whether a card can actually be taken for this plan in each currency. A
      -- plan saved while Stripe was unreachable has prices but no Stripe Price,
      -- and checkout refuses it — so the buyer must not be offered it and then
      -- turned away after entering card details.
      'billable_usd', p.stripe_price_usd is not null,
      'billable_aed', p.stripe_price_aed is not null,
      'billable_pkr', p.stripe_price_pkr is not null,
      'billable_gbp', p.stripe_price_gbp is not null,
      'billable_sar', p.stripe_price_sar is not null
    ) as plan
    from public.subscription_plans p
    where p.is_active
      and p.is_public
  ) x
$$;

revoke all on function public.public_plans() from public;
-- Anonymous is deliberate: these are the same prices a marketing page shows, and
-- nothing here identifies a customer. Kept as an RPC so a leaked anon key still
-- cannot enumerate the table.
grant execute on function public.public_plans() to anon, authenticated, service_role;

-- A bespoke plan created for one restaurant is `is_public = false`, so it is
-- deliberately absent from the list above. The restaurant it belongs to still
-- reads it through `restaurant_admin_plan_read`, which is why that policy stays.
