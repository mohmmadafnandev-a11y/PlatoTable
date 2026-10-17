-- Historical bootstrap for the single-restaurant pilot.
--
-- This file is a record of how the first deployment was configured, kept because
-- it is the only description of the menu/QR payload shape. It is NOT the source
-- of truth and running it against a second database will not produce a working
-- platform: `supabase/migrations/001-016` is the schema, privileges, billing,
-- and storage that actually ship. The storage section below was written for one
-- restaurant and has been superseded by 016_menu_images_storage, which uses one
-- shared bucket keyed by restaurant id.

-- Product galleries preserve the current image_url cover and store every
-- uploaded or linked image in image_urls.
alter table public.menu_items add column if not exists image_urls text[] not null default '{}';
update public.menu_items set image_urls = array[image_url] where image_url is not null and cardinality(image_urls) = 0;

-- One dedicated public bucket for this restaurant's menu images.
-- Storage is owned by 016_menu_images_storage: one public `menu-images` bucket,
-- objects at <restaurant_id>/<file>, writes gated on
-- public.is_restaurant_admin(<folder>). Nothing here, because a second copy of a
-- permission rule is a second chance to get it wrong.

-- Permanent QR validation and public customer-menu fetch. The 15-minute
-- access timer is intentionally local browser sessionStorage, not a DB record.
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
  select * into qr
  from public.qr_tokens
  where token = scan_token;

  if not found then
    return jsonb_build_object('valid', false, 'error', 'Invalid QR code');
  end if;

  if not qr.is_active
     or (qr.expires_at is not null and qr.expires_at <= now()) then
    return jsonb_build_object('valid', false, 'error', 'QR code unavailable');
  end if;

  select * into restaurant
  from public.restaurants
  where id = qr.restaurant_id;

  return jsonb_build_object(
    'valid', true,
    'restaurant_name', restaurant.name,
    'table_number', qr.table_number,
    'currency', restaurant.currency,
    'contact_phone', restaurant.phone,
    'contact_email', restaurant.contact_email,
    'categories', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', category.id,
          'name', category.name,
          'icon', category.icon,
          'display_order', category.display_order
        ) order by category.display_order
      )
      from public.categories category
      where category.restaurant_id = qr.restaurant_id
        and category.is_active = true
    ), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', item.id,
          'category_id', item.category_id,
          'name', item.name,
          'description', item.description,
          'price', item.price,
          'image_url', item.image_url,
          'image_urls', item.image_urls
        ) order by item.display_order
      )
      from public.menu_items item
      where item.restaurant_id = qr.restaurant_id
        and item.is_available = true
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_scan_menu(text) from public;
grant execute on function public.get_scan_menu(text) to anon, authenticated;

-- Offers are isolated from the existing menu schema. Automatic bundles use
-- offer_items; manual offers can instead use their own image gallery.
create table if not exists public.offers (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  type text not null check (type in ('auto', 'manual')),
  title text not null,
  description text,
  price numeric(10,2) not null check (price >= 0),
  image_url text,
  image_urls text[] not null default '{}',
  start_at timestamptz,
  end_at timestamptz,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offers_valid_schedule check (end_at is null or start_at is null or end_at > start_at)
);

create table if not exists public.offer_items (
  offer_id uuid not null references public.offers(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  display_order integer not null default 0,
  primary key (offer_id, menu_item_id)
);

create index if not exists offers_restaurant_schedule_idx on public.offers (restaurant_id, is_active, start_at, end_at);
create index if not exists offer_items_offer_idx on public.offer_items (offer_id, display_order);

alter table public.offers enable row level security;
alter table public.offer_items enable row level security;
drop policy if exists "restaurant admins manage offers" on public.offers;
create policy "restaurant admins manage offers" on public.offers for all to authenticated
using (exists (select 1 from public.restaurant_admins admin where admin.user_id = auth.uid() and admin.is_active = true and admin.restaurant_id = offers.restaurant_id))
with check (exists (select 1 from public.restaurant_admins admin where admin.user_id = auth.uid() and admin.is_active = true and admin.restaurant_id = offers.restaurant_id));
drop policy if exists "restaurant admins manage offer items" on public.offer_items;
create policy "restaurant admins manage offer items" on public.offer_items for all to authenticated
using (exists (select 1 from public.offers offer join public.restaurant_admins admin on admin.restaurant_id = offer.restaurant_id where offer.id = offer_items.offer_id and admin.user_id = auth.uid() and admin.is_active = true))
with check (exists (select 1 from public.offers offer join public.restaurant_admins admin on admin.restaurant_id = offer.restaurant_id where offer.id = offer_items.offer_id and admin.user_id = auth.uid() and admin.is_active = true));

-- Include offers in the existing public QR payload so the customer can clearly
-- distinguish live, scheduled, ended, and switched-off offers.
create or replace function public.get_scan_menu(scan_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare qr public.qr_tokens%rowtype; restaurant public.restaurants%rowtype;
begin
  select * into qr from public.qr_tokens where token = scan_token;
  if not found then return jsonb_build_object('valid', false, 'error', 'Invalid QR code'); end if;
  if not qr.is_active or (qr.expires_at is not null and qr.expires_at <= now()) then return jsonb_build_object('valid', false, 'error', 'QR code unavailable'); end if;
  select * into restaurant from public.restaurants where id = qr.restaurant_id;
  -- Subscription enforcement is performed at the public access boundary. A
  -- legacy restaurant without a platform subscription remains compatible,
  -- while a configured expired, suspended, or canceled account is offline.
  if exists (select 1 from public.subscriptions where restaurant_id = qr.restaurant_id)
     and not exists (
       select 1 from public.subscriptions subscription
       where subscription.restaurant_id = qr.restaurant_id
         and (subscription.status = 'active'
           or (subscription.status = 'trialing' and subscription.trial_end > now()))
     ) then
    return jsonb_build_object('valid', false, 'error', 'Restaurant menu is temporarily unavailable', 'reason', 'subscription');
  end if;
  return jsonb_build_object(
    'valid', true, 'restaurant_name', restaurant.name, 'table_number', qr.table_number,
    'currency', restaurant.currency, 'contact_phone', restaurant.phone, 'contact_email', restaurant.contact_email,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', category.id, 'name', category.name, 'icon', category.icon, 'display_order', category.display_order) order by category.display_order) from public.categories category where category.restaurant_id = qr.restaurant_id and category.is_active = true), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', item.id, 'category_id', item.category_id, 'name', item.name, 'description', item.description, 'price', item.price, 'image_url', item.image_url, 'image_urls', item.image_urls) order by item.display_order) from public.menu_items item where item.restaurant_id = qr.restaurant_id and item.is_available = true), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object('id', offer.id, 'type', offer.type, 'title', offer.title, 'description', offer.description, 'price', offer.price, 'image_url', offer.image_url, 'image_urls', offer.image_urls, 'start_at', offer.start_at, 'end_at', offer.end_at, 'is_active', offer.is_active, 'items', coalesce((select jsonb_agg(jsonb_build_object('id', item.id, 'name', item.name, 'image_url', item.image_url, 'image_urls', item.image_urls) order by link.display_order) from public.offer_items link join public.menu_items item on item.id = link.menu_item_id where link.offer_id = offer.id), '[]'::jsonb)) order by offer.display_order, offer.created_at desc) from public.offers offer where offer.restaurant_id = qr.restaurant_id), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_scan_menu(text) from public;
grant execute on function public.get_scan_menu(text) to anon, authenticated;

-- Web Push subscriptions are device-specific and never contain VAPID material.
-- This section is additive and safe to rerun against the existing restaurant schema.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists push_subscriptions_restaurant_user_idx
  on public.push_subscriptions (restaurant_id, user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "restaurant admins read own push subscriptions" on public.push_subscriptions;
create policy "restaurant admins read own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1 from public.restaurant_admins admin
      where admin.user_id = auth.uid()
        and admin.restaurant_id = push_subscriptions.restaurant_id
        and admin.is_active = true
    )
  );

drop policy if exists "restaurant admins create own push subscriptions" on public.push_subscriptions;
create policy "restaurant admins create own push subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.restaurant_admins admin
      where admin.user_id = auth.uid()
        and admin.restaurant_id = push_subscriptions.restaurant_id
        and admin.is_active = true
    )
  );

drop policy if exists "restaurant admins update own push subscriptions" on public.push_subscriptions;
create policy "restaurant admins update own push subscriptions"
  on public.push_subscriptions for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.restaurant_admins admin
      where admin.user_id = auth.uid()
        and admin.restaurant_id = push_subscriptions.restaurant_id
        and admin.is_active = true
    )
  );

drop policy if exists "restaurant admins delete own push subscriptions" on public.push_subscriptions;
create policy "restaurant admins delete own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

-- Restaurant Admin billing and shared-platform access.
-- These changes are additive and intentionally do not create duplicate Super
-- Admin tables or grant restaurant owners write access to subscriptions/payments.
alter table public.restaurants add column if not exists billing_email text;
alter table public.restaurants add column if not exists tax_id text;
alter table public.restaurants add column if not exists billing_address text;

alter table public.subscriptions enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.system_notifications enable row level security;
alter table public.restaurant_urls enable row level security;

-- Restaurant administrators may read only records belonging to their active
-- restaurant. The policies complement (rather than replace) Super Admin RLS.
drop policy if exists restaurant_admin_subscription_read on public.subscriptions;
create policy restaurant_admin_subscription_read on public.subscriptions for select to authenticated
using (exists (select 1 from public.restaurant_admins admin where admin.user_id = auth.uid() and admin.restaurant_id = subscriptions.restaurant_id and admin.is_active));

drop policy if exists restaurant_admin_plan_read on public.subscription_plans;
create policy restaurant_admin_plan_read on public.subscription_plans for select to authenticated
using (exists (select 1 from public.subscriptions subscription join public.restaurant_admins admin on admin.restaurant_id = subscription.restaurant_id where subscription.plan_id = subscription_plans.id and admin.user_id = auth.uid() and admin.is_active));

drop policy if exists restaurant_admin_transaction_read on public.payment_transactions;
create policy restaurant_admin_transaction_read on public.payment_transactions for select to authenticated
using (exists (select 1 from public.restaurant_admins admin where admin.user_id = auth.uid() and admin.restaurant_id = payment_transactions.restaurant_id and admin.is_active));

drop policy if exists restaurant_admin_notification_read on public.system_notifications;
create policy restaurant_admin_notification_read on public.system_notifications for select to authenticated
using (
  system_notifications.restaurant_id is null
  or exists (
    select 1 from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.restaurant_id = system_notifications.restaurant_id
      and admin.is_active
  )
);

drop policy if exists restaurant_admin_url_read on public.restaurant_urls;
create policy restaurant_admin_url_read on public.restaurant_urls for select to authenticated
using (exists (select 1 from public.restaurant_admins admin where admin.user_id = auth.uid() and admin.restaurant_id = restaurant_urls.restaurant_id and admin.is_active));

-- RLS cannot restrict which columns an UPDATE changes. This RPC gives a
-- restaurant admin exactly one safe notification mutation: toggling is_read.
create or replace function public.mark_restaurant_notification_read(
  p_notification_id uuid,
  p_is_read boolean default true
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id
  from public.system_notifications
  where id = p_notification_id;

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
revoke all on function public.mark_restaurant_notification_read(uuid, boolean) from public;
grant execute on function public.mark_restaurant_notification_read(uuid, boolean) to authenticated;

-- Keep trial eligibility immutable across cancellations and future plan changes.
alter table public.subscriptions add column if not exists trial_used_at timestamptz;
update public.subscriptions
set trial_used_at = coalesce(trial_start, created_at)
where trial_used_at is null and (status = 'trialing' or provider = 'stripe');

notify pgrst, 'reload schema';
