# Production Supabase setup

1. Create a Supabase project and add its URL and publishable anon key to `.env`:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-anon-key
```

2. In the SQL Editor, run these migrations in sequence:
   - `migrations/001_initial_schema.sql`
   - `migrations/002_secure_customer_menu.sql`

3. Create the restaurant (replace the values):

```sql
insert into public.restaurants (name, subdomain, owner_email, currency)
values ('My Restaurant', 'my-restaurant', 'owner@example.com', 'PKR')
returning id;
```

4. Create an owner account in **Authentication → Users**. Copy its user UUID, then link it to the restaurant:

```sql
insert into public.restaurant_admins (restaurant_id, user_id, username, role)
values ('<RESTAURANT_UUID>', '<AUTH_USER_UUID>', 'owner', 'owner');

insert into public.settings (restaurant_id)
values ('<RESTAURANT_UUID>');
```

5. Sign in at `/admin/login`. Add categories, menu items, offers, and table QR codes from the admin panel.

The customer menu only loads through a valid `/scan/:token` URL. QR tokens and scan logs are not publicly readable; the `validate_qr` and `get_scan_menu` RPCs provide only the validated data needed by a guest session.

Never place a Supabase service-role key, database password, or other secret in frontend environment variables.
