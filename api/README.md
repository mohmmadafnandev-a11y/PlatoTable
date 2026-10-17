# Vercel API routes

These routes run server-side on Vercel. Configure the following **server-only** Vercel environment variables before deploying:

- `SAFEPAY_ENV` — `sandbox` or `production`; picks the Safepay hosts. Nothing in the UI states the mode, and anything that is not exactly `production` is treated as sandbox.
- `SAFEPAY_MERCHANT_KEY`
- `SAFEPAY_SECRET_KEY`
- `SAFEPAY_WEBHOOK_SECRET` — the webhook HMAC key from Safepay dashboard → Developers → Endpoints. Without it no incoming event can be verified, so every webhook is rejected.
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_APP_URL`
- `CRON_SECRET` — bearer token for `api/billing/sweep.js` (and the staff-only `api/rates.js`).

`SAFEPAY_HOST` and `SAFEPAY_CHECKOUT_HOST` are optional overrides and are only needed for a Safepay host that is not one of the two standard pairs.

Create the Safepay webhook at `https://YOUR_DOMAIN/api/safepay/webhook` and subscribe to:

- `subscription.created`
- `subscription.payment.succeeded`
- `subscription.payment.failed`
- `subscription.cancelled`

Paused and resumed subscription events are handled too, and `payment.succeeded` is a deliberate no-op — the platform already wrote that payment from `subscription.created` / `subscription.payment.succeeded`, and taking the amount from an event instead of from the plan on file is how a charge gets recorded at the wrong price.

Billing is Pakistan-only and priced in PKR. Prices live in `subscription_plans.price_pkr`; a plan is only chargeable once it has been mirrored into Safepay as a plan token (`safepay_plan_id`, or `safepay_plan_id_trial` for the trial variant) by `api/safepay/plans.js`.

Never prefix secrets with `VITE_`.
