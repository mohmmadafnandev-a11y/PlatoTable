-- ============================================================================
-- Plato Table — 001_reconcile_live_baseline.sql
--
-- Purpose
--   Reconcile the live database with the repository. Corrective and additive
--   only: no table is dropped, no column is removed, no row is deleted.
--   Every statement is idempotent and safe to re-run.
--   Run as a single transaction (the migration tooling does this).
--
-- Verified drift this migration resolves
--   1. restaurant_admins has no password_hash column, but onboard_restaurant()
--      inserts into it, so "Add restaurant" fails at runtime with a 500.
--   2. restaurants.currency allows PKR/USD/EUR while onboarding accepts AED,
--      so UAE restaurants cannot be created at all.
--   3. The deployed get_scan_menu() has no subscription gate even though the
--      repository version does, so a suspended restaurant keeps serving its
--      public menu.
--   4. The deployed mark_restaurant_notification_read() raises for broadcast
--      rows, and the SELECT policy hides those rows, so broadcast
--      notifications never reach a restaurant and cannot be marked read.
--   5. restaurants has no super-admin policy, and menu_items / categories /
--      qr_tokens / restaurant_admins / settings have no platform-staff read
--      policy, so the Super Admin panel cannot read tenant content.
--   6. is_restaurant_admin(uuid) and set_updated_at() exist only in the live
--      database, so the repository cannot recreate production.
--   7. Nine SECURITY DEFINER functions were executable by the anon role.
--
-- Deliberately NOT changed
--   * restaurant_admins.password_hash is NOT added. Supabase Auth owns
--     credentials, no application code reads the column, and the onboarding
--     RPC is corrected instead. Nothing is hashed or stored by this app.
--   * restaurant_admins_restaurant_id_user_id_key is KEPT (the onboarding
--     membership upsert depends on it).
--   * Payment/subscription/wallet currency checks already allow USD/AED/PKR,
--     so they need no change; only restaurants.currency was too narrow.
--   * bootstrap_daynight_owner() is DROPPED. The DayNight pilot restaurant and
--     its synthetic Auth account were deleted from production, so the hardcoded
--     single-tenant bridge has no remaining purpose. The drop is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Live-only helper objects recorded in version control
--    Exact copies of the deployed definitions.
-- ---------------------------------------------------------------------------

create or replace function public.is_restaurant_admin(target_restaurant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.restaurant_admins
    where restaurant_id = target_restaurant
      and user_id = auth.uid()
      and is_active
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Currency: allow AED so UAE restaurants can be onboarded
--    (live constraint: currency = ANY (PKR, USD, EUR))
-- ---------------------------------------------------------------------------

alter table public.restaurants drop constraint if exists restaurants_currency_check;
alter table public.restaurants
  add constraint restaurants_currency_check check (currency in ('PKR', 'USD', 'AED'));

-- ---------------------------------------------------------------------------
-- 3. One person may own more than one restaurant
--    username is not read by any application code and is not a foreign key.
-- ---------------------------------------------------------------------------

alter table public.restaurant_admins drop constraint if exists restaurant_admins_username_key;

-- ---------------------------------------------------------------------------
-- 4. onboard_restaurant(): stop writing the non-existent password_hash
--    Signature is unchanged, so the deployed API keeps working.
-- ---------------------------------------------------------------------------

create or replace function public.onboard_restaurant(
  p_name text,
  p_subdomain text,
  p_owner_email text,
  p_owner_user_id uuid,
  p_phone text default null,
  p_currency text default 'PKR',
  p_plan_id uuid default null,
  p_trial_days integer default 7,
  p_admin_url text default null,
  p_user_url text default null,
  p_custom_domain text default null,
  p_super_admin_id uuid default null
)
returns table (restaurant_id uuid, subscription_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_subscription_id uuid;
  v_plan public.subscription_plans%rowtype;
  v_amount numeric(12,2) := 0;
  v_trial_start timestamptz := now();
  v_trial_end timestamptz;
begin
  if p_super_admin_id is null or not exists (
    select 1 from public.super_admins
    where id = p_super_admin_id and role = 'super_admin' and is_active
  ) then
    raise exception 'Only active super admins may onboard restaurants';
  end if;

  if p_name is null or btrim(p_name) = ''
     or p_subdomain is null or p_subdomain !~ '^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$'
     or p_owner_email is null or btrim(p_owner_email) = ''
     or p_owner_user_id is null
     or p_currency not in ('USD', 'AED', 'PKR')
     or p_trial_days < 0 or p_trial_days > 365 then
    raise exception 'Invalid restaurant onboarding data';
  end if;

  if exists (select 1 from public.restaurants where subdomain = p_subdomain) then
    raise exception 'The subdomain % is already in use', p_subdomain;
  end if;

  if p_plan_id is not null then
    select * into v_plan from public.subscription_plans where id = p_plan_id and is_active;
    if not found then raise exception 'The selected subscription plan is not active'; end if;
    v_amount := case p_currency
      when 'USD' then v_plan.price_usd
      when 'AED' then v_plan.price_aed
      else v_plan.price_pkr
    end;
  end if;

  v_trial_end := v_trial_start + make_interval(days => p_trial_days);

  insert into public.restaurants (name, subdomain, owner_email, phone, currency)
  values (btrim(p_name), p_subdomain, lower(btrim(p_owner_email)), nullif(btrim(p_phone), ''), p_currency)
  returning id into v_restaurant_id;

  -- Supabase Auth is the credential authority for this restaurant. The owner's
  -- email is recorded for identification only; no password material is stored
  -- in application tables.
  insert into public.restaurant_admins (restaurant_id, user_id, username, role, is_active)
  values (v_restaurant_id, p_owner_user_id, lower(btrim(p_owner_email)), 'owner', true);

  insert into public.subscriptions (
    restaurant_id, plan_id, provider, status, currency, amount, trial_start, trial_end
  ) values (
    v_restaurant_id, p_plan_id, 'manual', 'trialing', p_currency, v_amount, v_trial_start, v_trial_end
  ) returning id into v_subscription_id;

  -- Every restaurant needs a settings row for session length and display.
  insert into public.settings (restaurant_id)
  values (v_restaurant_id)
  on conflict (restaurant_id) do nothing;

  if nullif(btrim(p_admin_url), '') is not null
     or nullif(btrim(p_user_url), '') is not null
     or nullif(btrim(p_custom_domain), '') is not null then
    insert into public.restaurant_urls (restaurant_id, admin_url, user_url, custom_domain)
    values (
      v_restaurant_id,
      nullif(btrim(p_admin_url), ''),
      nullif(btrim(p_user_url), ''),
      nullif(btrim(p_custom_domain), '')
    );
  end if;

  insert into public.activity_logs (super_admin_id, restaurant_id, action, details)
  values (
    p_super_admin_id,
    v_restaurant_id,
    'restaurant.onboarded',
    jsonb_build_object('owner_email', lower(btrim(p_owner_email)), 'plan_id', p_plan_id, 'trial_days', p_trial_days)
  );

  return query select v_restaurant_id, v_subscription_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. get_scan_menu(): enforce the subscription state at the public boundary
--    Adds 'reason' so the customer app can show the correct screen, and
--    'subdomain' so a client can confirm the host matches the scanned table.
--    A restaurant with no subscription row stays online, so this gate can only
--    take a menu offline when a subscription record actually exists.
-- ---------------------------------------------------------------------------

create or replace function public.get_scan_menu(scan_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  qr public.qr_tokens%rowtype;
  restaurant public.restaurants%rowtype;
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

  if exists (select 1 from public.subscriptions subscription where subscription.restaurant_id = qr.restaurant_id)
     and not exists (
       select 1 from public.subscriptions subscription
       where subscription.restaurant_id = qr.restaurant_id
         and (subscription.status = 'active'
           or (subscription.status = 'trialing' and subscription.trial_end > now()))
     ) then
    return jsonb_build_object('valid', false, 'reason', 'subscription', 'error', 'Restaurant menu is temporarily unavailable');
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
$$;

-- ---------------------------------------------------------------------------
-- 6. Notifications: broadcasts must reach restaurants and be markable
-- ---------------------------------------------------------------------------

drop policy if exists restaurant_admin_notification_read on public.system_notifications;
create policy restaurant_admin_notification_read on public.system_notifications
  for select to authenticated
  using (
    system_notifications.restaurant_id is null
    or exists (
      select 1 from public.restaurant_admins admin
      where admin.user_id = auth.uid()
        and admin.restaurant_id = system_notifications.restaurant_id
        and admin.is_active
    )
  );

create or replace function public.mark_restaurant_notification_read(
  p_notification_id uuid,
  p_is_read boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
begin
  select notification.restaurant_id into v_restaurant_id
  from public.system_notifications notification
  where notification.id = p_notification_id;

  if not found then
    raise exception 'Notification not found';
  end if;

  if not exists (
    select 1 from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.is_active
      and (v_restaurant_id is null or admin.restaurant_id = v_restaurant_id)
  ) then
    raise exception 'Notification not found';
  end if;

  update public.system_notifications
  set is_read = coalesce(p_is_read, true)
  where id = p_notification_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Platform access: super admins manage restaurants, staff may read tenant
--    content (adds only SELECT for platform staff; tenant writes are unchanged)
-- ---------------------------------------------------------------------------

drop policy if exists restaurants_super_admin_manage on public.restaurants;
create policy restaurants_super_admin_manage on public.restaurants
  for all to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

drop policy if exists memberships_platform_read on public.restaurant_admins;
create policy memberships_platform_read on public.restaurant_admins
  for select to authenticated using (public.is_platform_staff());

drop policy if exists menu_platform_read on public.menu_items;
create policy menu_platform_read on public.menu_items
  for select to authenticated using (public.is_platform_staff());

drop policy if exists categories_platform_read on public.categories;
create policy categories_platform_read on public.categories
  for select to authenticated using (public.is_platform_staff());

drop policy if exists qr_tokens_platform_read on public.qr_tokens;
create policy qr_tokens_platform_read on public.qr_tokens
  for select to authenticated using (public.is_platform_staff());

drop policy if exists settings_platform_read on public.settings;
create policy settings_platform_read on public.settings
  for select to authenticated using (public.is_platform_staff());

-- ---------------------------------------------------------------------------
-- 8. Grant hygiene: anon may call the public scan entry point only
--    authenticated keeps EXECUTE on the helper functions because the RLS and
--    storage policies call them; revoking those would break every tenant read
--    and every menu-image upload. Trigger functions need no EXECUTE grant.
-- ---------------------------------------------------------------------------

-- public (keep)
revoke all on function public.get_scan_menu(text) from public, anon;
grant execute on function public.get_scan_menu(text) to anon, authenticated, service_role;

-- internal helpers (anon has no use for these; each already fails closed)
revoke all on function public.super_admin_role() from public, anon;
grant execute on function public.super_admin_role() to authenticated, service_role;

revoke all on function public.is_super_admin() from public, anon;
grant execute on function public.is_super_admin() to authenticated, service_role;

revoke all on function public.is_platform_staff() from public, anon;
grant execute on function public.is_platform_staff() to authenticated, service_role;

revoke all on function public.is_restaurant_admin(uuid) from public, anon;
grant execute on function public.is_restaurant_admin(uuid) to authenticated, service_role;

revoke all on function public.super_admin_restaurants() from public, anon;
grant execute on function public.super_admin_restaurants() to authenticated, service_role;

revoke all on function public.mark_restaurant_notification_read(uuid, boolean) from public, anon;
grant execute on function public.mark_restaurant_notification_read(uuid, boolean) to authenticated, service_role;

-- server-only (the onboarding API calls this with the service role key)
revoke all on function public.onboard_restaurant(text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.onboard_restaurant(text, text, text, uuid, text, text, uuid, integer, text, text, text, uuid) to service_role;

-- trigger function: invoked by triggers, not by callers
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Retire the single-tenant bootstrap
--    bootstrap_daynight_owner() was hardcoded to the former pilot (its name,
--    subdomain and a synthetic .local email). The pilot data and its Auth
--    account are deleted, so the function has no remaining purpose.
--    Already applied to production; kept here so the migration stays complete.
-- ---------------------------------------------------------------------------

drop function if exists public.bootstrap_daynight_owner();

notify pgrst, 'reload schema';
