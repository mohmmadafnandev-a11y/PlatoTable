-- ============================================================================
-- Plato Table — 003_super_admin_read_model.sql
--
-- Purpose
--   Give the Super Admin screens real data to render, without a client-side
--   N+1 across restaurants, subscriptions, QR tokens, and menu items. Additive
--   and idempotent: no table, column, or row is dropped or renamed.
--
-- Contents
--   1. super_admin_restaurants()  — extended with per-restaurant counts
--   2. super_admin_dashboard()    — platform aggregates for one round trip
--   3. public_platform_contact()  — anon-readable platform identity + contact
--   4. platform_settings seed + updated_at trigger + grants
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Restaurant directory.
--    Re-declared on the same zero-argument signature, so this replaces the
--    previous definition rather than creating an overload. Returns jsonb
--    rather than a table type: jsonb_build_object keys cannot collide with
--    column names the way RETURNS TABLE output parameters can.
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_restaurants()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', restaurant.id,
    'name', restaurant.name,
    'owner_email', restaurant.owner_email,
    'phone', restaurant.phone,
    'contact_email', restaurant.contact_email,
    'subdomain', restaurant.subdomain,
    'country', restaurant.country,
    'currency', restaurant.currency,
    'logo_url', restaurant.logo_url,
    'address', restaurant.address,
    'notes', restaurant.notes,
    'is_active', restaurant.is_active,
    'onboarding_completed', restaurant.onboarding_completed,
    'created_at', restaurant.created_at,
    'qr_count', (select count(*) from public.qr_tokens token where token.restaurant_id = restaurant.id),
    'menu_item_count', (select count(*) from public.menu_items item where item.restaurant_id = restaurant.id),
    'category_count', (select count(*) from public.categories category where category.restaurant_id = restaurant.id),
    'paid_total', (
      select coalesce(sum(transaction.amount), 0)
      from public.payment_transactions transaction
      where transaction.restaurant_id = restaurant.id
        and transaction.status = 'succeeded'
    ),
    'subscription', case when subscription.id is null then null else jsonb_build_object(
      'id', subscription.id,
      'status', subscription.status,
      'amount', subscription.amount,
      'currency', subscription.currency,
      'plan_id', subscription.plan_id,
      'plan_name', (select plan.name from public.subscription_plans plan where plan.id = subscription.plan_id),
      'trial_start', subscription.trial_start,
      'trial_end', subscription.trial_end,
      'current_period_start', subscription.current_period_start,
      'current_period_end', subscription.current_period_end,
      'cancel_at_period_end', subscription.cancel_at_period_end,
      'last_payment_status', subscription.last_payment_status
    ) end,
    'urls', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', url.id,
        'admin_url', url.admin_url,
        'user_url', url.user_url,
        'custom_domain', url.custom_domain,
        'is_primary', url.is_primary
      ))
      from public.restaurant_urls url
      where url.restaurant_id = restaurant.id
    ), '[]'::jsonb)
  ) order by restaurant.created_at desc), '[]'::jsonb)
  from public.restaurants restaurant
  left join public.subscriptions subscription on subscription.restaurant_id = restaurant.id
  where public.is_platform_staff();
$function$;

-- ---------------------------------------------------------------------------
-- 2. Dashboard aggregates.
--    One call rather than six, so the overview cannot render half-loaded and
--    the money figures are computed from the same snapshot.
-- ---------------------------------------------------------------------------

create or replace function public.super_admin_dashboard()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case when not public.is_platform_staff() then null else jsonb_build_object(
    'restaurant_total', (select count(*) from public.restaurants),
    'restaurant_active', (select count(*) from public.restaurants where is_active),
    'restaurant_inactive', (select count(*) from public.restaurants where not is_active),
    'subscriptions', jsonb_build_object(
      'trialing',  (select count(*) from public.subscriptions where status = 'trialing'),
      'active',    (select count(*) from public.subscriptions where status = 'active'),
      'past_due',  (select count(*) from public.subscriptions where status = 'past_due'),
      'suspended', (select count(*) from public.subscriptions where status = 'suspended'),
      'canceled',  (select count(*) from public.subscriptions where status = 'canceled')
    ),
    'revenue', jsonb_build_object(
      'total', (select coalesce(sum(amount), 0) from public.payment_transactions where status = 'succeeded'),
      'this_month', (
        select coalesce(sum(amount), 0) from public.payment_transactions
        where status = 'succeeded' and created_at >= date_trunc('month', now())
      ),
      'last_month', (
        select coalesce(sum(amount), 0) from public.payment_transactions
        where status = 'succeeded'
          and created_at >= date_trunc('month', now()) - interval '1 month'
          and created_at < date_trunc('month', now())
      ),
      'currency', (
        select transaction.currency from public.payment_transactions transaction
        where transaction.status = 'succeeded'
        order by transaction.created_at desc
        limit 1
      )
    ),
    'monthly_revenue', (
      select coalesce(jsonb_agg(jsonb_build_object('label', to_char(month.bucket, 'YYYY-MM'), 'value', month.value) order by month.bucket), '[]'::jsonb)
      from (
        select date_trunc('month', bucket) as bucket,
               (
                 select coalesce(sum(transaction.amount), 0)
                 from public.payment_transactions transaction
                 where transaction.status = 'succeeded'
                   and date_trunc('month', transaction.created_at) = date_trunc('month', bucket)
               ) as value
        from generate_series(
          date_trunc('month', now()) - interval '11 months',
          date_trunc('month', now()),
          interval '1 month'
        ) as bucket
      ) month
    ),
    'daily_signups', (
      select coalesce(jsonb_agg(jsonb_build_object('label', to_char(signup.day, 'YYYY-MM-DD'), 'value', signup.created) order by signup.day), '[]'::jsonb)
      from (
        select day::date as day,
               (select count(*) from public.restaurants restaurant where restaurant.created_at::date = day::date) as created
        from generate_series(now()::date - interval '29 days', now()::date, interval '1 day') as day
      ) signup
    ),
    'trials_ending_soon', (
      select count(*) from public.subscriptions
      where status = 'trialing'
        and trial_end is not null
        and trial_end between now() and now() + interval '3 days'
    ),
    'recent_activity', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', recent.id,
        'action', recent.action,
        'details', recent.details,
        'created_at', recent.created_at,
        'actor', (select admin.name from public.super_admins admin where admin.id = recent.super_admin_id),
        'restaurant', (select restaurant.name from public.restaurants restaurant where restaurant.id = recent.restaurant_id)
      ) order by recent.created_at desc), '[]'::jsonb)
      from (select * from public.activity_logs order by created_at desc limit 8) recent
    )
  ) end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Public platform identity.
--    The marketing page and the tenant card both need the platform name and
--    support details, and neither has a session. Exposes only what is already
--    printed on the page, never a key or a customer record.
-- ---------------------------------------------------------------------------

create or replace function public.public_platform_contact()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'platform_name', coalesce(settings.platform_name, 'Plato Table'),
    'support_email', settings.support_email,
    'support_phone', settings.support_phone,
    'maintenance_mode', settings.maintenance_mode,
    'maintenance_message', settings.maintenance_message
  )
  from public.platform_settings settings
  where settings.id
  limit 1;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Platform settings: seed the published contact details, keep updated_at
--    honest, and make sure the table stays writable by the Super Admin.
-- ---------------------------------------------------------------------------

update public.platform_settings
set support_email = coalesce(support_email, 'mohmmadafnan.dev@gmail.com'),
    support_phone = coalesce(support_phone, '+92 300 5443434'),
    updated_at = now()
where id;

drop trigger if exists platform_settings_touch_updated_at on public.platform_settings;
create trigger platform_settings_touch_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

grant select, update on public.platform_settings to authenticated;

-- anon reaches exactly three functions: the QR menu, tenant branding, and now
-- the platform contact card. Everything else stays behind is_platform_staff().
revoke all on function public.public_platform_contact() from public;
grant execute on function public.public_platform_contact() to anon, authenticated;

revoke all on function public.super_admin_dashboard() from public, anon;
grant execute on function public.super_admin_dashboard() to authenticated, service_role;

revoke all on function public.super_admin_restaurants() from public, anon;
grant execute on function public.super_admin_restaurants() to authenticated, service_role;

notify pgrst, 'reload schema';
