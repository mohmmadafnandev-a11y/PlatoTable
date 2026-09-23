import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { CURRENCIES, PRICE_COLUMNS, fromMinorUnits, stripePriceColumn } from '../../shared/plans.js'
import { recordPaymentNotifications } from '../_lib/billing-notify.js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Stripe is the source of truth for money, and the webhook is how that truth
// normally reaches this database. Local development cannot receive a webhook at
// all — Stripe has no route to a laptop — so without this endpoint the billing
// screens are untestable except by deploying, and a missed delivery (Stripe
// retries for days but gives up) has no recovery path even in production.
//
// This is a pull, on demand, run by an operator who wants the database to match
// Stripe right now. It is deliberately not a background job: it writes money
// fields, and it should be something a person chooses and can see the result of.

const statusFor = (status) => ({ trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'suspended', incomplete: 'past_due', incomplete_expired: 'canceled', paused: 'suspended' }[status] || 'past_due')
const iso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null)

async function requireBillingStaff(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null
  const { data } = await admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle()
  return data?.is_active && ['super_admin', 'billing'].includes(data.role) ? data : null
}

/**
 * Pull products and prices back from Stripe.
 *
 * Two things this fixes that would otherwise be invisible: a plan saved while
 * Stripe was unreachable has no stored product id, and a price edited directly
 * in the Stripe dashboard makes the local figure a lie. Both are reconciled
 * here, and the differing amounts are reported rather than quietly overwritten.
 */
async function syncPlans(stripe, staff) {
  const products = await stripe.products.list({ limit: 100 })
  const byPlanId = new Map()
  for (const product of products.data) {
    const planId = product.metadata?.platotable_plan_id
    if (planId) byPlanId.set(planId, product)
  }

  const { data: plans, error } = await admin.from('subscription_plans').select('*')
  if (error) throw error

  const report = { checked: plans.length, linked: 0, missing: [], prices: [], repriced: [] }

  for (const plan of plans) {
    const product = byPlanId.get(plan.id)
    if (!product) {
      report.missing.push(plan.name)
      await admin.from('subscription_plans')
        .update({ stripe_synced_at: null, stripe_sync_error: 'Not present in Stripe — re-save this plan to create it.' })
        .eq('id', plan.id)
      continue
    }

    const prices = await stripe.prices.list({ product: product.id, limit: 100, active: true })
    const patch = { stripe_product_id: product.id }
    const rebuilt = []

    for (const currency of CURRENCIES) {
      const code = String(currency).toLowerCase()
      // Newest active price per currency wins — that is the one Checkout would use.
      const match = prices.data
        .filter((price) => price.currency === code)
        .sort((a, b) => b.created - a.created)[0]
      const column = stripePriceColumn(currency)

      if (!match) {
        // No active Stripe price. If the plan charges in this currency, that is a
        // real gap worth reporting; if it does not, clearing the column is right.
        if (plan[PRICE_COLUMNS[currency]] !== null && Number(plan[PRICE_COLUMNS[currency]]) > 0) report.missing.push(`${plan.name} (${currency})`)
        patch[column] = null
        continue
      }

      patch[column] = match.id
      // The price Stripe would actually charge becomes the local figure, because
      // Stripe is the authority on money. A difference is reported, never hidden.
      const amount = fromMinorUnits(match.unit_amount, currency)
      rebuilt.push(`${match.currency.toUpperCase()} ${amount}`)
      if (plan[PRICE_COLUMNS[currency]] !== null && Number(plan[PRICE_COLUMNS[currency]]) !== amount) {
        report.repriced.push({ plan: plan.name, currency, from: Number(plan[PRICE_COLUMNS[currency]]), to: amount })
      }
      patch[PRICE_COLUMNS[currency]] = amount
    }

    report.prices.push({ plan: plan.name, prices: rebuilt })
    patch.stripe_synced_at = new Date().toISOString()
    patch.stripe_sync_error = null
    patch.updated_at = new Date().toISOString()

    // Mirror Stripe's own view of whether the plan can still be sold.
    if (!product.active && plan.is_active) patch.is_active = false

    const { error: updateError } = await admin.from('subscription_plans').update(patch).eq('id', plan.id)
    if (updateError) throw updateError
    report.linked += 1
  }

  await admin.from('activity_logs').insert({
    super_admin_id: staff.id,
    action: 'plan.synced_from_stripe',
    details: { linked: report.linked, missing: report.missing, repriced: report.repriced },
  })
  return report
}

/** Pull subscription state and invoices back from Stripe. */
async function syncSubscriptions(stripe, staff) {
  const { data: localSubscriptions, error } = await admin
    .from('subscriptions')
    .select('id, restaurant_id, provider_customer_id, provider_subscription_id, plan_id, trial_used_at')
  if (error) throw error

  const byCustomer = new Map(localSubscriptions.filter((row) => row.provider_customer_id).map((row) => [row.provider_customer_id, row]))
  const bySubscription = new Map(localSubscriptions.filter((row) => row.provider_subscription_id).map((row) => [row.provider_subscription_id, row]))

  const report = { checked: 0, updated: 0, unmatched: [], transactions: 0, notifications: 0 }

  // Names for the notification text. Read once rather than per invoice, so a
  // sync of a hundred invoices is not a hundred round trips.
  const [{ data: restaurantRows }, { data: planRows }] = await Promise.all([
    admin.from('restaurants').select('id, name'),
    admin.from('subscription_plans').select('id, name'),
  ])
  const restaurantNames = new Map((restaurantRows || []).map((row) => [row.id, row.name]))
  const planNames = new Map((planRows || []).map((row) => [row.id, row.name]))

  for await (const subscription of stripe.subscriptions.list({ limit: 100 })) {
    report.checked += 1
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
    const local = bySubscription.get(subscription.id) || byCustomer.get(customerId)
      || localSubscriptions.find((row) => row.restaurant_id === subscription.metadata?.restaurant_id)

    if (!local) {
      report.unmatched.push(subscription.id)
      continue
    }

    const price = subscription.items?.data?.[0]?.price
    const patch = {
      provider: 'stripe',
      provider_customer_id: customerId || local.provider_customer_id,
      provider_subscription_id: subscription.id,
      status: statusFor(subscription.status),
      currency: (price?.currency || subscription.currency || 'USD').toUpperCase(),
      amount: fromMinorUnits(price?.unit_amount ?? 0, (price?.currency || 'usd').toUpperCase()),
      trial_start: iso(subscription.trial_start),
      trial_end: iso(subscription.trial_end),
      current_period_start: iso(subscription.current_period_start),
      current_period_end: iso(subscription.current_period_end),
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      canceled_at: iso(subscription.canceled_at),
      updated_at: new Date().toISOString(),
    }
    // Stripe states the plan through metadata; the local plan is the fallback so
    // a sync never blanks a plan a person deliberately chose.
    const planFromStripe = subscription.metadata?.plan_id
    if (planFromStripe) patch.plan_id = planFromStripe
    else if (!local.plan_id && price?.id) {
      const { data: matched } = await admin.from('subscription_plans').select('id').eq(`stripe_price_${(price.currency || 'usd')}`, price.id).maybeSingle()
      if (matched) patch.plan_id = matched.id
    }
    if (subscription.trial_start && !local.trial_used_at) patch.trial_used_at = iso(subscription.trial_start)

    const { error: updateError } = await admin.from('subscriptions').update(patch).eq('id', local.id)
    if (updateError) throw updateError
    report.updated += 1
  }

  // Invoices are the payment ledger. Only settled or failed attempts are
  // recorded; an open draft is not money that has moved.
  for await (const invoice of stripe.invoices.list({ limit: 100 })) {
    if (!invoice.subscription) continue
    const succeeded = invoice.status === 'paid' || invoice.paid
    if (!succeeded && invoice.status !== 'open' && invoice.status !== 'uncollectible') continue

    const local = bySubscription.get(invoice.subscription) || byCustomer.get(typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id)
    if (!local) continue

    const currency = (invoice.currency || 'usd').toUpperCase()
    const paid = invoice.status === 'paid'

    const { error: upsertError } = await admin.from('payment_transactions').upsert({
      restaurant_id: local.restaurant_id,
      subscription_id: local.id,
      provider: 'stripe',
      provider_transaction_id: invoice.payment_intent || invoice.id,
      amount: fromMinorUnits(invoice.amount_paid || invoice.amount_due || 0, currency),
      currency,
      status: paid ? 'succeeded' : invoice.status === 'open' ? 'pending' : 'failed',
      invoice_url: invoice.hosted_invoice_url || null,
      created_at: iso(invoice.created) || new Date().toISOString(),
    }, { onConflict: 'provider_transaction_id' })
    if (upsertError) throw upsertError
    report.transactions += 1

    // A sync is often run precisely because a webhook was missed, so the
    // notifications that webhook would have written are written here too. The
    // dedupe key is the invoice id — the same one the webhook uses — so a
    // recovered payment does not announce itself twice.
    const { written } = await recordPaymentNotifications(admin, {
      restaurantId: local.restaurant_id,
      restaurantName: restaurantNames.get(local.restaurant_id),
      planName: planNames.get(local.plan_id),
      succeeded: paid,
      amount: fromMinorUnits(invoice.amount_paid || invoice.amount_due || 0, currency),
      currency,
      dedupeKey: `invoice:${invoice.id}`,
      source: 'sync',
    })
    report.notifications += written
  }

  await admin.from('activity_logs').insert({
    super_admin_id: staff.id,
    action: 'subscription.synced_from_stripe',
    details: { checked: report.checked, updated: report.updated, unmatched: report.unmatched, transactions: report.transactions, notifications: report.notifications },
  })
  return report
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const staff = await requireBillingStaff(request)
  if (!staff) return response.status(403).json({ error: 'Only a super admin or billing operator can sync with Stripe.' })

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return response.status(503).json({ error: 'STRIPE_SECRET_KEY is not set for this deployment, so there is nothing to sync.' })
  const stripe = new Stripe(key)

  try {
    const scope = request.body?.scope || 'all'
    const result = {}
    if (scope === 'plans' || scope === 'all') result.plans = await syncPlans(stripe, staff)
    if (scope === 'subscriptions' || scope === 'all') result.subscriptions = await syncSubscriptions(stripe, staff)
    return response.status(200).json(result)
  } catch (error) {
    console.error('[sync] failed:', error)
    return response.status(500).json({ error: error?.message || 'Could not sync with Stripe.' })
  }
}
