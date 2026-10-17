-- 013 — a dollar figure reads as a dollar figure.
--
-- `s_amount` is what every billing notification quotes money with: the trial
-- warning, the grace warning, the suspension notice, and the failed-payment
-- notice all build their sentence from it. It printed "USD 25.00", which is
-- correct and reads like a database column. With one currency on the platform,
-- the symbol is unambiguous, so it prints "$25.00".
--
-- The other branch is kept: a row recorded in another currency before the
-- platform moved to dollars still renders as it was written, rather than being
-- relabelled as dollars it never was.

create or replace function public.s_amount(p_amount numeric, p_currency text)
returns text
language sql
immutable
set search_path to ''
as $$
  select case
    when upper(coalesce(nullif(p_currency, ''), 'USD')) = 'USD'
      then '$' || to_char(coalesce(p_amount, 0), 'FM999,999,999,990.00')
    else coalesce(nullif(p_currency, ''), '') || ' ' || to_char(coalesce(p_amount, 0), 'FM999,999,999,990.00')
  end
$$;
