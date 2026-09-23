import { supabase } from './supabase'

// Every Stripe call from the browser goes through here.
//
// Two reasons this is a module rather than a fetch in each screen. The endpoints
// require a platform session, so the token has to be attached to all of them and
// forgetting it in one place produces a confusing 403. And `fetch` does not throw
// on 4xx/5xx, so a naive caller treats a rejected card, a missing API key, and a
// duplicate plan name as the same silent success — which is how a screen ends up
// reporting "saved" for something Stripe refused.

/** Thrown with the server's own wording, so the screen never invents a cause. */
export class StripeApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
  }
}

export async function postStripe(path, body) {
  if (!supabase) throw new StripeApiError('Supabase is not configured for this deployment.', 0)
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new StripeApiError('Your session expired. Please sign in again.', 401)

  let response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    // A network failure is not a Stripe refusal. Saying so is the difference
    // between an operator retrying and an operator filing a bug.
    throw new StripeApiError('Could not reach the server. Check your connection and try again.', 0)
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new StripeApiError(payload.error || `The request failed (${response.status}).`, response.status)
  }
  return payload
}

export const savePlan = (plan) => postStripe('/api/stripe/plans', { action: 'save', plan })
export const deletePlan = (id) => postStripe('/api/stripe/plans', { action: 'delete', plan: { id } })
export const syncFromStripe = (scope = 'all') => postStripe('/api/stripe/sync', { scope })
export const startSubscription = (restaurantId, planId) => postStripe('/api/stripe/checkout', { restaurantId, planId })
export const openBillingPortal = (restaurantId) => postStripe('/api/stripe/portal', { restaurantId })

// The sweep normally runs on Vercel Cron. Being able to trigger it by hand is
// what makes the trial-warning and grace notifications reachable in a session
// rather than only on the morning after they were written.
export const runBillingSweep = (dryRun = false) => postStripe('/api/billing/sweep', { dry_run: dryRun })
