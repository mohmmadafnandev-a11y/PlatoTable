# DayNight Landikotal Bazar

A premium digital restaurant menu and management platform built with React, Vite, and Supabase.

## Features

- Responsive customer menu with categories, search, offers, and item details
- QR-based table sessions with secure Supabase validation
- Premium admin dashboard for menu, offers, QR codes, and live activity
- Downloadable QR code generation
- Supabase Auth, PostgreSQL, Storage, and Row Level Security foundation
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

Run these files in the Supabase SQL editor in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_secure_customer_menu.sql`

Create your first restaurant and admin user using the SQL in `supabase/README.md`.

See `supabase/README.md` for instructions on linking an authenticated admin user.

## Routes

- `/scan` — missing/invalid QR guidance
- `/scan/:token` — validated table menu session
- `/scan/:token/search` — customer search page
- `/scan/:token/offers` — active offers
- `/scan/:token/categories` — category picker
- `/admin/login` — staff login
- `/admin` — restaurant management dashboard

Admin access requires a real Supabase Auth user that is linked to a `restaurant_admins` record.

## Validation

```bash
npm run lint
npm run build
```
