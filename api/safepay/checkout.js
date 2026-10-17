import { CURRENCY, resolvePlanPrice } from '../../shared/plans.js'
import { requireActor } from '../_lib/actor.js'
import { admin } from '../_lib/admin.js'
import { redirectBase } from '../_lib/origin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { ensureCustomer, openCardCapture } from '../_lib/safepay-billing.js'
import { safepayProblems } from '../_lib/safepay.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Starts a subscription: the owner saves a card on Safepay's own page, and the
// platform takes the first period itself the moment the card is on file.
//
// Why it is not simply "send them to Safepay's payment page", which is what this
// endpoint used to do: that page cannot complete a payment for this platform's
// customers. Every tracker it opens must carry the restaurant's merchant-managed
// customer — that is where the card has to live for renewals to work — and the
// checkout page refuses the payer-authentication enrolment step for exactly such a
// tracker with `401 this request requires merchant authentication`, because the
// page authenticates as a Safepay guest/user while the tracker demands merchant
// authentication. That was measured on the sandbox, request for request, against
// the payload the page itself sends. A tracker without the customer pays fine, but
// the card then lands in a Safepay guest the merchant cannot read, so renewals
// would have nothing to charge.
//
// What works — verified end to end on the sandbox — is the platform's original
// shape: the "add a card" page (a zero-amount verification, no account, no PCI
// scope here) stores the card against the restaurant's own customer, and `settle`
// then charges the first period with the same merchant-initiated charge that every
// renewal already uses. The customer experience is unchanged in substance: one
// hosted page, a card typed only at Safepay, nothing charged before they confirm
// there.
//
// The client still sends a restaurant and a plan — never an amount. Accepting one
// from the browser would let anyone with a session buy a subscription at a price
// of their choosing; resolving it here from the plan's rupee price means the amount
// charged is always the one on file.
//
// Every payment is still tracked twice over: the tracker id is stored on the
// subscription before the customer leaves this platform, and Safepay reports the
// outcome both on the return trip (`/api/safepay/settle`) and by webhook, with the
// first charge written down through the same `settle` as any other payment. The
// browser is never the source of truth for money.

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to start a subscription.' })

  // Opening a checkout creates a Safepay session and a customer, so a loop here is
  // a way to litter the account.
  if (!(await withinRateLimit(request, response, { route: 'safepay-checkout', max: 30, actorId: actor.id }))) return

  const problems = safepayProblems()
  if (problems.length) {
    return response.status(503).json({ error: `${problems.join(', ')} is not set for this deployment, so subscriptions cannot be started yet.` })
  }

  try {
    const requested = request.body || {}
    const planId = requested.planId
    // Staff may name any restaurant; a restaurant admin may only ever be the
    // restaurant they belong to, so the id they send is ignored in favour of their
    // membership rather than trusted.
    const restaurantId = actor.isStaff ? requested.restaurantId : actor.restaurantId

    if (!restaurantId) {
      return response.status(403).json({ error: 'This account is not attached to a restaurant, so it has nothing to subscribe.' })
    }
    if (!uuid.test(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })
    if (!uuid.test(planId || '')) return response.status(400).json({ error: 'Choose a plan to subscribe to.' })

    const [{ data: restaurant }, { data: plan }] = await Promise.all([
      admin.from('restaurants').select('id, name, subdomain, owner_email, phone, is_active').eq('id', restaurantId).maybeSingle(),
      admin.from('subscription_plans').select('*').eq('id', planId).maybeSingle(),
    ])
    if (!restaurant) return response.status(404).json({ error: 'That restaurant no longer exists.' })
    if (!plan) return response.status(404).json({ error: 'That plan no longer exists.' })
    if (!plan.is_active) return response.status(400).json({ error: `${plan.name} is deactivated and cannot be subscribed to.` })

    // One currency, resolved here from the plan rather than taken from the browser:
    // whatever a restaurant was onboarded as, the amount charged is the plan's rupee
    // price.
    const priced = resolvePlanPrice(plan, CURRENCY)
    if (!priced) return response.status(400).json({ error: `${plan.name} has no ${CURRENCY} price, so it cannot bill ${restaurant.name}. Add that price in Plans & pricing.` })

    const { data: existing } = await admin
      .from('subscriptions')
      .select('id, plan_id, status, provider, provider_customer_id, safepay_payment_method_id, safepay_tracker_id, current_period_end, trial_end, amount, currency')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    // A subscription row is what the customer id and the saved card hang off, so it
    // is created before the first checkout rather than after it — otherwise the card
    // a customer just saved would have nowhere to live.
    const row = existing || (await admin.from('subscriptions').insert({
      restaurant_id: restaurantId,
      provider: 'safepay',
      status: 'past_due',
      plan_id: plan.id,
      currency: priced.currency,
      amount: priced.amount,
    }).select('*').single()).data

    // Opening the card page is the intent to be billed again, so a subscription the
    // platform had closed stops being closed *before* the card is saved: with the
    // row still canceled, the charge that follows the save would find nothing due
    // and the owner would end up with a card on file that nothing could ever charge.
    if (row && (row.status === 'canceled' || row.status === 'suspended')) {
      await admin.from('subscriptions').update({
        status: 'past_due',
        cancel_at_period_end: false,
        canceled_at: null,
        updated_at: new Date().toISOString(),
      }).eq('restaurant_id', restaurantId)
    }

    const base = redirectBase(request)
    if (!base) {
      return response.status(503).json({ error: 'This request carried no origin and the deployment has no public base URL. Set VITE_CANONICAL_BASE_URL so Safepay knows where to return the customer.' })
    }

    const customerId = await ensureCustomer(admin, { restaurant, row })
    const opened = await openCardCapture(admin, {
      restaurant,
      customerId,
      base,
      actor,
      plan,
      amount: priced.amount,
      currency: priced.currency,
    })

    await admin.from('activity_logs').insert({
      super_admin_id: actor.isStaff ? actor.id : null,
      restaurant_id: restaurant.id,
      action: 'subscription.checkout_started',
      details: {
        plan_id: plan.id,
        plan: plan.name,
        currency: priced.currency,
        amount: priced.amount,
        tracker: opened.tracker,
        customer_id: customerId,
        flow: 'card-capture',
        started_by: actor.label,
      },
    })

    return response.status(200).json({
      url: opened.url,
      tracker: opened.tracker,
      currency: priced.currency,
      amount: priced.amount,
      planName: plan.name,
      flow: 'card-capture',
    })
  } catch (error) {
    console.error('[safepay/checkout] failed:', error)
    return response.status(500).json({ error: error?.message || 'Could not open Safepay Checkout.' })
  }
}
