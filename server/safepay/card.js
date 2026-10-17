import { requireActor } from '../_lib/actor.js'
import { admin } from '../_lib/admin.js'
import { redirectBase } from '../_lib/origin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { ensureCustomer, openCardCapture } from '../_lib/safepay-billing.js'
import { safepayProblems } from '../_lib/safepay.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Adding or replacing the card a restaurant pays with.
//
// This is Safepay's own "add a card" page: a zero-amount verification that
// authorises and reverses Rs 0.00 and leaves the card in the restaurant's
// merchant-managed customer. It is a different session from a payment
// (`mode: instrument` rather than `mode: payment`) because it must not move money —
// the customer asked to update a card, not to be charged for a period.
//
// The card is typed on Safepay's page and never reaches this server, which is why
// the platform holds no card field of its own and needs no PCI certificate: it
// receives a token, a brand and four digits, and nothing else.
//
// A card saved here is what a renewal is charged against, so this is also the answer
// to "my renewal failed".

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to add a payment method.' })

  // Each call creates a Safepay customer and a session, so it is rate limited like
  // the checkout it belongs beside.
  if (!(await withinRateLimit(request, response, { route: 'safepay-card', max: 30, actorId: actor.id }))) return

  const problems = safepayProblems()
  if (problems.length) {
    return response.status(503).json({ error: `${problems.join(', ')} is not set for this deployment, so a card cannot be saved yet.` })
  }

  const restaurantId = actor.isStaff ? request.body?.restaurantId : actor.restaurantId
  if (!restaurantId || !uuid.test(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })

  try {
    const { data: restaurant } = await admin
      .from('restaurants')
      .select('id, name, subdomain, owner_email, phone')
      .eq('id', restaurantId)
      .maybeSingle()
    if (!restaurant) return response.status(404).json({ error: 'That restaurant no longer exists.' })

    const { data: existing } = await admin.from('subscriptions').select('*').eq('restaurant_id', restaurantId).maybeSingle()
    // The customer id and the saved card hang off the subscription row, so a
    // restaurant that has never had one gets an empty row rather than an error: the
    // point of saving a card is that a subscription is about to exist.
    const row = existing || (await admin.from('subscriptions').insert({
      restaurant_id: restaurantId,
      provider: 'safepay',
      status: 'past_due',
    }).select('*').single()).data

    const base = redirectBase(request)
    if (!base) {
      return response.status(503).json({ error: 'This request carried no origin and the deployment has no public base URL. Set VITE_CANONICAL_BASE_URL so Safepay knows where to return the customer.' })
    }

    const customerId = await ensureCustomer(admin, { restaurant, row })
    const opened = await openCardCapture(admin, { restaurant, customerId, base, actor })

    await admin.from('activity_logs').insert({
      super_admin_id: actor.isStaff ? actor.id : null,
      restaurant_id: restaurant.id,
      action: 'payment_method.add_started',
      details: {
        tracker: opened.tracker,
        customer_id: customerId,
        // Replacing a card and adding the first one read very differently in an
        // audit, and the row already knows which this is.
        replacing: Boolean(row.safepay_payment_method_id),
        started_by: actor.label,
      },
    })

    return response.status(200).json({ url: opened.url, tracker: opened.tracker, customerId })
  } catch (error) {
    console.error('[safepay/card] failed:', error)
    return response.status(500).json({ error: error?.message || 'Could not open Safepay Checkout.' })
  }
}
