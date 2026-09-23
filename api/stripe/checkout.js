import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { resolvePlanPrice } from '../../shared/plans.js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Opens Stripe Checkout for a restaurant's subscription.
//
// The client sends a restaurant and a plan — never a price. Accepting a
// price id from the browser would let anyone with a super admin session bill a
// restaurant at a price of their choosing; resolving it here from the plan and
// the restaurant's own currency means the amount charged is always the one that
// is actually on file.
//
// This is the only place a subscription is started. Everything after it —
// status, dates, invoices — is written by the webhook, because Stripe is the
// source of truth for money and the browser never is.

// Either platform staff (starting a subscription on a restaurant's behalf) or
// the restaurant's own admin (subscribing themselves). Both are legitimate, and
// the difference matters only for which restaurant they may touch and where
// Stripe should send them back afterwards.
async function requireActor(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null

  const [{ data: staff }, { data: membership }] = await Promise.all([
    admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle(),
    admin.from('restaurant_admins').select('restaurant_id, is_active').eq('user_id', user.id).maybeSingle(),
  ])

  const isStaff = Boolean(staff?.is_active && ['super_admin', 'billing'].includes(staff.role))
  return {
    id: user.id,
    isStaff,
    // Their own restaurant, if they administer one. This is the only restaurant
    // a non-staff caller is ever allowed to subscribe.
    restaurantId: membership?.is_active ? membership.restaurant_id : null,
    label: isStaff ? `staff:${staff.role}` : 'restaurant admin',
  }
}

/** Absolute base for the browser to return to. Canonical first, same as the QR generator. */
const baseUrl = (request) => {
  const configured = (process.env.VITE_CANONICAL_BASE_URL || process.env.VITE_APP_URL || '').replace(/\/+$/, '')
  if (configured) return configured
  const host = request.headers['x-forwarded-host'] || request.headers.host
  return host ? `https://${host}` : ''
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to start a subscription.' })

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return response.status(503).json({ error: 'STRIPE_SECRET_KEY is not set for this deployment, so subscriptions cannot be started yet.' })
  const stripe = new Stripe(key)

  try {
    const requested = request.body || {}
    const planId = requested.planId
    // Staff may name any restaurant; a restaurant admin may only ever be the
    // restaurant they belong to, so the id they send is ignored in favour of
    // their membership rather than trusted.
    const restaurantId = actor.isStaff ? requested.restaurantId : actor.restaurantId

    if (!restaurantId) {
      return response.status(403).json({ error: 'This account is not attached to a restaurant, so it has nothing to subscribe.' })
    }
    if (!uuid.test(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })
    if (!uuid.test(planId || '')) return response.status(400).json({ error: 'Choose a plan to subscribe to.' })

    const [{ data: restaurant }, { data: plan }] = await Promise.all([
      admin.from('restaurants').select('id, name, subdomain, currency, owner_email, is_active').eq('id', restaurantId).maybeSingle(),
      admin.from('subscription_plans').select('*').eq('id', planId).maybeSingle(),
    ])
    if (!restaurant) return response.status(404).json({ error: 'That restaurant no longer exists.' })
    if (!plan) return response.status(404).json({ error: 'That plan no longer exists.' })
    if (!plan.is_active) return response.status(400).json({ error: `${plan.name} is deactivated and cannot be subscribed to.` })

    // The restaurant's currency decides the price, which is the whole reason the
    // plan carries one price per currency instead of a single headline figure.
    const priced = resolvePlanPrice(plan, restaurant.currency)
    if (!priced) return response.status(400).json({ error: `${plan.name} has no ${restaurant.currency} price, so it cannot bill ${restaurant.name}. Add that price in Plans & pricing.` })
    if (!priced.priceId) return response.status(409).json({ error: `${plan.name} is not linked to Stripe for ${restaurant.currency} yet. Re-save the plan to create its Stripe prices.` })

    const { data: subscription } = await admin.from('subscriptions').select('id, provider_customer_id, trial_used_at').eq('restaurant_id', restaurantId).maybeSingle()

    // One Stripe customer per restaurant. Reusing it is what lets an operator
    // change a card once and have every future invoice use it.
    let customerId = subscription?.provider_customer_id || null
    if (customerId) {
      const existing = await stripe.customers.retrieve(customerId).catch((error) => {
        if (error?.statusCode === 404 || error?.code === 'resource_missing') return null
        throw error
      })
      if (!existing || existing.deleted) customerId = null
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: restaurant.name,
        email: restaurant.owner_email || undefined,
        metadata: { restaurant_id: restaurant.id, subdomain: restaurant.subdomain },
      })
      customerId = customer.id
    }

    // A trial is offered once per restaurant. `trial_used_at` is stamped when a
    // subscription first attaches, so a cancelled customer cannot loop free
    // trials by resubscribing.
    const trialDays = subscription?.trial_used_at ? 0 : Math.max(0, Number(plan.trial_days) || 0)
    const base = baseUrl(request)
    // Stripe refuses a relative return URL with a bare "Not a valid URL", which
    // reads like a bug in this code rather than a missing setting. Say which one
    // it is. In production the request always carries a host, so this only fires
    // when the function is called without one (a script, or a misconfigured
    // proxy) and no canonical base is set.
    if (!base) {
      return response.status(503).json({ error: 'This deployment has no public base URL. Set VITE_CANONICAL_BASE_URL so Stripe knows where to return the customer.' })
    }
    // Return them where they started. A restaurant admin lives under their own
    // slug, and dropping them into the platform's subscription list would show
    // them a screen that is not theirs.
    const returnTo = actor.isStaff
      ? `${base}/admin/subscriptions`
      : `${base}/admin/${restaurant.subdomain}/subscription`

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priced.priceId, quantity: 1 }],
      success_url: `${returnTo}?checkout=success&restaurant=${restaurant.id}`,
      cancel_url: `${returnTo}?checkout=canceled&restaurant=${restaurant.id}`,
      client_reference_id: restaurant.id,
      metadata: { restaurant_id: restaurant.id, plan_id: plan.id, initiated_by: actor.id, initiated_by_role: actor.label },
      // Carried onto the subscription itself so the webhook can resolve a
      // subscription back to a restaurant without a lookup table.
      subscription_data: {
        metadata: { restaurant_id: restaurant.id, plan_id: plan.id },
        ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      },
      allow_promotion_codes: true,
    })

    // Record the customer (and the plan being attempted) now, so the restaurant's
    // billing screen shows the right plan even if the customer abandons checkout.
    if (subscription) {
      await admin.from('subscriptions').update({
        plan_id: plan.id,
        provider: 'stripe',
        provider_customer_id: customerId,
        updated_at: new Date().toISOString(),
      }).eq('id', subscription.id)
    } else {
      await admin.from('subscriptions').insert({
        restaurant_id: restaurant.id,
        plan_id: plan.id,
        provider: 'stripe',
        provider_customer_id: customerId,
        status: 'past_due',
        currency: priced.currency,
        amount: priced.amount,
      })
    }

    await admin.from('activity_logs').insert({
      super_admin_id: actor.isStaff ? actor.id : null,
      restaurant_id: restaurant.id,
      action: 'subscription.checkout_started',
      details: { plan_id: plan.id, plan: plan.name, currency: priced.currency, amount: priced.amount, trial_days: trialDays, stripe_price_id: priced.priceId, started_by: actor.label },
    })

    return response.status(200).json({ url: session.url, sessionId: session.id, currency: priced.currency, amount: priced.amount, trialDays })
  } catch (error) {
    console.error('[checkout] failed:', error)
    return response.status(500).json({ error: error?.message || 'Could not open Stripe Checkout.' })
  }
}
