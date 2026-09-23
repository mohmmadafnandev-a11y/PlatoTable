-- 006 — billing lifecycle: grace period, trial warnings, and notifications.
--
-- Additive only. Nothing is dropped or renamed; every new column is nullable or
-- defaulted, so applying this to the live database is a no-op for existing
-- readers.
--
-- Why this exists: until now nothing generated a billing notification. A
-- subscription could slide from `trialing` to expired and nobody — not the
-- restaurant, not the platform owner — was told. The pieces below make the
-- lifecycle explicit and observable:
--
--   1. a *grace period*, so a failed payment or an ended trial does not cut a
--      restaurant's menu off mid-service;
--   2. a *trial warning window*, so both sides hear before the trial ends;
--   3. one idempotent *sweep* that is the only writer of billing notifications,
--      so a cron retry can never duplicate one;
--   4. per-restaurant read state, so a broadcast marked read by one restaurant
--      no longer disappears for every other restaurant.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Price formatting, defined first because every message below uses it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.s_amount(p_amount numeric, p_currency text)
returns text
language sql
immutable
set search_path to ''
as $$
  select coalesce(nullif(p_currency, ''), '') || ' ' || to_char(coalesce(p_amount, 0), 'FM999,999,999,990.00')
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Platform settings: how long grace lasts, and how early trials warn.
-- ─────────────────────────────────────────────────────────────────────────────
-- `grace_period_days` already exists (currently 3). `trial_warning_days` does
-- not, and it is what decides when "your trial ends soon" starts being said.
alter table public.platform_settings
  add column if not exists trial_warning_days integer not null default 3;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_trial_warning_days_check') then
    alter table public.platform_settings
      add constraint platform_settings_trial_warning_days_check
      check (trial_warning_days between 0 and 30);
  end if;

  -- A negative grace would expire access *before* the period ended, which is
  -- never the intent and would be baffling to debug from the menu side.
  if not exists (select 1 from pg_constraint where conname = 'platform_settings_grace_period_days_check') then
    alter table public.platform_settings
      add constraint platform_settings_grace_period_days_check
      check (grace_period_days between 0 and 90);
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Notifications gain an audience, a de-duplication key, and a call to action.
-- ─────────────────────────────────────────────────────────────────────────────
-- `audience` is the important one. A platform alert ("khanR's payment failed")
-- refers to the same restaurant a restaurant alert does, so without this column
-- the restaurant would see the operator's own internal note. The default is
-- 'restaurant' because every notification written before today was one.
alter table public.system_notifications
  add column if not exists audience     text not null default 'restaurant',
  add column if not exists dedupe_key   text,
  add column if not exists action_url   text,
  add column if not exists action_label text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'system_notifications_audience_check') then
    alter table public.system_notifications
      add constraint system_notifications_audience_check
      check (audience in ('restaurant', 'platform'));
  end if;
end $$;

-- The sweep is a cron job, and cron jobs get retried, run twice by hand, and
-- overlap during a deploy. `dedupe_key` is what makes "trial ends in 2 days"
-- exactly one notification instead of four. Partial, so the operator-written
-- broadcasts (NULL key) never collide with each other.
create unique index if not exists system_notifications_dedupe_unique
  on public.system_notifications (dedupe_key)
  where dedupe_key is not null;

create index if not exists system_notifications_audience_created_idx
  on public.system_notifications (audience, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Per-restaurant read state.
-- ─────────────────────────────────────────────────────────────────────────────
-- A broadcast is one row shared by every restaurant, so its `is_read` column is
-- a single shared flag — the first restaurant to open the bell would mark it
-- read for all of them. Read state belongs per recipient, so it gets its own row
-- per (notification, restaurant).
create table if not exists public.notification_recipients (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.system_notifications(id) on delete cascade,
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  is_read         boolean not null default false,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (notification_id, restaurant_id)
);

create index if not exists notification_recipients_restaurant_idx
  on public.notification_recipients (restaurant_id, is_read);

alter table public.notification_recipients enable row level security;

-- A restaurant may see and update only its own read rows. No INSERT policy is
-- granted: rows are created by the RPC below on first read, because a client
-- able to insert them could forge its own delivery records.
drop policy if exists notification_recipients_own on public.notification_recipients;
create policy notification_recipients_own on public.notification_recipients
  for select to authenticated
  using (public.is_restaurant_admin(restaurant_id));

drop policy if exists notification_recipients_own_update on public.notification_recipients;
create policy notification_recipients_own_update on public.notification_recipients
  for update to authenticated
  using (public.is_restaurant_admin(restaurant_id))
  with check (public.is_restaurant_admin(restaurant_id));

drop policy if exists notification_recipients_platform on public.notification_recipients;
create policy notification_recipients_platform on public.notification_recipients
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

-- Restaurant reads must now exclude platform alerts. This policy is the only
-- thing standing between an operator's internal note and the restaurant it is
-- about, so it is replaced rather than supplemented.
drop policy if exists restaurant_admin_notification_read on public.system_notifications;
create policy restaurant_admin_notification_read on public.system_notifications
  for select to authenticated
  using (
    audience = 'restaurant'
    and (restaurant_id is null or public.is_restaurant_admin(restaurant_id))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The grace period, applied where access is actually decided.
-- ─────────────────────────────────────────────────────────────────────────────
-- Before this, a menu went dark the instant a trial ended or a payment failed.
-- Answering "do they keep access for a few days?" needs one change, in the
-- function that gates the menu, because that is the only place the question is
-- asked. The rest of the body is carried over unchanged.
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
  v_ok boolean := true;
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
    -- Grace belongs to the platform, not to one restaurant, so it is read once.
    select settings.grace_period_days into v_grace
    from public.platform_settings settings
    limit 1;
    v_grace := coalesce(v_grace, 0);

    v_ok := subscription.status = 'active'
      -- A trial that just ended keeps serving for the grace window, which is
      -- what stops a table mid-meal from losing the menu at midnight.
      or (subscription.status = 'trialing'
          and coalesce(subscription.trial_end, now()) + make_interval(days => v_grace) > now())
      -- A failed payment is recoverable without switching the restaurant off.
      or (subscription.status = 'past_due'
          and coalesce(subscription.current_period_end, now()) + make_interval(days => v_grace) > now());

    -- `suspended` and `canceled` are deliberate terminal states, and neither is
    -- an accident that grace should paper over.
    if not v_ok then
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
-- 6. The sweep — the single writer of every billing notification.
-- ─────────────────────────────────────────────────────────────────────────────
-- Callable by the cron endpoint (as service_role) and, for testing, by platform
-- staff. Idempotent: every insert carries a dedupe_key, so repeated runs on the
-- same day change nothing.
--
-- `p_dry_run` reports exactly what it would do without writing, which is how it
-- can be checked against the live data before it is ever allowed to suspend.
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
  v_trial integer := 0;
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

  -- ── Trial ending soon ──────────────────────────────────────────────────────
  -- One notification per day remaining, so the message stays true ("ends in 2
  -- days" → "ends tomorrow") instead of ageing into a lie. Deduped per day.
  for r in
    select s.restaurant_id, s.trial_end, s.amount, s.currency, rest.name
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status = 'trialing'
      and s.trial_end is not null
      and s.trial_end > now()
      and s.trial_end <= now() + make_interval(days => v_warning)
  loop
    declare
      v_days integer := greatest(1, ceil(extract(epoch from (r.trial_end - now())) / 86400.0)::integer);
      v_plural text := case when v_days = 1 then '' else 's' end;
      v_key text := 'trial-ending:' || r.restaurant_id || ':' || to_char(r.trial_end, 'YYYY-MM-DD');
    begin
      if not p_dry_run then
        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'warning',
          format('Your free trial ends in %s day%s', v_days, v_plural),
          format('Add a billing method before %s to keep %s live. After that there is a %s day grace period, then the menu goes offline.',
                 to_char(r.trial_end, 'DD Mon YYYY'), r.name, v_grace),
          'yellow', v_key || ':restaurant', '/admin/subscription', 'Add billing method'
        )
        on conflict (dedupe_key) do nothing;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'platform', 'warning',
          format('%s: trial ends in %s day%s', r.name, v_days, v_plural),
          format('%s has not added a billing method. Trial ends %s; plan value %s.',
                 r.name, to_char(r.trial_end, 'DD Mon YYYY'), public.s_amount(r.amount, r.currency)),
          'yellow', v_key || ':platform', '/admin/subscriptions', 'Open subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_trial := v_trial + 1;
    end;
  end loop;

  -- ── Grace period running out ───────────────────────────────────────────────
  -- Access now depends entirely on grace, so both sides are told how much of it
  -- is left. Only while grace is still standing: once it is gone the block
  -- below takes over.
  for r in
    select s.restaurant_id, s.status, s.amount, s.currency, rest.name,
           case when s.status = 'trialing' then s.trial_end else s.current_period_end end as ends_at
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'past_due')
      and case when s.status = 'trialing' then s.trial_end else s.current_period_end end is not null
      and case when s.status = 'trialing' then s.trial_end else s.current_period_end end <= now()
      and case when s.status = 'trialing' then s.trial_end else s.current_period_end end
          + make_interval(days => v_grace) > now()
  loop
    declare
      v_left integer := greatest(0, ceil(extract(epoch from ((r.ends_at + make_interval(days => v_grace)) - now())) / 86400.0)::integer);
      v_plural text := case when v_left = 1 then '' else 's' end;
      v_key text := 'grace-ending:' || r.restaurant_id || ':' || to_char(r.ends_at, 'YYYY-MM-DD');
      v_period text := case when r.status = 'trialing' then 'trial' else 'billing period' end;
    begin
      if not p_dry_run then
        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'critical',
          case when v_left = 0 then 'Your menu goes offline today' else format('%s day%s left before your menu goes offline', v_left, v_plural) end,
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
          case when v_left = 0
            then format('%s: grace period ends today', r.name)
            else format('%s: grace ends in %s day%s', r.name, v_left, v_plural)
          end,
          format('%s is in grace after its %s ended unpaid. It will be suspended automatically when grace runs out.', r.name, v_period),
          'red', v_key || ':platform', '/admin/subscriptions', 'Review subscription'
        )
        on conflict (dedupe_key) do nothing;
      end if;
      v_grace_warn := v_grace_warn + 1;
    end;
  end loop;

  -- ── Grace exhausted: suspend, and say so on both sides ─────────────────────
  -- Derived from the period end plus the platform's grace value rather than from
  -- a stored timestamp, so the two can never disagree.
  for r in
    select s.id, s.restaurant_id, s.status, s.updated_at, s.amount, s.currency, rest.name
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status in ('trialing', 'past_due')
      and coalesce(case when s.status = 'trialing' then s.trial_end else s.current_period_end end, s.created_at)
          + make_interval(days => v_grace) <= now()
  loop
    declare
      v_key text := 'suspended:' || r.restaurant_id || ':' || to_char(coalesce(r.updated_at, now()), 'YYYY-MM-DD');
    begin
      if not p_dry_run then
        update public.subscriptions set status = 'suspended', updated_at = now() where id = r.id;

        -- `is_active` is what the public lookup and the QR gate read, so a
        -- suspension that did not reach it would leave the menu serving.
        update public.restaurants set is_active = false, updated_at = now() where id = r.restaurant_id;

        insert into public.system_notifications
          (restaurant_id, audience, type, title, message, background_color, dedupe_key, action_url, action_label)
        values (
          r.restaurant_id, 'restaurant', 'critical',
          'Your menu is offline',
          format('The %s day grace period after your billing period ended has passed, so %s has been suspended. Renew to restore the menu for your guests.', v_grace, r.name),
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

  -- ── A recorded failure is news the moment it happens ───────────────────────
  for r in
    select s.restaurant_id, s.current_period_end, s.amount, s.currency, rest.name
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    where s.status = 'past_due'
      and s.last_payment_status = 'failed'
  loop
    declare
      v_key text := 'payment-failed:' || r.restaurant_id || ':' || coalesce(to_char(r.current_period_end, 'YYYY-MM-DD'), 'unknown');
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
    'trial_warnings', v_trial,
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
-- 7. Reads for the restaurant admin panel.
-- ─────────────────────────────────────────────────────────────────────────────
-- One call returns everything the bell and the billing banner need, with this
-- restaurant's own read state already joined on, so the client does not have to
-- know that broadcasts and direct messages have different shapes.
create or replace function public.restaurant_notifications(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
  v_unread integer;
begin
  if v_user is null then
    raise exception 'Sign in to read your notifications';
  end if;

  select coalesce(jsonb_agg(row_to_json(notification) order by notification.created_at desc), '[]'::jsonb)
    into v_rows
  from (
    select
      n.id, n.type, n.title, n.message, n.background_color,
      n.action_url, n.action_label, n.created_at, n.expires_at,
      coalesce(recipient.is_read, false) as is_read
    from public.system_notifications n
    join public.restaurant_admins admin
      on admin.user_id = v_user
     and admin.is_active
     and (n.restaurant_id is null or n.restaurant_id = admin.restaurant_id)
    left join public.notification_recipients recipient
      on recipient.notification_id = n.id
     and recipient.restaurant_id = admin.restaurant_id
    where n.audience = 'restaurant'
      and (n.scheduled_at is null or n.scheduled_at <= now())
      and (n.expires_at is null or n.expires_at > now())
    order by n.created_at desc
    limit v_limit
  ) notification;

  select count(*) into v_unread
  from jsonb_array_elements(v_rows) item
  where (item ->> 'is_read')::boolean is false;

  return jsonb_build_object('notifications', v_rows, 'unread', v_unread);
end;
$function$;

revoke all on function public.restaurant_notifications(integer) from public, anon;
grant execute on function public.restaurant_notifications(integer) to authenticated;

-- Marks one notification read for the caller's own restaurant only. Broadcasts
-- (restaurant_id null) get a recipient row on first read, which is the whole
-- reason that table exists.
create or replace function public.mark_notification_read(p_notification_id uuid, p_is_read boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user uuid := auth.uid();
  v_restaurant uuid;
  v_audience text;
begin
  if v_user is null then
    raise exception 'Sign in to update your notifications';
  end if;

  select n.audience into v_audience
  from public.system_notifications n
  where n.id = p_notification_id;
  -- A platform alert is not addressed to a restaurant, so it must look exactly
  -- like a missing row rather than confirming that it exists.
  if not found or v_audience <> 'restaurant' then
    raise exception 'Notification not found';
  end if;

  select admin.restaurant_id into v_restaurant
  from public.restaurant_admins admin
  join public.system_notifications n on n.id = p_notification_id
  where admin.user_id = v_user
    and admin.is_active
    and (n.restaurant_id is null or n.restaurant_id = admin.restaurant_id)
  limit 1;
  if v_restaurant is null then
    raise exception 'Notification not found';
  end if;

  insert into public.notification_recipients (notification_id, restaurant_id, is_read, read_at)
  values (p_notification_id, v_restaurant, coalesce(p_is_read, true), case when coalesce(p_is_read, true) then now() else null end)
  on conflict (notification_id, restaurant_id)
  do update set is_read = excluded.is_read,
                read_at = case when excluded.is_read then now() else null end;

  return jsonb_build_object('ok', true, 'is_read', coalesce(p_is_read, true));
end;
$function$;

revoke all on function public.mark_notification_read(uuid, boolean) from public, anon;
grant execute on function public.mark_notification_read(uuid, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Keep the legacy read marker honest.
-- ─────────────────────────────────────────────────────────────────────────────
-- The old RPC wrote the shared `is_read` flag, so one restaurant opening a
-- broadcast cleared it for all of them. It now delegates to the per-recipient
-- version, which fixes old callers without changing them.
create or replace function public.mark_restaurant_notification_read(p_notification_id uuid, p_is_read boolean default true)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  perform public.mark_notification_read(p_notification_id, p_is_read);
end;
$function$;

revoke all on function public.mark_restaurant_notification_read(uuid, boolean) from public, anon;
grant execute on function public.mark_restaurant_notification_read(uuid, boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. The renewals calendar for the Super Admin.
-- ─────────────────────────────────────────────────────────────────────────────
-- "Upcoming payments" answers who is about to be charged, what for, and when —
-- the question an operator actually opens the billing screens with. Suspended
-- and cancelled rows are excluded because they have no upcoming charge.
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
      case when s.status = 'trialing' then s.trial_end else s.current_period_end end as due_at,
      case when s.status = 'trialing' then 'trial_ends' else 'renews' end as kind,
      greatest(0, ceil(extract(epoch from ((case when s.status = 'trialing' then s.trial_end else s.current_period_end end) - now())) / 86400.0)::integer) as days_until
    from public.subscriptions s
    join public.restaurants rest on rest.id = s.restaurant_id
    left join public.subscription_plans plan on plan.id = s.plan_id
    where s.status in ('trialing', 'active', 'past_due')
      and case when s.status = 'trialing' then s.trial_end else s.current_period_end end is not null
      and case when s.status = 'trialing' then s.trial_end else s.current_period_end end
          between now() - interval '1 day' and now() + make_interval(days => v_days)
  ) entry;

  -- Summed per currency: adding PKR to USD would produce a number that means
  -- nothing, and the platform sells in five currencies at once.
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
