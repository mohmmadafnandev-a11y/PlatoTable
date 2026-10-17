-- The sign-in screen for a suspended restaurant.
--
-- public_tenant_by_slug() only answers for an active restaurant, which is right for
-- the public page: a suspended restaurant has no menu to show a guest. But the
-- restaurant's own sign-in screen used the same function, so suspending a restaurant
-- removed the one page its owner needed — the screen said "Restaurant not found" and
-- the owner could not sign in to add a card and renew. Which is the exact journey the
-- payment wall tells them to take.
--
-- The only job there is to print the restaurant's name above the form, so it gets a
-- lookup that answers for any restaurant that exists and returns nothing but the name.
create or replace function public.public_tenant_login(p_slug text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select restaurant.name
  from public.restaurants restaurant
  where restaurant.subdomain = lower(btrim(coalesce(p_slug, '')))
  limit 1;
$$;

revoke all on function public.public_tenant_login(text) from public;
grant execute on function public.public_tenant_login(text) to anon, authenticated;
