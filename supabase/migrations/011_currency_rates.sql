-- 011 — a total is only a total in one currency.
--
-- The dashboard added every successful payment together and labelled the sum
-- with the currency of whichever transaction happened to be newest. With the
-- live data — one £15 GBP payment and one ₨2,000 PKR payment — it reported
-- "2,015", a figure that is neither £2,015 nor ₨2,015: too small by ~370x if
-- GBP was intended, too large by ~7x if PKR was. Every revenue surface had the
-- same defect (dashboard totals, the 12-month chart, MRR/ARR/ARPU/LTV, the plan
-- mix, and revenue by country), and the payments screen summed its filtered rows
-- in the browser the same way.
--
-- Money is now converted before it is added, never after. Rates live in one
-- cached table so the SQL aggregates, every operator's browser, and the API all
-- divide the same way, and the display currency is chosen by the operator
-- (p_currency) rather than guessed from the last row inserted.
--
-- Nothing here trusts a missing rate. convert_money() returns null when a pair
-- is unknown, `sum()` skips those rows, and every revenue object carries an
-- `unconverted` list of the currencies it had to leave out — so a screen can say
-- what is missing instead of quietly under-reporting a total.

-- One row per base currency: {code: rate per one unit of base}. The API returns
-- its whole table relative to a single base, so a whole table is one row here.
create table if not exists public.currency_rates (
  base text primary key,
  rates jsonb not null,
  fetched_at timestamptz not null default now(),
  source text
);

comment on table public.currency_rates is
  'Exchange rates, one row per base currency. Written by platform staff through refresh_currency_rates(); read by the conversion helpers below. Never written by a restaurant.';

alter table public.currency_rates enable row level security;

-- Rates are market data rather than tenant data, but the write path must not be
-- open at all: a restaurant that could edit rates could move the platform's
-- reported revenue. Reads are staff-only because only the platform panel
-- converts money; the helpers below are SECURITY DEFINER and do not need it.
drop policy if exists "staff read currency rates" on public.currency_rates;
create policy "staff read currency rates" on public.currency_rates
  for select to authenticated using (public.is_platform_staff());

-- Cross-rate from whichever stored map contains both codes. USD is what gets
-- stored, but the lookup does not assume it: any row holding both codes works,
-- so the platform is not pinned to one base if that ever changes.
create or replace function public.currency_rate(p_from text, p_to text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select case
    when q.src = q.dst then 1::numeric
    when q.rates is null then null
    when jsonb_exists(q.rates, q.src) and jsonb_exists(q.rates, q.dst)
      then (q.rates ->> q.dst)::numeric / nullif((q.rates ->> q.src)::numeric, 0)
    else null
  end
  from (
    select upper(coalesce(nullif(trim(p_from), ''), 'USD')) as src,
           upper(coalesce(nullif(trim(p_to), ''), 'USD')) as dst,
           (
             select r.rates
             from public.currency_rates r
             order by (upper(r.base) = 'USD') desc, r.fetched_at desc
             limit 1
           ) as rates
  ) q;
$$;

-- Null in, null out; unknown pair, null out. Null is the honest answer, and the
-- aggregates below are written to skip it rather than assume 1:1.
create or replace function public.convert_money(p_amount numeric, p_from text, p_to text)
returns numeric
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when p_amount is null then null else p_amount * public.currency_rate(p_from, p_to) end;
$$;

-- What the operator panel needs to know: the rates it would be converting with,
-- and how old they are. The age is sent as a number so the picker can decide
-- whether to refresh without parsing a timestamp.
create or replace function public.currency_rates_state()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when not public.is_platform_staff() then null else (
    select jsonb_build_object(
      'base', r.base,
      'rates', r.rates,
      'fetched_at', r.fetched_at,
      'source', r.source,
      'age_hours', round(extract(epoch from (now() - r.fetched_at)) / 3600, 1)
    )
    from public.currency_rates r
    order by (upper(r.base) = 'USD') desc, r.fetched_at desc
    limit 1
  ) end;
$$;

-- The only write path for rates.
create or replace function public.refresh_currency_rates(
  p_rates jsonb,
  p_base text default 'USD',
  p_source text default 'exchangerate-api'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_base text := upper(coalesce(nullif(trim(p_base), ''), 'USD'));
  v_count integer;
begin
  if not public.is_platform_staff() then
    raise exception 'Only platform staff can refresh currency rates' using errcode = '42501';
  end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'object' then
    raise exception 'Exchange rates must be a JSON object of currency codes to numbers';
  end if;

  -- A payload with nothing usable in it would replace good rates with none, and
  -- the whole panel would then report every total as fully unconvertible.
  select count(*)
  into v_count
  from jsonb_each_text(p_rates) as entry(code, value)
  where entry.code ~ '^[A-Za-z]{3}$'
    and entry.value ~ '^[0-9]+(\.[0-9]+)?$'
    and entry.value::numeric > 0;

  if v_count < 2 then
    raise exception 'Exchange rates are missing usable currency codes';
  end if;

  insert into public.currency_rates (base, rates, fetched_at, source)
  values (v_base, p_rates, now(), p_source)
  on conflict (base) do update
    set rates = excluded.rates,
        fetched_at = excluded.fetched_at,
        source = excluded.source;

  return jsonb_build_object('base', v_base, 'currencies', v_count, 'fetched_at', now());
end;
$$;

-- The zero-argument originals have to go, not merely be replaced: Postgres keeps
-- them as a second overload, and PostgREST then refuses to choose between
-- super_admin_dashboard() and super_admin_dashboard(text) — every call from the
-- panel would fail with "could not choose the best candidate function".
drop function if exists public.super_admin_dashboard();
drop function if exists public.super_admin_analytics();

-- Revenue, converted once into the caller's display currency. The `paid` CTE
-- does the conversion a single time so the totals, the monthly chart, and the
-- per-currency breakdown cannot drift apart.
create or replace function public.super_admin_dashboard(p_currency text default 'USD')
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with display as (
    select upper(coalesce(nullif(trim(p_currency), ''), 'USD')) as code
  ),
  paid as (
    select transaction.amount,
           upper(coalesce(transaction.currency, 'USD')) as currency,
           transaction.created_at,
           public.convert_money(transaction.amount, transaction.currency, (select code from display)) as converted
    from public.payment_transactions transaction
    where transaction.status = 'succeeded'
  )
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
      'currency', (select code from display),
      'total',      (select coalesce(sum(converted), 0) from paid),
      'this_month', (
        select coalesce(sum(converted), 0) from paid
        where created_at >= date_trunc('month', now())
      ),
      'last_month', (
        select coalesce(sum(converted), 0) from paid
        where created_at >= date_trunc('month', now()) - interval '1 month'
          and created_at < date_trunc('month', now())
      ),
      -- What was actually collected, per currency, untranslated. A single
      -- converted figure hides which market it came from, and the platform is
      -- paid in several.
      'by_currency', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'currency', bucket.currency,
          'total', bucket.total,
          'transactions', bucket.transactions
        ) order by bucket.total desc), '[]'::jsonb)
        from (
          select currency, sum(amount) as total, count(*) as transactions
          from paid
          group by currency
        ) bucket
      ),
      -- Currencies that could not be converted because no rate is stored for
      -- them. Excluded from every figure above, and named here so the screen can
      -- say so rather than looking complete.
      'unconverted', (
        select coalesce(jsonb_agg(distinct currency), '[]'::jsonb)
        from paid
        where converted is null
      ),
      'rates_as_of', (select max(fetched_at) from public.currency_rates)
    ),
    'monthly_revenue', (
      select coalesce(jsonb_agg(jsonb_build_object('label', to_char(month.bucket, 'YYYY-MM'), 'value', month.value) order by month.bucket), '[]'::jsonb)
      from (
        select date_trunc('month', bucket) as bucket,
               (
                 select coalesce(sum(paid.converted), 0)
                 from paid
                 where date_trunc('month', paid.created_at) = date_trunc('month', bucket)
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
$$;

-- The same conversion for the analytics screen: MRR, ARR, ARPU, lifetime value,
-- the plan mix, and revenue by country were all summing across currencies too.
create or replace function public.super_admin_analytics(p_currency text default 'USD')
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with display as (
    select upper(coalesce(nullif(trim(p_currency), ''), 'USD')) as code
  ),
  paying as (
    select subscription.amount,
           upper(coalesce(subscription.currency, 'USD')) as currency,
           subscription.plan_id,
           public.convert_money(subscription.amount, subscription.currency, (select code from display)) as converted
    from public.subscriptions subscription
    where subscription.status = 'active'
  ),
  churn_window as (
    select count(*) as canceled
    from public.subscriptions
    where canceled_at is not null and canceled_at >= now() - interval '30 days'
  ),
  -- Named as a fraction, not a percentage. `ltv` below divides by this, and the
  -- old expression divided by the percentage form (50 instead of 0.5), which
  -- understated lifetime value by a factor of 100.
  churn as (
    select case
      when (select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window) = 0 then 0::numeric
      else (select canceled from churn_window)::numeric
           / ((select count(*) from public.subscriptions where status = 'active') + (select canceled from churn_window))::numeric
    end as fraction
  ),
  trials as (
    select
      count(*) filter (where trial_used_at is not null) as started,
      count(*) filter (where trial_used_at is not null and status = 'active') as converted
    from public.subscriptions
  )
  select case when not public.is_platform_staff() then null else jsonb_build_object(
    'mrr',            (select coalesce(sum(converted), 0) from paying),
    'paying_count',   (select count(*) from paying),
    'currency',       (select code from display),
    'arr',            (select coalesce(sum(converted), 0) * 12 from paying),
    'arpu',           (
      select case when count(*) = 0 then 0 else coalesce(sum(converted), 0) / count(*) end from paying
    ),
    'unconverted',    (select coalesce(jsonb_agg(distinct currency), '[]'::jsonb) from paying where converted is null),
    'canceled_30d',   (select canceled from churn_window),
    'churn_rate_30d', (select round(fraction * 100, 2) from churn),
    'ltv', (
      select case when fraction = 0 then null
        else round(
          (select case when count(*) = 0 then 0 else coalesce(sum(converted), 0) / count(*) end from paying)
          / fraction, 2)
      end
      from churn
    ),
    'trials_started',   (select started from trials),
    'trials_converted', (select converted from trials),
    'trial_conversion_rate', (
      select case when started = 0 then 0
        else round(converted::numeric / started::numeric * 100, 1) end
      from trials
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
          coalesce(sum(public.convert_money(subscription.amount, subscription.currency, (select code from display))), 0) as mrr
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
          coalesce(sum(public.convert_money(transaction.amount, transaction.currency, (select code from display))), 0) as collected
        from public.restaurants restaurant
        left join public.payment_transactions transaction
          on transaction.restaurant_id = restaurant.id and transaction.status = 'succeeded'
        group by 1
      ) bucket
    )
  ) end;
$$;

revoke all on function public.currency_rate(text, text) from public;
revoke all on function public.convert_money(numeric, text, text) from public;
revoke all on function public.currency_rates_state() from public;
revoke all on function public.refresh_currency_rates(jsonb, text, text) from public;
revoke all on function public.super_admin_dashboard(text) from public;
revoke all on function public.super_admin_analytics(text) from public;

-- No anon grant anywhere in this file: these are platform figures and the rate
-- table, and neither is a customer's business.
grant execute on function public.currency_rate(text, text) to authenticated, service_role;
grant execute on function public.convert_money(numeric, text, text) to authenticated, service_role;
grant execute on function public.currency_rates_state() to authenticated, service_role;
grant execute on function public.refresh_currency_rates(jsonb, text, text) to authenticated, service_role;
grant execute on function public.super_admin_dashboard(text) to authenticated, service_role;
grant execute on function public.super_admin_analytics(text) to authenticated, service_role;

-- Seed one real table of rates so the panel is correct on its first load rather
-- than reporting everything as unconvertible until a browser refreshes. Fetched
-- from exchangerate-api (base USD, 2026-09-26) and the same six currencies the
-- platform bills in; the panel replaces it with the full table on first use.
insert into public.currency_rates (base, rates, fetched_at, source)
values (
  'USD',
  '{"USD":1,"AED":3.6725,"PKR":276.944,"GBP":0.7553,"SAR":3.75,"EUR":0.8773}'::jsonb,
  now(),
  'bootstrap (exchangerate-api, 2026-09-26)'
)
on conflict (base) do nothing;
