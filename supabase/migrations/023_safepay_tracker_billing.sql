-- Billing through Safepay's hosted checkout, tracked per attempt.
--
-- The platform switched from Safepay's Subscriptions product to the hosted
-- Checkout over a *tracker*, because Subscriptions cannot be created through the
-- API ("Subscriptions cannot be created using APIs since a customer has to
-- subscribe to a plan") and its checkout redirects every anonymous visitor to
-- Safepay's account login — a restaurant owner would have to create a Safepay
-- account before paying this platform.
--
-- With trackers, the platform keeps the cycle itself:
--
--   * a payment session (tracker) is opened for one period, the customer types a
--     card on Safepay's page, and the reporter tells us how it ended;
--   * the card can be stored in the restaurant's own merchant-managed customer
--     (`provider_customer_id`, which already existed), and later charged with a
--     merchant-initiated transaction.
--
-- `subscriptions` is therefore missing only the handles that model needs: which
-- tracker is in flight, which card is on file, and when the last charge was
-- attempted.

alter table public.subscriptions
  -- The payment session the row is waiting on, and the id a webhook or a return
  -- trip arrives with. Kept after it settles so a duplicate delivery can still be
  -- matched to the restaurant it was for.
  add column if not exists safepay_tracker_id text,
  -- The card in the customer's Safepay wallet (`pm_...`), and the Cybersource
  -- pointer (`tms_...`) a merchant-initiated charge is authorised with. They are
  -- separate values because the wallet API names one and the authorization
  -- action accepts only the other.
  add column if not exists safepay_payment_method_id text,
  add column if not exists safepay_card_pointer text,
  -- The card as a person reads it. Brand and last four are all Safepay gives a
  -- merchant, and all this platform is allowed to hold.
  add column if not exists card_brand text,
  add column if not exists card_last4 text,
  add column if not exists card_exp_month text,
  add column if not exists card_exp_year text,
  -- When a charge last actually settled, and when the renewal engine last tried.
  -- The second one is what stops a failed card from being hammered on every pass
  -- of the sweep.
  add column if not exists last_charge_at timestamptz,
  add column if not exists renewal_attempted_at timestamptz;

comment on column public.subscriptions.safepay_tracker_id is
  'Safepay payment session (track_...) this subscription is waiting on, or the last one used.';
comment on column public.subscriptions.safepay_payment_method_id is
  'Card stored in the restaurant''s merchant-managed Safepay customer (pm_...).';
comment on column public.subscriptions.safepay_card_pointer is
  'Cybersource token (tms_...) a merchant-initiated charge is authorised with.';
comment on column public.subscriptions.renewal_attempted_at is
  'When the renewal engine last tried to charge this subscription, successfully or not.';

-- A webhook and the return trip both arrive with a tracker id and nothing else,
-- so this is the lookup that has to be fast.
create index if not exists subscriptions_safepay_tracker_idx
  on public.subscriptions (safepay_tracker_id)
  where safepay_tracker_id is not null;

-- The renewal engine asks for "due, and chargeable" on every sweep.
create index if not exists subscriptions_renewal_idx
  on public.subscriptions (status, cancel_at_period_end, current_period_end)
  where provider = 'safepay';

-- ─────────────────────────────────────────────────────────────────────────────
-- The renewals calendar: "card on file" now means the card Safepay holds for
-- this restaurant, not a subscription object.
--
-- 022 taught this function that the column is called `has_safepay`, but it read
-- it from `provider_subscription_id` — an id of the Subscriptions product the
-- platform no longer uses, so with trackers that column would say "Not yet" for
-- every restaurant, including the ones whose card the platform can and will
-- charge. It asks the two columns that mean something now: the wallet entry and
-- the tracked charge. The card's brand and last four travel with it, because a
-- restaurant whose card is on file should see which card that is.
--
-- Body is 022's; the changes are the two lines around `has_safepay` and the two
-- imported card columns.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.super_admin_upcoming_payments(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_rows jsonb;
  v_totals jsonb;
begin
  if not public.is_platform_staff() then
    raise exception 'Only platform staff can read the renewals calendar';
  end if;

  select coalesce(jsonb_agg(row_to_json(entry) order by entry.due_at), '[]'::jsonb)
    into v_rows
  from (
    select
      s.id                     as subscription_id,
      s.restaurant_id,
      rest.name                as restaurant_name,
      rest.subdomain,
      rest.country,
      rest.currency            as restaurant_currency,
      plan.name                as plan_name,
      plan.interval,
      plan.interval_count,
      s.status,
      s.amount,
      s.currency,
      s.last_payment_status,
      -- A saved card, or a subscription object from before the tracker switch.
      (s.safepay_payment_method_id is not null or s.provider_subscription_id is not null) as has_safepay,
      s.card_brand,
      s.card_last4,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at,
      case when public.subscription_on_trial(s.status, s.trial_end, s.current_period_end)
           then 'trial_ends' else 'renews' end as kind,
      greatest(0, ceil(extract(epoch from (public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) - now())) / 86400.0)::integer) as days_until
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    left join public.subscription_plans plan on plan.id = s.plan_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          between now() - interval '1 day' and now() + make_interval(days => v_days)
  ) entry;

  select coalesce(jsonb_agg(row_to_json(total) order by total.currency), '[]'::jsonb)
    into v_totals
  from (
    select entry.currency, count(*) as count, sum(entry.amount) as amount
    from jsonb_to_recordset(v_rows) as entry(currency text, amount numeric)
    group by entry.currency
  ) total;

  return jsonb_build_object('window_days', v_days, 'upcoming', v_rows, 'totals', v_totals, 'generated_at', now());
end;
$function$;

-- Grants follow 018/022: reachable as a signed-in staff session, never anonymous.
revoke all on function public.super_admin_upcoming_payments(integer) from public, anon;
grant execute on function public.super_admin_upcoming_payments(integer) to authenticated, postgres, service_role;
