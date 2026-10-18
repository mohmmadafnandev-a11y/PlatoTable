-- 024 — Backup days: a per-restaurant free window after a trial or paid period ends.
--
-- The platform always had a *global* grace window (platform_settings.
-- grace_period_days): after the due date everyone got the same few free days
-- before the sweep suspended them. Operators need to treat restaurants
-- differently — a new tenant gets a week of runway, a paying one gets three days
-- while a bank clears — so the window becomes per-subscription: `backup_days`.
-- When it is 0 (every existing row) the global setting still applies, so nothing
-- changes for rows nobody has touched.
--
-- The billing life now reads as three phases, drawn in three colours by both
-- panels — trial (white) → paid period (green) → backup days (yellow):
--
--   trial_start .. trial_end        the free trial
--   period_start .. period_end      the paid period
--   due_at .. due_at + backup_days  the backup window (or the global grace)

alter table public.subscriptions
  add column if not exists backup_days integer not null default 0;

do $$ begin
  alter table public.subscriptions
    add constraint subscriptions_backup_days_range check (backup_days between 0 and 365);
exception when duplicate_object then null;
end $$;

comment on column public.subscriptions.backup_days is
  'Free days after the trial or paid period ends, before the billing sweep suspends the restaurant. 0 falls back to platform_settings.grace_period_days.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The owner's own view reports the backup window.
--    Body is 007's; the additions are backup_days and the two computed fields.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.restaurant_billing(p_restaurant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_restaurant uuid;
  v_grace integer;
  v_backup integer;
  r record;
begin
  if v_user is null then
    raise exception 'Sign in to read your billing';
  end if;

  v_restaurant := coalesce(p_restaurant_id, (
    select admin.restaurant_id from public.restaurant_admins admin
    where admin.user_id = v_user and admin.is_active
    order by admin.created_at limit 1
  ));
  if v_restaurant is null or not public.is_restaurant_admin(v_restaurant) then
    raise exception 'Restaurant not found';
  end if;

  select settings.grace_period_days into v_grace from public.platform_settings settings limit 1;
  v_grace := coalesce(v_grace, 0);

  select
    s.id, s.status, s.amount, s.currency, s.trial_start, s.trial_end,
    s.current_period_start, s.current_period_end, s.cancel_at_period_end,
    s.provider_customer_id, s.last_payment_status, s.plan_id, s.backup_days,
    public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at,
    public.subscription_on_trial(s.status, s.trial_end, s.current_period_end) as on_trial,
    plan.name as plan_name, plan.interval, plan.interval_count, plan.trial_days, plan.duration_days
    into r
  from public.subscriptions s
  left join public.subscription_plans plan on plan.id = s.plan_id
  where s.restaurant_id = v_restaurant;

  if r.id is null then
    return jsonb_build_object('has_subscription', false);
  end if;

  -- The window that actually protects this restaurant: its own backup days when
  -- set, the platform-wide grace otherwise.
  v_backup := coalesce(nullif(r.backup_days, 0), v_grace);

  return jsonb_build_object(
    'has_subscription', true,
    'subscription_id', r.id,
    'status', r.status,
    'plan_id', r.plan_id,
    'plan_name', r.plan_name,
    'interval', r.interval,
    'interval_count', r.interval_count,
    'trial_days', r.trial_days,
    'duration_days', r.duration_days,
    'amount', r.amount,
    'currency', r.currency,
    'trial_start', r.trial_start,
    'trial_end', r.trial_end,
    'period_start', r.current_period_start,
    'period_end', r.current_period_end,
    'cancel_at_period_end', r.cancel_at_period_end,
    'last_payment_status', r.last_payment_status,
    'has_payment_method', r.provider_customer_id is not null,
    'due_at', r.due_at,
    'on_trial', r.on_trial,
    'grace_period_days', v_grace,
    'backup_days', r.backup_days,
    'backup_window_days', v_backup,
    'using_backup_days', r.backup_days > 0,
    'backup_starts_at', r.due_at,
    'backup_ends_at', r.due_at + make_interval(days => v_backup),
    'access_ends_at', r.due_at + make_interval(days => v_backup),
    'days_remaining', case when r.due_at is null then null
      else ceil(extract(epoch from (r.due_at - now())) / 86400.0)::integer end,
    'grace_days_remaining', case when r.due_at is null then null
      else greatest(0, ceil(extract(epoch from ((r.due_at + make_interval(days => v_backup)) - now())) / 86400.0)::integer) end
  );
end;
$function$;

revoke all on function public.restaurant_billing(uuid) from public, anon;
grant execute on function public.restaurant_billing(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The sweep reads the per-row window instead of the global one.
--    Body is 022's; the change is `coalesce(nullif(s.backup_days, 0), v_grace)`
--    wherever the grace length was used, and wording that says "backup days"
--    when a restaurant has its own window.
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
      coalesce(nullif(s.backup_days, 0), v_grace) as window_days,
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
          format('Add a billing method before %s to keep %s live. After that there are %s backup day%s, then the menu goes offline.',
                 to_char(r.due_at, 'DD Mon YYYY'), r.name, r.window_days, case when r.window_days = 1 then '' else 's' end),
          'yellow', v_key || ':restaurant', '/admin/subscription', v_action_restaurant
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'warning',
          format('%s: %s ends in %s day%s', r.name, v_kind, v_days, v_plural),
          format('%s has not paid yet. %s ends %s; %s backup day%s follow. Plan value %s.',
                 r.name, initcap(v_kind), to_char(r.due_at, 'DD Mon YYYY'), r.window_days,
                 case when r.window_days = 1 then '' else 's' end, public.s_amount(r.amount, r.currency)),
          'yellow', v_key || ':platform', '/admin/subscriptions', 'Open subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_warnings := v_warnings + 1;
    end;
  end loop;

  -- ── Due date passed, backup window still running ──────────────────────────
  for r in
    select
      s.restaurant_id, s.status, s.amount, s.currency, rest.name,
      coalesce(nullif(s.backup_days, 0), v_grace) as window_days,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at,
      public.subscription_on_trial(s.status, s.trial_end, s.current_period_end) as on_trial
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) <= now()
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          + make_interval(days => coalesce(nullif(s.backup_days, 0), v_grace)) > now()
  loop
    declare
      v_left integer := greatest(0, ceil(extract(epoch from ((r.due_at + make_interval(days => r.window_days)) - now())) / 86400.0)::integer);
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
               else format('%s backup day%s left before your menu goes offline', v_left, v_plural) end,
          case when v_left = 0
            then 'Your backup days end today. Add a billing method to keep your menu online.'
            else format('We are holding your menu online for %s more backup day%s. Add a billing method to avoid an interruption.', v_left, v_plural)
          end,
          'red', v_key || ':restaurant', '/admin/subscription', 'Renew now'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'critical',
          case when v_left = 0 then format('%s: backup days end today', r.name)
               else format('%s: backup days end in %s day%s', r.name, v_left, v_plural) end,
          format('%s is inside its backup window after its %s ended unpaid. It will be suspended automatically when the window runs out.', r.name, v_period),
          'red', v_key || ':platform', '/admin/subscriptions', 'Review subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_grace_warn := v_grace_warn + 1;
    end;
  end loop;

  -- ── Backup window spent: suspend ──────────────────────────────────────────
  for r in
    select
      s.id, s.restaurant_id, s.status, s.updated_at, rest.name,
      coalesce(nullif(s.backup_days, 0), v_grace) as window_days,
      public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at) as due_at
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'active', 'past_due')
      and public.subscription_due_at(s.status, s.trial_end, s.current_period_end, s.created_at)
          + make_interval(days => coalesce(nullif(s.backup_days, 0), v_grace)) <= now()
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
          format('The %s backup day%s after your billing date passed, so %s has been suspended. Renew to restore the menu for your guests.', r.window_days, case when r.window_days = 1 then '' else 's' end, r.name),
          'red', v_key || ':restaurant', '/admin/subscription', 'Renew subscription'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'critical',
          format('%s suspended automatically', r.name),
          format('%s did not pay within its %s backup day%s and has been suspended by the billing sweep. Its QR menus now return unavailable.', r.name, r.window_days, case when r.window_days = 1 then '' else 's' end),
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
          format('Safepay reported a failed charge of %s for %s. It stays inside its backup window until it pays or is suspended.', public.s_amount(r.amount, r.currency), r.name),
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

revoke all on function public.billing_sweep(boolean) from public, anon, authenticated;
grant execute on function public.billing_sweep(boolean) to postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The renewals calendar carries the backup window for the operator's table.
--    Body is 023's; `backup_days` is the addition.
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
      (s.safepay_payment_method_id is not null or s.provider_subscription_id is not null) as has_safepay,
      s.card_brand,
      s.card_last4,
      s.backup_days,
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

revoke all on function public.super_admin_upcoming_payments(integer) from public, anon;
grant execute on function public.super_admin_upcoming_payments(integer) to authenticated, postgres, service_role;
