# Vercel API routes

These routes run server-side on Vercel. Configure the following **server-only** Vercel environment variables before deploying:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_APP_URL`

Create the Stripe webhook at `https://YOUR_DOMAIN/api/stripe/webhook` and subscribe to:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Never prefix secrets with `VITE_`.
