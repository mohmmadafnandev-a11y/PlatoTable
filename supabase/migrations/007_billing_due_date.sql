-- 007 — one derived due date for every billing decision.
--
-- Found by running 006 against the live data: two of the three demo rows, and
-- the restaurant in the Super Admin's own screenshot, are `status = 'active'`
-- with `current_period_end IS NULL` and a `trial_end` set. 006 read the due date
-- as "trial_end only while trialing", so those rows matched no branch at all —
-- no trial warning, no grace, no suspension, and nothing in the renewals
-- calendar. A restaurant in that state would never be billed and never be told.
--
-- The fix is to stop asking "what status is this?" and ask "when does access run
-- out?", once, in a function both the menu gate and the sweep share. Reading the
-- due date through one helper is what makes it impossible for the gate to
-- disagree with the notice that warned about it.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The due date, in one place.
-- ─────────────────────────────────────────────────────────────────────────────
-- A trialing subscription is due at its trial end; everything else at its period
-- end. Each falls back to the other, which is the part that rescues rows whose
-- period was never recorded, and finally to creation so the value is never NULL
-- for a row that has been through onboarding.
create or replace function public.subscription_due_at(
  p_status text,
  p_trial_end timestamptz,
  p_period_end timestamptz,
  p_created_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path to ''
as $$
  select coalesce(
    case when p_status = 'trialing' then p_trial_end else p_period_end end,
    p_period_end,
    p_trial_end,
    p_created_at
  )
$$;

-- True while the subscription has not yet entered a paid period, which is what
-- the interface calls a trial — even when the row's status says `active`.
-- `stable`, not `immutable`: it reads now(), and an immutable function that does
-- that can have a stale answer cached and reused by the planner.
create or replace function public.subscription_on_trial(
  p_status text,
  p_trial_end timestamptz,
  p_period_end timestamptz
)
returns boolean
language sql
stable
set search_path to ''
as $$
  select p_status = 'trialing'
    or (p_period_end is null and p_trial_end is not null and p_trial_end > now())
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The menu gate now measures against the same due date.
-- ─────────────────────────────────────────────────────────────────────────────
-- Only the gate block changes; the menu payload is carried over verbatim.
create or replace function public.get_scan_menu(scan_token text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  qr public.qr_tokens%rowtype;
  restaurant public.restaurants%rowtype;
  subscription public.subscriptions%rowtype;
  v_grace integer;
  v_due timestamptz;
begin
  select * into qr from public.qr_tokens where token = scan_token;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid', 'error', 'Invalid QR code');
  end if;

  if not qr.is_active or (qr.expires_at is not null and qr.expires_at <= now()) then
    return jsonb_build_object('valid', false, 'reason', 'inactive', 'error', 'QR code unavailable');
  end if;

  select * into restaurant from public.restaurants where id = qr.restaurant_id;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'invalid', 'error', 'Invalid QR code');
  end if;

  select * into subscription from public.subscriptions where restaurant_id = qr.restaurant_id;
  if found then
    select settings.grace_period_days into v_grace
    from public.platform_settings settings
    limit 1;
    v_grace := coalesce(v_grace, 0);

    v_due := public.subscription_due_at(
      subscription.status,
      subscription.trial_end,
      subscription.current_period_end,
      subscription.created_at
    );

    -- One rule instead of three: access survives for the grace window after the
    -- due date. `suspended` and `canceled` are deliberate terminal states and
    -- are never rescued by grace.
    if subscription.status in ('suspended', 'canceled') then
      return jsonb_build_object('valid', false, 'reason', 'subscription', 'error', 'Restaurant menu is temporarily unavailable');
    end if;

    if subscription.status in ('trialing', 'active', 'past_due')
       and v_due is not null
       and v_due + make_interval(days => v_grace) <= now() then
      return jsonb_build_object('valid', false, 'reason', 'subscription', 'error', 'Restaurant menu is temporarily unavailable');
    end if;
  end if;

  return jsonb_build_object(
    'valid', true,
    'restaurant_name', restaurant.name,
    'subdomain', restaurant.subdomain,
    'table_number', qr.table_number,
    'currency', restaurant.currency,
    'contact_phone', restaurant.phone,
    'contact_email', restaurant.contact_email,
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', category.id, 'name', category.name, 'icon', category.icon, 'display_order', category.display_order) order by category.display_order)
      from public.categories category
      where category.restaurant_id = qr.restaurant_id and category.is_active = true
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', item.id, 'category_id', item.category_id, 'name', item.name, 'description', item.description, 'price', item.price, 'image_url', item.image_url, 'image_urls', item.image_urls) order by item.display_order)
      from public.menu_items item
      where item.restaurant_id = qr.restaurant_id and item.is_available = true
    ), '[]'::jsonb),
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', offer.id, 'type', offer.type, 'title', offer.title, 'description', offer.description,
        'price', offer.price, 'image_url', offer.image_url, 'image_urls', offer.image_urls,
        'start_at', offer.start_at, 'end_at', offer.end_at, 'is_active', offer.is_active,
        'items', coalesce((
          select jsonb_agg(jsonb_build_object('id', item.id, 'name', item.name, 'image_url', item.image_url, 'image_urls', item.image_urls) order by link.display_order)
          from public.offer_items link
          join public.menu_items item on item.id = link.menu_item_id
          where link.offer_id = offer.id
        ), '[]'::jsonb)
      ) order by offer.display_order, offer.created_at desc)
      from public.offers offer
      where offer.restaurant_id = qr.restaurant_id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_scan_menu(text) from public;
grant execute on function public.get_scan_menu(text) to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The sweep, rebuilt on the same due date.
-- ─────────────────────────────────────────────────────────────────────────────
-- Every branch is now keyed on `v_due`, so the three states are exhaustive:
--     due in the future  → trial/renewal warning
--     due passed, grace left → grace warning
--     grace spent        → suspend
-- There is no fourth case, which is what closes the hole 006 left open.
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
          format('Stripe reported a failed charge of %s for %s. It stays in grace until it pays or is suspended.', public.s_amount(r.amount, r.currency), r.name),
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

revoke all on function public.billing_sweep(boolean) from public, anon;
grant execute on function public.billing_sweep(boolean) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The renewals calendar, on the same due date.
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
      s.provider_subscription_id is not null as has_stripe,
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
grant execute on function public.super_admin_upcoming_payments(integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The restaurant's own billing view, so the countdown cannot disagree with
--    the gate above or with the notice that was sent.
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
  r record;
begin
  if v_user is null then
    raise exception 'Sign in to read your billing';
  end if;

  -- Defaults to the caller's own restaurant. An explicit id is honoured only if
  -- the caller really administers it, so the argument cannot be used to read
  -- someone else's billing.
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
    s.provider_customer_id, s.last_payment_status, s.plan_id,
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
    -- The date the menu actually stops being served. This is the number the
    -- countdown on the billing screen shows, and it is the same expression the
    -- menu gate applies, so the two cannot disagree.
    'access_ends_at', r.due_at + make_interval(days => v_grace),
    'days_remaining', case when r.due_at is null then null
      else ceil(extract(epoch from (r.due_at - now())) / 86400.0)::integer end,
    'grace_days_remaining', case when r.due_at is null then null
      else greatest(0, ceil(extract(epoch from ((r.due_at + make_interval(days => v_grace)) - now())) / 86400.0)::integer) end
  );
end;
$function$;

revoke all on function public.restaurant_billing(uuid) from public, anon;
grant execute on function public.restaurant_billing(uuid) to authenticated;
