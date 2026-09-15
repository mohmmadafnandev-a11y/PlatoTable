-- Safe DayNight Landikotal Bazar configuration.
-- Run this on the existing restaurant database. It does not create or delete
-- application tables, so it will not overwrite menu items, QR codes, or data.

-- Product galleries preserve the current image_url cover and store every
-- uploaded or linked image in image_urls.
alter table public.menu_items add column if not exists image_urls text[] not null default '{}';
update public.menu_items set image_urls = array[image_url] where image_url is not null and cardinality(image_urls) = 0;

-- One dedicated public bucket for this restaurant's menu images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'daynight-landikotal-bazar1',
  'daynight-landikotal-bazar1',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Images use <restaurant-id>/<file-name>, so each authenticated restaurant
-- admin can manage only their own folder in this restaurant's bucket.
drop policy if exists "daynight image read" on storage.objects;
drop policy if exists "daynight image upload" on storage.objects;
drop policy if exists "daynight image update" on storage.objects;
drop policy if exists "daynight image delete" on storage.objects;

create policy "daynight image read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'daynight-landikotal-bazar1');

create policy "daynight image upload"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'daynight-landikotal-bazar1'
  and exists (
    select 1
    from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.is_active = true
      and admin.restaurant_id = ((storage.foldername(name))[1])::uuid
  )
);

create policy "daynight image update"
on storage.objects for update
to authenticated
using (
  bucket_id = 'daynight-landikotal-bazar1'
  and exists (
    select 1
    from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.is_active = true
      and admin.restaurant_id = ((storage.foldername(name))[1])::uuid
  )
)
with check (
  bucket_id = 'daynight-landikotal-bazar1'
  and exists (
    select 1
    from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.is_active = true
      and admin.restaurant_id = ((storage.foldername(name))[1])::uuid
  )
);

create policy "daynight image delete"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'daynight-landikotal-bazar1'
  and exists (
    select 1
    from public.restaurant_admins admin
    where admin.user_id = auth.uid()
      and admin.is_active = true
      and admin.restaurant_id = ((storage.foldername(name))[1])::uuid
  )
);

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

notify pgrst, 'reload schema';
