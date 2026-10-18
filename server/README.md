# Server-side handlers

These handlers run server-side on Vercel. They live in this folder rather than
under `api/` because the Hobby plan caps a deployment at twelve serverless
functions: `api/router.js` is the deployment's single function, and a
`vercel.json` rewrite (`/api/:path*` → `/api/router?route=:path*`) dispatches
every `/api/…` request to the handler here. The dev shim routes through the same
function, so dev and production share the dispatch — a bracket catch-all under
`api/` was measured NOT to work for this project type (multi-segment URLs 404 at
the edge).

Configure the following **server-only** Vercel environment variables before deploying:

- `SAFEPAY_ENV` — `sandbox` or `production`; picks the Safepay hosts. Nothing in the UI states the mode, and anything that is not exactly `production` is treated as sandbox.
- `SAFEPAY_MERCHANT_KEY`
- `SAFEPAY_SECRET_KEY`
- `SAFEPAY_WEBHOOK_SECRET` — the webhook HMAC key from Safepay dashboard → Developers → Endpoints. Without it no incoming event can be verified, so every webhook is rejected.
- `SUPABASE_SERVICE_ROLE_KEY`
- `VITE_SUPABASE_URL`
- `VITE_APP_URL`
- `CRON_SECRET` — bearer token for `server/billing/sweep.js` (and the staff-only `server/rates.js`).

`SAFEPAY_HOST` and `SAFEPAY_CHECKOUT_HOST` are optional overrides and are only needed for a Safepay host that is not one of the two standard pairs.

Create the Safepay webhook at `https://YOUR_DOMAIN/api/safepay/webhook` and
subscribe to every payment event your dashboard offers. The handler looks for a
payment tracker anywhere in the payload and records that payment from Safepay's
own record of it, so an unexpected event type is a safe no-op. If
`subscription.*` events are listed (`subscription.created`,
`subscription.payment.succeeded`, `subscription.payment.failed`,
`subscription.cancelled`, paused/resumed), tick those too: the platform does not
use Safepay's Subscriptions product, but a subscription created by hand in the
dashboard is at least reported rather than silently dropped.

Billing is Pakistan-only and priced in PKR. Prices live in `subscription_plans.price_pkr`; a plan is only chargeable once it has been mirrored into Safepay as a plan token (`safepay_plan_id`, or `safepay_plan_id_trial` for the trial variant) by `server/safepay/plans.js`.

Never prefix secrets with `VITE_`.
