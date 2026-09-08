-- PalatoTabale: initial multi-tenant restaurant menu schema
create extension if not exists pgcrypto;

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subdomain text not null unique,
  owner_email text not null,
  logo_url text,
  phone text,
  address text,
  currency text not null default 'PKR' check (currency in ('PKR', 'USD', 'EUR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.restaurant_admins (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null unique,
  role text not null default 'admin' check (role in ('owner', 'admin', 'editor')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null,
  icon text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(10,2) not null check (price >= 0),
  image_url text,
  is_available boolean not null default true,
  is_offer boolean not null default false,
  offer_price numeric(10,2) check (offer_price >= 0),
  offer_description text,
  offer_start_date timestamptz,
  offer_end_date timestamptz,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_offer or offer_price is not null),
  check (offer_price is null or offer_price <= price),
  check (offer_end_date is null or offer_start_date is null or offer_end_date > offer_start_date)
);

create table public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_number text not null,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (restaurant_id, table_number)
);

create table public.scan_logs (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  table_number text not null,
  token text not null,
  user_agent text,
  device_type text,
  scanned_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table public.settings (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  qr_expiry_minutes integer not null default 15 check (qr_expiry_minutes between 5 and 240),
  menu_display_style text not null default 'grid' check (menu_display_style in ('grid', 'list')),
  language text not null default 'en',
  theme_color text not null default '#A13524',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index categories_restaurant_idx on public.categories (restaurant_id, display_order);
create index menu_items_restaurant_idx on public.menu_items (restaurant_id, category_id, display_order);
create index menu_items_offer_idx on public.menu_items (restaurant_id, is_offer) where is_offer;
create index qr_tokens_token_idx on public.qr_tokens (token);
create index scan_logs_restaurant_time_idx on public.scan_logs (restaurant_id, scanned_at desc);
create index scan_logs_expiry_idx on public.scan_logs (expires_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger restaurants_updated_at before update on public.restaurants for each row execute function public.set_updated_at();
create trigger categories_updated_at before update on public.categories for each row execute function public.set_updated_at();
create trigger menu_items_updated_at before update on public.menu_items for each row execute function public.set_updated_at();
create trigger settings_updated_at before update on public.settings for each row execute function public.set_updated_at();

create or replace function public.is_restaurant_admin(target_restaurant uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_admins
    where restaurant_id = target_restaurant
      and user_id = auth.uid()
      and is_active
  );
$$;

revoke all on function public.is_restaurant_admin(uuid) from public;
grant execute on function public.is_restaurant_admin(uuid) to authenticated;

alter table public.restaurants enable row level security;
alter table public.restaurant_admins enable row level security;
alter table public.categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.qr_tokens enable row level security;
alter table public.scan_logs enable row level security;
alter table public.settings enable row level security;

create policy "admins view restaurant" on public.restaurants for select to authenticated using (public.is_restaurant_admin(id));
create policy "admins update restaurant" on public.restaurants for update to authenticated using (public.is_restaurant_admin(id)) with check (public.is_restaurant_admin(id));
create policy "admins view memberships" on public.restaurant_admins for select to authenticated using (user_id = auth.uid() or public.is_restaurant_admin(restaurant_id));
create policy "owners manage memberships" on public.restaurant_admins for all to authenticated using (public.is_restaurant_admin(restaurant_id)) with check (public.is_restaurant_admin(restaurant_id));

create policy "public views active categories" on public.categories for select to anon, authenticated using (is_active);
create policy "admins manage categories" on public.categories for all to authenticated using (public.is_restaurant_admin(restaurant_id)) with check (public.is_restaurant_admin(restaurant_id));
create policy "public views available menu" on public.menu_items for select to anon, authenticated using (is_available);
create policy "admins manage menu" on public.menu_items for all to authenticated using (public.is_restaurant_admin(restaurant_id)) with check (public.is_restaurant_admin(restaurant_id));
create policy "admins manage qr tokens" on public.qr_tokens for all to authenticated using (public.is_restaurant_admin(restaurant_id)) with check (public.is_restaurant_admin(restaurant_id));
create policy "admins view scans" on public.scan_logs for select to authenticated using (public.is_restaurant_admin(restaurant_id));
create policy "admins delete scans" on public.scan_logs for delete to authenticated using (public.is_restaurant_admin(restaurant_id));
create policy "admins manage settings" on public.settings for all to authenticated using (public.is_restaurant_admin(restaurant_id)) with check (public.is_restaurant_admin(restaurant_id));

-- Validate and log a QR scan without exposing the qr_tokens table publicly.
create or replace function public.validate_qr(scan_token text, scan_user_agent text default null, scan_device_type text default null)
returns table (valid boolean, reason text, restaurant_id uuid, table_number text, session_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  qr public.qr_tokens%rowtype;
  expiry_minutes integer;
  session_expiry timestamptz;
begin
  select * into qr from public.qr_tokens where token = scan_token;
  if not found then
    return query select false, 'invalid'::text, null::uuid, null::text, null::timestamptz;
    return;
  end if;
  if not qr.is_active then
    return query select false, 'inactive'::text, qr.restaurant_id, qr.table_number, null::timestamptz;
    return;
  end if;
  if qr.expires_at is not null and qr.expires_at <= now() then
    return query select false, 'expired'::text, qr.restaurant_id, qr.table_number, null::timestamptz;
    return;
  end if;
  select coalesce(s.qr_expiry_minutes, 15) into expiry_minutes from public.settings s where s.restaurant_id = qr.restaurant_id;
  expiry_minutes := coalesce(expiry_minutes, 15);
  session_expiry := now() + make_interval(mins => expiry_minutes);
  insert into public.scan_logs (restaurant_id, table_number, token, user_agent, device_type, expires_at)
  values (qr.restaurant_id, qr.table_number, qr.token, scan_user_agent, scan_device_type, session_expiry);
  return query select true, 'active'::text, qr.restaurant_id, qr.table_number, session_expiry;
end;
$$;

revoke all on function public.validate_qr(text, text, text) from public;
grant execute on function public.validate_qr(text, text, text) to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy "public reads menu images" on storage.objects for select to anon, authenticated using (bucket_id = 'menu-images');
create policy "admins upload menu images" on storage.objects for insert to authenticated with check (
  bucket_id = 'menu-images' and public.is_restaurant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "admins update menu images" on storage.objects for update to authenticated using (
  bucket_id = 'menu-images' and public.is_restaurant_admin(((storage.foldername(name))[1])::uuid)
);
create policy "admins delete menu images" on storage.objects for delete to authenticated using (
  bucket_id = 'menu-images' and public.is_restaurant_admin(((storage.foldername(name))[1])::uuid)
);
