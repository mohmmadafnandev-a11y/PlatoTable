import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const stripeId = /^sub_[A-Za-z0-9]+$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const statusFor = (status) => ({ trialing: 'trialing', active: 'active', past_due: 'past_due', canceled: 'canceled', unpaid: 'suspended' }[status] || 'past_due')
const iso = (seconds) => seconds ? new Date(seconds * 1000).toISOString() : null

async function requireBillingStaff(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null
  const { data } = await admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle()
  return data?.is_active && ['super_admin', 'billing'].includes(data.role) ? data : null
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })
  try {
    const staff = await requireBillingStaff(request)
    if (!staff) return response.status(403).json({ error: 'Not authorized' })

    const { restaurantId, subscriptionId, planId } = request.body || {}
    if (!uuid.test(restaurantId || '') || !stripeId.test(subscriptionId || '')) return response.status(400).json({ error: 'A valid restaurant and Stripe subscription ID are required.' })
    if (planId && !uuid.test(planId)) return response.status(400).json({ error: 'The selected plan is invalid.' })

    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    const existing = await admin.from('subscriptions').select('trial_used_at').eq('restaurant_id', restaurantId).maybeSingle()
    if (existing.error) throw existing.error

    const item = subscription.items?.data?.[0]
    const price = item?.price
    const amount = Number(price?.unit_amount_decimal ?? price?.unit_amount ?? 0) / 100
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id
    const update = {
      restaurant_id: restaurantId,
      plan_id: planId || null,
      provider: 'stripe',
      provider_customer_id: customerId || null,
      provider_subscription_id: subscription.id,
      status: statusFor(subscription.status),
      currency: (price?.currency || subscription.currency || 'USD').toUpperCase(),
      amount,
      trial_start: iso(subscription.trial_start),
      trial_end: iso(subscription.trial_end),
      current_period_start: iso(subscription.current_period_start),
      current_period_end: iso(subscription.current_period_end),
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      canceled_at: iso(subscription.canceled_at),
      trial_used_at: existing.data?.trial_used_at || new Date().toISOString(),
    }

    const { data, error } = await admin.from('subscriptions').upsert(update, { onConflict: 'restaurant_id' }).select('id').single()
    if (error) throw error
    await stripe.subscriptions.update(subscription.id, { metadata: { ...subscription.metadata, restaurant_id: restaurantId, linked_by: staff.id } })
    await admin.from('activity_logs').insert({ super_admin_id: staff.id, restaurant_id: restaurantId, action: 'subscription.stripe_linked', details: { provider_subscription_id: subscription.id, provider_customer_id: customerId } })
    return response.status(200).json({ subscriptionId: data.id, status: update.status })
  } catch (error) {
    return response.status(500).json({ error: error?.message || 'Could not link the Stripe subscription.' })
  }
}
