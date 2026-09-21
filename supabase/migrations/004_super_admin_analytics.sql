-- ============================================================================
-- Plato Table — 004_super_admin_analytics.sql
--
-- Purpose
--   One function that answers the recurring-revenue questions the Analytics
--   screen asks: MRR, ARR, churn, ARPU, LTV, trial conversion, plan mix, and
--   revenue by country. Computed in SQL so a number shown on screen cannot
--   disagree with the same number shown elsewhere.
--
-- Deliberately absent
--   Scan and peak-hours metrics. Those need scan_logs, which does not exist
--   yet: the server-side session work (qr_sessions + scan_logs) has not been
--   built, so there is nothing honest to report for usage hours.
--
-- Additive and idempotent. No table, column, or row is dropped.
-- ============================================================================

create or replace function public.super_admin_analytics()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with paying as (
    select subscription.amount, subscription.currency, subscription.plan_id
    from public.subscriptions subscription
    where subscription.status = 'active'
  ),
  churn_window as (
    select count(*) as canceled
    from public.subscriptions
    where canceled_at is not null and canceled_at >= now() - interval '30 days'
  ),
  converted as (
    select
      count(*) filter (where trial_used_at is not null) as trials_started,
      count(*) filter (where trial_used_at is not null and status = 'active') as trials_converted
    from public.subscriptions
  )
  select case when not public.is_platform_staff() then null else jsonb_build_object(
    'mrr',            (select coalesce(sum(amount), 0) from paying),
    'paying_count',   (select count(*) from paying),
    'currency',       (select currency from paying group by currency order by count(*) desc limit 1),
    'arr',            (select coalesce(sum(amount), 0) * 12 from paying),
    'arpu',           (
      select case when count(*) = 0 then 0 else coalesce(sum(amount), 0) / count(*) end from paying
    ),
    'canceled_30d',   (select canceled from churn_window),
    'churn_rate_30d', (
      select case
        when (select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window) = 0 then 0
        else round(
          (select canceled from churn_window)::numeric
          / ((select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window))::numeric
          * 100, 2)
      end
    ),
    -- Lifetime value as ARPU divided by the monthly churn rate, expressed as a
    -- fraction. With no churn recorded yet the divisor is zero, and an
    -- undefined LTV is reported as null rather than as an infinite number.
    'ltv', (
      select case
        when (select case
                when (select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window) = 0 then 0
                else (select canceled from churn_window)::numeric
                     / ((select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window))::numeric
              end) = 0 then null
        else round(
          (select case when count(*) = 0 then 0 else coalesce(sum(amount), 0) / count(*) end from paying)
          / (select case
               when (select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window) = 0 then 0
               else (select canceled from churn_window)::numeric
                    / ((select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window))::numeric
             end), 2)
      end
    ),
    'trials_started',   (select trials_started from converted),
    'trials_converted', (select trials_converted from converted),
    'trial_conversion_rate', (
      select case when trials_started = 0 then 0
        else round(trials_converted::numeric / trials_started::numeric * 100, 1) end
      from converted
    ),
    'monthly_signups', (
      select coalesce(jsonb_agg(jsonb_build_object('label', to_char(month.bucket, 'YYYY-MM'), 'value', month.created) order by month.bucket), '[]'::jsonb)
      from (
        select date_trunc('month', bucket) as bucket,
               (select count(*) from public.restaurants restaurant
                 where date_trunc('month', restaurant.created_at) = date_trunc('month', bucket)) as created
        from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as bucket
      ) month
    ),
    'monthly_cancellations', (
      select coalesce(jsonb_agg(jsonb_build_object('label', to_char(month.bucket, 'YYYY-MM'), 'value', month.lost) order by month.bucket), '[]'::jsonb)
      from (
        select date_trunc('month', bucket) as bucket,
               (select count(*) from public.subscriptions subscription
                 where subscription.canceled_at is not null
                   and date_trunc('month', subscription.canceled_at) = date_trunc('month', bucket)) as lost
        from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') as bucket
      ) month
    ),
    'plan_mix', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'name', plan.name,
        'count', plan.subscribers,
        'mrr', plan.mrr
      ) order by plan.subscribers desc, plan.name), '[]'::jsonb)
      from (
        select
          coalesce((select p.name from public.subscription_plans p where p.id = subscription.plan_id), 'Custom plan') as name,
          count(*) as subscribers,
          coalesce(sum(subscription.amount), 0) as mrr
        from public.subscriptions subscription
        group by 1
      ) plan
    ),
    'revenue_by_country', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'country', bucket.country,
        'restaurants', bucket.restaurants,
        'collected', bucket.collected
      ) order by bucket.collected desc), '[]'::jsonb)
      from (
        select
          coalesce(restaurant.country, 'Unspecified') as country,
          count(distinct restaurant.id) as restaurants,
          coalesce(sum(transaction.amount), 0) as collected
        from public.restaurants restaurant
        left join public.payment_transactions transaction
          on transaction.restaurant_id = restaurant.id and transaction.status = 'succeeded'
        group by 1
      ) bucket
    )
  ) end;
$function$;

revoke all on function public.super_admin_analytics() from public, anon;
grant execute on function public.super_admin_analytics() to authenticated, service_role;

notify pgrst, 'reload schema';
