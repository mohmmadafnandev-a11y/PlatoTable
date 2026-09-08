# Production Supabase setup

1. Create a Supabase project and add its URL and publishable anon key to `.env`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-anon-key
```

2. In the SQL Editor, run these migrations in sequence:
   - `migrations/001_initial_schema.sql`
   - `migrations/002_secure_customer_menu.sql`
   - `migrations/003_bootstrap_daynight_landikotal_bazar1.sql` — run this after creating the Auth user described in that file

3. Create the restaurant (replace the values):

```sql
insert into public.restaurants (name, subdomain, owner_email, currency)
values ('My Restaurant', 'my-restaurant', 'owner@example.com', 'PKR')
returning id;
```

4. This build is configured for **DayNight Landikotal Bazar** with the immutable slug `daynight-landikotal-bazar1`. Create the user `admin@daynight-landikotal-bazar1.local` in **Authentication → Users**, set a secure password of at least 6 characters, and enable **Auto Confirm User**. Then run `migrations/003_bootstrap_daynight_landikotal_bazar1.sql`; it creates the restaurant, owner membership, and settings with no menu or other demo data.

For custom restaurant ownership instead, create an owner account in **Authentication → Users**. Copy its user UUID, then link it to the restaurant:

```sql
insert into public.restaurant_admins (restaurant_id, user_id, username, role)
values ('<RESTAURANT_UUID>', '<AUTH_USER_UUID>', 'admin', 'owner');

insert into public.settings (restaurant_id)
values ('<RESTAURANT_UUID>');
```

5. Sign in at `/admin/login` with username `admin` and the password you set in Supabase. Add categories, menu items, offers, and table QR codes from the admin panel.

The customer menu only loads through a valid `/scan/:token` URL. QR tokens and scan logs are not publicly readable; the `validate_qr` and `get_scan_menu` RPCs provide only the validated data needed by a guest session.

Never place a Supabase service-role key, database password, or other secret in frontend environment variables.
