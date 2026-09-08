# Supabase setup

1. Open the Supabase SQL editor for the project.
2. Run `migrations/001_initial_schema.sql` once.
3. Run `seed/seed.sql` for the Saffron Table demo content.
4. Create an Auth user for the restaurant owner.
5. Link that user to the restaurant:

```sql
insert into public.restaurant_admins (restaurant_id, user_id, username, role)
values (
  '11111111-1111-4111-8111-111111111111',
  '<AUTH_USER_UUID>',
  'admin',
  'owner'
);
```

The browser app uses only `VITE_SUPABASE_URL` and the publishable anon key. Never expose the database password or service-role key in frontend files.

The QR validation RPC (`validate_qr`) safely checks and logs scans without granting public access to the `qr_tokens` table.
