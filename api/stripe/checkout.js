import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function requirePlatformStaff(request) {
  const token = request.headers.authorization?.replace('Bearer ', '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null
  const { data } = await admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle()
  return data?.is_active && ['super_admin', 'billing'].includes(data.role) ? data : null
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })
  try {
    const staff = await requirePlatformStaff(request)
    if (!staff) return response.status(403).json({ error: 'Not authorized' })
    const { restaurantId, priceId, successUrl, cancelUrl } = request.body || {}
    if (!restaurantId || !priceId) return response.status(400).json({ error: 'Restaurant and Stripe price are required' })
    const { data: subscription } = await admin.from('subscriptions').select('provider_customer_id').eq('restaurant_id', restaurantId).maybeSingle()
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: subscription?.provider_customer_id || undefined,
      customer_email: subscription?.provider_customer_id ? undefined : undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.VITE_APP_URL}/subscriptions?checkout=success`,
      cancel_url: cancelUrl || `${process.env.VITE_APP_URL}/subscriptions?checkout=canceled`,
      metadata: { restaurant_id: restaurantId, initiated_by: staff.id },
      subscription_data: { metadata: { restaurant_id: restaurantId } },
    })
    return response.status(200).json({ url: session.url })
  } catch {
    return response.status(500).json({ error: 'Could not create Stripe Checkout session' })
  }
}
