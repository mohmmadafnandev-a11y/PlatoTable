# DayNight Landikotal Bazar

A premium digital restaurant menu and management platform built with React, Vite, and Supabase.

## Features

- Mobile-only customer menu with categories, search, settings, and item details
- Permanent per-table QR codes with 15-minute secure Supabase sessions
- Responsive admin dashboard for menu, categories, QR codes, settings, and live activity
- Downloadable QR code generation
- Supabase Auth, PostgreSQL, Storage, and Row Level Security foundation
- A dedicated Supabase Storage bucket per restaurant build
- Real Supabase-backed restaurant data; no customer or admin demo fallback

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `.env` with your Supabase project values:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-anon-key
```

Only use the publishable anon key in the frontend. Never commit database passwords or service-role keys.

## Supabase setup

Run `supabase/delete.sql` only to remove obsolete server-session, scan-log, and offer remnants. It preserves restaurant data, permanent QR codes, and the dedicated `daynight-landikotal-bazar1` Storage bucket. Then run the safe `supabase/schema.sql` setup. See `supabase/README.md` for the exact run order.

## Routes

- `/scan` — missing/invalid QR guidance
- `/scan/:token` — starts or validates the 15-minute table menu session
- `/scan/:token?session=:sessionToken` — existing table menu session
- `/scan/:token/search` — customer search page
- `/scan/:token/settings` — customer contact and display settings
- `/admin/login` — staff login
- `/admin` — restaurant management dashboard

Admin access requires a real Supabase Auth user that is linked to a `restaurant_admins` record.

## Validation

```bash
npm run lint
npm run build
```
