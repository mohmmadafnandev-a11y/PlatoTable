-- Two ways to remove a restaurant, both driven from the Super Admin panel:
--
--   * erase  — every row that belongs to the tenant goes, through the existing
--              cascade, and the owner account goes with it.
--   * detach — the tenant row goes but the money ledger stays, because a
--              payment Stripe recorded is a fact about the platform, not about
--              the restaurant. That needs payment_transactions to survive with
--              no restaurant left to point at.
--
-- Also closes two read paths that ignored restaurants.is_active, so a switched
-- off restaurant kept serving its QR menu and kept resolving its admin title.

-- ── 1. The ledger outlives the tenant it was written for ────────────────────
alter table public.payment_transactions
  drop constraint if exists payment_transactions_restaurant_id_fkey;

alter table public.payment_transactions
  alter column restaurant_id drop not null;

alter table public.payment_transactions
  add constraint payment_transactions_restaurant_id_fkey
  foreign key (restaurant_id) references public.restaurants(id) on delete set null;

-- A kept row must still say who paid. Once the restaurant is gone there is
-- nothing left to join to, so the name is copied onto the row as it is written
-- rather than being reconstructed afterwards.
alter table public.payment_transactions
  add column if not exists restaurant_name text;

create or replace function public.payment_transaction_name_snapshot()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.restaurant_name is null and new.restaurant_id is not null then
    select restaurant.name into new.restaurant_name
    from public.restaurants restaurant
    where restaurant.id = new.restaurant_id;
  end if;
  return new;
end;
$function$;

drop trigger if exists payment_transactions_name_snapshot on public.payment_transactions;
create trigger payment_transactions_name_snapshot
  before insert or update of restaurant_id on public.payment_transactions
  for each row execute function public.payment_transaction_name_snapshot();

update public.payment_transactions transaction
set restaurant_name = restaurant.name
from public.restaurants restaurant
where restaurant.id = transaction.restaurant_id
  and transaction.restaurant_name is null;

-- ── 2. A switched-off restaurant serves nothing ────────────────────────────
-- The restaurant's own QR codes were checked, but not whether the restaurant
-- itself was active, so a suspended tenant still handed out its full menu. The
-- error copy the app already has for 'subscription' fits: the menu is
-- temporarily unavailable, ask a member of staff.
create or replace function public.get_scan_menu(scan_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  if not restaurant.is_active then
    return jsonb_build_object('valid', false, 'reason', 'subscription', 'error', 'Restaurant menu is temporarily unavailable');
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

-- ── 3. A switched-off restaurant does not resolve its own name ─────────────
-- public_tenant_by_slug already refuses a suspended tenant; the login lookup
-- did not, so a switched-off subdomain still showed the restaurant's name in the
-- admin sign-in form.
create or replace function public.public_tenant_login(p_slug text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select restaurant.name
  from public.restaurants restaurant
  where restaurant.subdomain = lower(btrim(coalesce(p_slug, '')))
    and restaurant.is_active
  limit 1;
$function$;
