-- Initial empty restaurant setup for this DayNight Landikotal Bazar build.
-- First create and auto-confirm this user in Supabase Dashboard > Authentication > Users:
-- Email: admin@daynight-landikotal-bazar1.local
-- Password: use a secure password of at least 6 characters.
--
-- This creates only the restaurant, settings, and owner membership.
-- It does not create menu items, categories, offers, QR codes, or scan logs.

do $$
declare
  owner_id uuid;
  initial_restaurant_id uuid;
begin
  select id into owner_id
  from auth.users
  where email = 'admin@daynight-landikotal-bazar1.local';

  if owner_id is null then
    raise exception 'Create and auto-confirm admin@daynight-landikotal-bazar1.local in Supabase Auth first.';
  end if;

  insert into public.restaurants (name, subdomain, owner_email, currency)
  values ('DayNight Landikotal Bazar', 'daynight-landikotal-bazar1', 'admin@daynight-landikotal-bazar1.local', 'PKR')
  on conflict (subdomain) do update
    set name = excluded.name,
        owner_email = excluded.owner_email
  returning id into initial_restaurant_id;

  insert into public.restaurant_admins (restaurant_id, user_id, username, role, is_active)
  values (initial_restaurant_id, owner_id, 'admin', 'owner', true)
  on conflict (restaurant_id, user_id) do update
    set username = excluded.username,
        role = excluded.role,
        is_active = true;

  insert into public.settings (restaurant_id)
  values (initial_restaurant_id)
  on conflict (restaurant_id) do nothing;
end;
$$;
