-- 022 — Finish the Stripe → Safepay rename inside the billing read model.
--
-- Migration 021 moved the money, the plans and the webhook to Safepay but left
-- two database objects saying "Stripe". Both are strings/functions the UI or the
-- operator actually sees, so they are worth a migration rather than a comment:
--
--   1. `super_admin_upcoming_payments` still returned a column named
--      `has_stripe`, while the renewals calendar on the Billing screen now reads
--      `has_safepay` — so the "Card on file" column rendered "Not yet" for every
--      restaurant, including ones Safepay is already billing.
--
--   2. `billing_sweep` still wrote "Stripe reported a failed charge of ... " into
--      the platform notification feed.
--
-- Deliberately NOT touched: the historical migrations (005, 006, 009, 010, 012)
-- that mention Stripe in their comments or create `stripe_*` columns. They are
-- applied history; 021 re-pointed the live columns at Safepay and left the old
-- ones in place as the only handle on prices that still exist in Stripe.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The renewals calendar reports whether Safepay holds the subscription.
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
      -- Renamed from `has_stripe` in 022: the client reads `has_safepay`, and a
      -- renamed column is a breaking change for any caller still on the old name
      -- (the only one is this panel, which is updated in the same release).
      s.provider_subscription_id is not null as has_safepay,
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

-- Grants follow 018: reachable as a signed-in staff session, never anonymous.
revoke all on function public.super_admin_upcoming_payments(integer) from public, anon;
grant execute on function public.super_admin_upcoming_payments(integer) to authenticated, postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The billing sweep names the provider that actually reported the failure.
--
--    Body is migration 007's, unchanged except for that one word: the sweep's
--    branching (due soon → grace → suspend → record failures) is the live
--    behaviour and is not being altered here.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.billing_sweep(p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_role text := coalesce(auth.role(), '');
  v_warning integer;
  v_grace integer;
  v_warnings integer := 0;
  v_grace_warn integer := 0;
  v_failed integer := 0;
  v_suspended integer := 0;
  v_suspended_list jsonb := '[]'::jsonb;
  r record;
begin
  if v_role <> 'service_role' and not public.is_platform_staff() then
    raise exception 'Only the platform or the billing job may run a billing sweep';
  end if;

  select settings.trial_warning_days, settings.grace_period_days
    into v_warning, v_grace
  from public.platform_settings settings
  limit 1;
  v_warning := coalesce(v_warning, 3);
  v_grace := coalesce(v_grace, 0);

  -- ── Due soon: the trial is ending, or a paid period is ────────────────────
  for r in
    select
      s.restaurant_id, s.status, s.amount, s.currency, rest.name,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at,
      public.subscription_on_trial(s.status, s.trial_end, s.current_period_end) as on_trial
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) > now()
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          <= now() + make_interval(days => v_warning)
  loop
    declare
      v_days integer := greatest(1, ceil(extract(epoch from (r.due_at - now())) / 86400.0)::integer);
      v_plural text := case when v_days = 1 then '' else 's' end;
      v_key text := 'billing-due:' || r.restaurant_id || ':' || to_char(r.due_at, 'YYYY-MM-DD');
      v_kind text := case when r.on_trial then 'free trial' else 'billing period' end;
      v_action_restaurant text := case when r.on_trial then 'Add billing method' else 'Review billing' end;
    begin
      if not p_dry_run then
        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'warning',
          format('Your %s ends in %s day%s', v_kind, v_days, v_plural),
          format('Add a billing method before %s to keep %s live. After that there is a %s day grace period, then the menu goes offline.',
                 to_char(r.due_at, 'DD Mon YYYY'), r.name, v_grace),
          'yellow', v_key || ':restaurant', '/admin/subscription', v_action_restaurant
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'warning',
          format('%s: %s ends in %s day%s', r.name, v_kind, v_days, v_plural),
          format('%s has not paid yet. %s ends %s; plan value %s.',
                 r.name, initcap(v_kind), to_char(r.due_at, 'DD Mon YYYY'), public.s_amount(r.amount, r.currency)),
          'yellow', v_key || ':platform', '/admin/subscriptions', 'Open subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_warnings := v_warnings + 1;
    end;
  end loop;

  -- ── Due date passed, grace still running ──────────────────────────────────
  for r in
    select
      s.restaurant_id, s.status, s.amount, s.currency, rest.name,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at,
      public.subscription_on_trial(s.status, s.trial_end, s.current_period_end) as on_trial
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) <= now()
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          + make_interval(days => v_grace) > now()
  loop
    declare
      v_left integer := greatest(0, ceil(extract(epoch from ((r.due_at + make_interval(days => v_grace)) - now())) / 86400.0)::integer);
      v_plural text := case when v_left = 1 then '' else 's' end;
      v_key text := 'grace-ending:' || r.restaurant_id || ':' || to_char(r.due_at, 'YYYY-MM-DD');
      v_period text := case when r.on_trial then 'trial' else 'billing period' end;
    begin
      if not p_dry_run then
        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'critical',
          case when v_left = 0 then 'Your menu goes offline today'
               else format('%s day%s left before your menu goes offline', v_left, v_plural) end,
          case when v_left = 0
            then 'Your grace period ends today. Add a billing method to keep your menu online.'
            else format('We are holding your menu online for %s more day%s. Add a billing method to avoid an interruption.', v_left, v_plural)
          end,
          'red', v_key || ':restaurant', '/admin/subscription', 'Renew now'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'critical',
          case when v_left = 0 then format('%s: grace period ends today', r.name)
               else format('%s: grace ends in %s day%s', r.name, v_left, v_plural) end,
          format('%s is in grace after its %s ended unpaid. It will be suspended automatically when grace runs out.', r.name, v_period),
          'red', v_key || ':platform', '/admin/subscriptions', 'Review subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_grace_warn := v_grace_warn + 1;
    end;
  end loop;

  -- ── Grace spent: suspend ──────────────────────────────────────────────────
  for r in
    select
      s.id, s.restaurant_id, s.status, s.updated_at, rest.name,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          + make_interval(days => v_grace) <= now()
  loop
    declare
      v_key text := 'suspended:' || r.restaurant_id || ':' || to_char(r.due_at, 'YYYY-MM-DD');
    begin
      if not p_dry_run then
        update public.subscriptions set status = 'suspended', updated_at = now() where id = r.id;
        update public.restaurants set is_active = false, updated_at = now() where id = r.restaurant_id;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'critical',
          'Your menu is offline',
          format('The %s day grace period after your billing date passed, so %s has been suspended. Renew to restore the menu for your guests.', v_grace, r.name),
          'red', v_key || ':restaurant', '/admin/subscription', 'Renew subscription'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'critical',
          format('%s suspended automatically', r.name),
          format('%s did not pay within its %s day grace period and has been suspended by the billing sweep. Its QR menus now return unavailable.', r.name, v_grace),
          'red', v_key || ':platform', '/admin/subscriptions', 'Open subscription'
        )
        on conflict (dedupe_key) do nothing;

        v_suspended_list := v_suspended_list || jsonb_build_object('restaurant_id', r.restaurant_id, 'name', r.name, 'from_status', r.status);
      end if;
      v_suspended := v_suspended + 1;
    end;
  end loop;

  -- ── A recorded failure is news the moment it happens ──────────────────────
  for r in
    select s.restaurant_id, s.current_period_end, s.trial_end, s.created_at, s.status, s.amount, s.currency, rest.name
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status = 'past_due'
      and s.last_payment_status = 'failed'
  loop
    declare
      v_key text := 'payment-failed:' || r.restaurant_id || ':' ||
        coalesce(to_char(public.subscription_due_at(r.status, r.trial_end, r.current_period_end, r.created_at), 'YYYY-MM-DD'), 'unknown');
    begin
      if not p_dry_run then
        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'critical',
          'Payment failed',
          format('We could not charge %s. Update your payment method to avoid losing access to your menu.', public.s_amount(r.amount, r.currency)),
          'red', v_key || ':restaurant', '/admin/payment', 'Update payment method'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'critical',
          format('Payment failed for %s', r.name),
          format('Safepay reported a failed charge of %s for %s. It stays in grace until it pays or is suspended.', public.s_amount(r.amount, r.currency), r.name),
          'red', v_key || ':platform', '/admin/subscriptions', 'Open subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_failed := v_failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'due_soon', v_warnings,
    'grace_warnings', v_grace_warn,
    'payment_failures', v_failed,
    'suspended', v_suspended,
    'suspended_restaurants', v_suspended_list,
    'trial_warning_days', v_warning,
    'grace_period_days', v_grace,
    'ran_at', now()
  );
end;
$function$;

-- Same grant shape 018 settled on: the scheduled job and platform staff only.
revoke all on function public.billing_sweep(boolean) from public, anon, authenticated;
grant execute on function public.billing_sweep(boolean) to postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rows the sweep already wrote keep the old provider's name otherwise.
--    Only the one sentence changes; the dedupe keys are untouched, so this
--    cannot resurrect a notification that was intentionally suppressed.
-- ─────────────────────────────────────────────────────────────────────────────
update public.system_notifications
   set message = replace(message, 'Stripe reported a failed charge', 'Safepay reported a failed charge')
 where message like 'Stripe reported a failed charge%';
