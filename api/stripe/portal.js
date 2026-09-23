import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// The Customer Portal is the only way a card is ever changed. Stripe hosts the
// page, so no card number, CVC or expiry passes through this application at all
// — which is the security posture the PRD asks for, achieved by never handling
// the data rather than by handling it carefully.
//
// Callable by the restaurant's own admin (updating their card) as well as by
// platform staff (helping them over the phone). A restaurant admin may only open
// a portal for the restaurant they belong to.

async function caller(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null

  const [{ data: staff }, { data: membership }] = await Promise.all([
    admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle(),
    admin.from('restaurant_admins').select('restaurant_id, is_active, role').eq('user_id', user.id).maybeSingle(),
  ])
  const isStaff = staff?.is_active && ['super_admin', 'billing', 'support'].includes(staff.role)
  return {
    id: user.id,
    isStaff,
    restaurantId: membership?.is_active ? membership.restaurant_id : null,
    label: isStaff ? `staff:${staff.role}` : 'restaurant admin',
  }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return response.status(503).json({ error: 'STRIPE_SECRET_KEY is not set for this deployment, so the billing portal is unavailable.' })
  const stripe = new Stripe(key)

  try {
    const who = await caller(request)
    if (!who) return response.status(403).json({ error: 'Not authorized.' })

    const requested = request.body?.restaurantId
    const restaurantId = who.isStaff ? requested : who.restaurantId

    if (!uuid.test(restaurantId || '')) return response.status(400).json({ error: 'A valid restaurant is required.' })
    // Staff may open any restaurant's portal; a restaurant admin only their own.
    if (!who.isStaff && requested && requested !== who.restaurantId) {
      return response.status(403).json({ error: 'You can only manage billing for your own restaurant.' })
    }

    const { data: subscription } = await admin
      .from('subscriptions')
      .select('id, provider_customer_id, restaurant_id, restaurants(subdomain)')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (!subscription?.provider_customer_id) {
      return response.status(409).json({ error: 'This restaurant has no Stripe customer yet, so there is nothing to manage. Start a subscription first.' })
    }

    const base = (process.env.VITE_CANONICAL_BASE_URL || process.env.VITE_APP_URL || '').replace(/\/+$/, '')
    // Return them where they started. A restaurant admin lives under their own
    // slug; sending them to the platform's subscription list would show them a
    // screen that is not theirs.
    const subdomain = subscription.restaurants?.subdomain
    const returnPath = who.isStaff || !subdomain ? '/admin/subscriptions' : `/admin/${subdomain}/subscription`
    // Stripe requires an absolute return URL, so a deployment with no configured
    // base has to say so rather than fail with a puzzling portal error.
    if (!base) {
      return response.status(503).json({ error: 'This deployment has no public base URL. Set VITE_CANONICAL_BASE_URL so Stripe knows where to return the customer.' })
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.provider_customer_id,
      return_url: `${base}${returnPath}`,
    })

    await admin.from('activity_logs').insert({
      super_admin_id: who.isStaff ? who.id : null,
      restaurant_id: restaurantId,
      action: 'subscription.portal_opened',
      details: { opened_by: who.label },
    })

    return response.status(200).json({ url: session.url })
  } catch (error) {
    console.error('[portal] failed:', error)
    // The portal has to be switched on once per Stripe account; Stripe's own
    // wording for that is obscure, so translate it.
    if (/No configuration provided|default configuration/i.test(error?.message || '')) {
      return response.status(409).json({ error: 'The Stripe Customer Portal has not been activated for this account yet. Activate it in Stripe → Settings → Billing → Customer portal.' })
    }
    return response.status(500).json({ error: error?.message || 'Could not open the Stripe billing portal.' })
  }
}
