-- Run after 001 and 002, after creating this user in Supabase Dashboard:
-- Authentication > Users > Add user
-- Email: admin@palatotabale.local
-- Password: admin
-- Enable "Auto Confirm User" when creating it.
--
-- This creates only the initial PalatoTabale restaurant, its settings, and
-- its owner membership. It does not add categories, menu items, offers, or QR codes.

do $$
declare
  owner_id uuid;
  initial_restaurant_id uuid;
begin
  select id into owner_id
  from auth.users
  where email = 'admin@palatotabale.local';

  if owner_id is null then
    raise exception 'Create and auto-confirm admin@palatotabale.local in Supabase Auth before running this script.';
  end if;

  insert into public.restaurants (name, subdomain, owner_email, currency)
  values ('PalatoTabale', 'palatotabale', 'admin@palatotabale.local', 'PKR')
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
