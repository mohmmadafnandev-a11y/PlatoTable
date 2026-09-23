import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { fromMinorUnits } from '../../shared/plans.js'
import { recordPaymentNotifications } from '../_lib/billing-notify.js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

/** Names for the notification text, so a message never says "a restaurant". */
async function context(restaurantId, planId) {
  const [{ data: restaurant }, { data: plan }] = await Promise.all([
    restaurantId ? admin.from('restaurants').select('name').eq('id', restaurantId).maybeSingle() : Promise.resolve({ data: null }),
    planId ? admin.from('subscription_plans').select('name').eq('id', planId).maybeSingle() : Promise.resolve({ data: null }),
  ])
  return { restaurantName: restaurant?.name || null, planName: plan?.name || null }
}

export const config = { api: { bodyParser: false } }
const readRawBody = (request) => new Promise((resolve, reject) => { const chunks = []; request.on('data', (chunk) => chunks.push(chunk)); request.on('end', () => resolve(Buffer.concat(chunks))); request.on('error', reject) })
const statusFor = (stripeStatus) => ({ trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'suspended' }[stripeStatus] || 'past_due')
const iso = (seconds) => seconds ? new Date(seconds * 1000).toISOString() : null
const syncSubscription = async (stripeSubscription, restaurantId) => {
  const item = stripeSubscription.items?.data?.[0]
  const price = item?.price
  const customerId = typeof stripeSubscription.customer === 'string' ? stripeSubscription.customer : stripeSubscription.customer?.id
  const record = {
    restaurant_id: restaurantId,
    provider: 'stripe',
    provider_customer_id: customerId || null,
    provider_subscription_id: stripeSubscription.id,
    status: statusFor(stripeSubscription.status),
    currency: (price?.currency || stripeSubscription.currency || 'USD').toUpperCase(),
    amount: Number(price?.unit_amount_decimal ?? price?.unit_amount ?? 0) / 100,
    trial_start: iso(stripeSubscription.trial_start),
    trial_end: iso(stripeSubscription.trial_end),
    current_period_start: iso(stripeSubscription.current_period_start),
    current_period_end: iso(stripeSubscription.current_period_end),
    cancel_at_period_end: Boolean(stripeSubscription.cancel_at_period_end),
    canceled_at: iso(stripeSubscription.canceled_at),
    trial_used_at: new Date().toISOString(),
  }
  return admin.from('subscriptions').upsert(record, { onConflict: 'restaurant_id' })
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).end()
  let event
  try { event = stripe.webhooks.constructEvent(await readRawBody(request), request.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET) }
  catch { return response.status(400).send('Invalid Stripe signature') }
  try {
    if (event.type === 'checkout.session.completed') {
      const checkout = event.data.object
      if (checkout.subscription && checkout.metadata?.restaurant_id) {
        const subscription = await stripe.subscriptions.retrieve(checkout.subscription)
        await syncSubscription(subscription, checkout.metadata.restaurant_id)

        // The restaurant just entered its card. That is the single most useful
        // thing for both sides to be told about, so it is announced here rather
        // than left for whoever next opens a dashboard.
        const price = subscription.items?.data?.[0]?.price
        const restaurantId = checkout.metadata.restaurant_id
        const info = await context(restaurantId, checkout.metadata?.plan_id)
        await recordPaymentNotifications(admin, {
          restaurantId,
          restaurantName: info.restaurantName,
          planName: info.planName,
          succeeded: true,
          amount: fromMinorUnits(price?.unit_amount ?? subscription.items?.data?.[0]?.price?.unit_amount ?? 0, (price?.currency || 'usd').toUpperCase()),
          currency: (price?.currency || 'usd').toUpperCase(),
          // Keyed on the session, so Stripe's at-least-once delivery of this
          // event produces one notification rather than several.
          dedupeKey: `checkout:${checkout.id}`,
          source: 'webhook',
        })
      }
    }
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object
      const restaurantId = subscription.metadata?.restaurant_id
      if (restaurantId) await syncSubscription(subscription, restaurantId)
      else await admin.from('subscriptions').update({ status: statusFor(subscription.status), cancel_at_period_end: Boolean(subscription.cancel_at_period_end), canceled_at: iso(subscription.canceled_at), current_period_start: iso(subscription.current_period_start), current_period_end: iso(subscription.current_period_end) }).eq('provider_subscription_id', subscription.id)
    }
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const invoice = event.data.object
      const succeeded = event.type === 'invoice.paid'
      const { data: subscription } = await admin
        .from('subscriptions')
        .select('id, restaurant_id, plan_id, currency')
        .eq('provider_subscription_id', invoice.subscription)
        .maybeSingle()

      if (subscription) {
        const currency = (invoice.currency || subscription.currency || 'USD').toUpperCase()
        await admin.from('subscriptions').update({
          status: succeeded ? 'active' : 'past_due',
          last_payment_status: succeeded ? 'paid' : 'failed',
          updated_at: new Date().toISOString(),
        }).eq('id', subscription.id)

        await admin.from('payment_transactions').upsert({
          restaurant_id: subscription.restaurant_id,
          subscription_id: subscription.id,
          provider: 'stripe',
          provider_transaction_id: invoice.payment_intent || invoice.id,
          // `fromMinorUnits` rather than a bare /100: Stripe reports the amount
          // in the currency's smallest unit, and a zero-decimal currency would
          // be recorded as a hundredth of what was actually taken.
          amount: fromMinorUnits(invoice.amount_paid || invoice.amount_due || 0, currency),
          currency,
          status: succeeded ? 'succeeded' : 'failed',
          invoice_url: invoice.hosted_invoice_url,
        }, { onConflict: 'provider_transaction_id' })

        const info = await context(subscription.restaurant_id, subscription.plan_id)
        await recordPaymentNotifications(admin, {
          restaurantId: subscription.restaurant_id,
          restaurantName: info.restaurantName,
          planName: info.planName,
          succeeded,
          amount: fromMinorUnits(invoice.amount_paid || invoice.amount_due || 0, currency),
          currency,
          dedupeKey: `invoice:${invoice.id}`,
          source: 'webhook',
        })
      }
    }
    return response.status(200).json({ received: true })
  } catch { return response.status(500).json({ error: 'Webhook processing failed' }) }
}
