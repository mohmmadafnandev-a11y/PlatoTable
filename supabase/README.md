# DayNight Landikotal Bazar Supabase setup

This project already has its core restaurant tables. Do **not** run SQL that
recreates or deletes `restaurants`, `restaurant_admins`, `categories`,
`menu_items`, `qr_tokens`, or `settings`.

## Current architecture

- A permanent QR record is stored in `qr_tokens`.
- The customer menu validates that QR through `get_scan_menu`.
- The 15-minute customer access timer is stored only in browser `sessionStorage`.
  It survives refresh in the same tab and is not stored in Supabase.
- Each restaurant build has its own Storage bucket. This restaurant uses:

  ```text
  daynight-landikotal-bazar1
  ```

## Run order for this restaurant

1. Run `supabase/delete.sql` once if you want to remove only obsolete server
   session, scan-log, and offer remnants. It preserves your restaurants, menu,
   categories, permanent QR codes, settings, and the bucket/images.
2. Run `supabase/schema.sql`. It is safe to rerun: it creates/updates only the
   `daynight-landikotal-bazar1` bucket policies and the `get_scan_menu` RPC.
3. Do not run an old full schema that starts with `create table restaurants` on
   this existing project; that is what produced the `relation already exists`
   error.

The admin is configured in `.env`:

```env
VITE_RESTAURANT_NAME=DayNight Landikotal Bazar
VITE_RESTAURANT_SLUG=daynight-landikotal-bazar1
```

Never put a Supabase service-role key or database password in frontend files.
The frontend requires only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
