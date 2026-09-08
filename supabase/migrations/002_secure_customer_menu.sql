-- Apply after 001_initial_schema.sql. Removes demo-era public table reads and
-- serves customer menu data only through a validated QR token.

drop policy if exists "public views active categories" on public.categories;
drop policy if exists "public views available menu" on public.menu_items;

drop function if exists public.validate_qr(text, text, text);
create function public.validate_qr(scan_token text, scan_user_agent text default null, scan_device_type text default null)
returns table (
  valid boolean, reason text, restaurant_id uuid, table_number text,
  session_expires_at timestamptz, restaurant_name text, currency text
)
language plpgsql security definer set search_path = '' as $$
declare qr public.qr_tokens%rowtype; duration integer; session_expiry timestamptz; restaurant public.restaurants%rowtype;
begin
  select * into qr from public.qr_tokens where token = scan_token;
  if not found then return query select false, 'invalid'::text, null::uuid, null::text, null::timestamptz, null::text, null::text; return; end if;
  if not qr.is_active then return query select false, 'inactive'::text, qr.restaurant_id, null::text, null::timestamptz, null::text, null::text; return; end if;
  if qr.expires_at is not null and qr.expires_at <= now() then return query select false, 'expired'::text, qr.restaurant_id, null::text, null::timestamptz, null::text, null::text; return; end if;
  select * into restaurant from public.restaurants where id = qr.restaurant_id;
  select coalesce(qr_expiry_minutes, 15) into duration from public.settings where restaurant_id = qr.restaurant_id;
  session_expiry := now() + make_interval(mins => coalesce(duration, 15));
  insert into public.scan_logs (restaurant_id, table_number, token, user_agent, device_type, expires_at) values (qr.restaurant_id, qr.table_number, qr.token, scan_user_agent, scan_device_type, session_expiry);
  return query select true, 'active'::text, qr.restaurant_id, qr.table_number, session_expiry, restaurant.name, restaurant.currency;
end;
$$;
revoke all on function public.validate_qr(text, text, text) from public;
grant execute on function public.validate_qr(text, text, text) to anon, authenticated;

create or replace function public.get_scan_menu(scan_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare qr public.qr_tokens%rowtype;
begin
  select * into qr from public.qr_tokens where token = scan_token and is_active and (expires_at is null or expires_at > now());
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object(
    'valid', true,
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'icon', c.icon, 'display_order', c.display_order) order by c.display_order) from public.categories c where c.restaurant_id = qr.restaurant_id and c.is_active), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'category_id', m.category_id, 'name', m.name, 'description', m.description, 'price', m.price, 'image_url', m.image_url, 'is_offer', m.is_offer, 'offer_price', m.offer_price, 'offer_start_date', m.offer_start_date, 'offer_end_date', m.offer_end_date) order by m.display_order) from public.menu_items m where m.restaurant_id = qr.restaurant_id and m.is_available), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.get_scan_menu(text) from public;
grant execute on function public.get_scan_menu(text) to anon, authenticated;
