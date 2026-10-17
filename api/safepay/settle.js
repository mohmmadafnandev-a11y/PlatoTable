import { requireActor } from '../_lib/actor.js'
import { admin } from '../_lib/admin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { settle, subscriptionForTracker } from '../_lib/safepay-billing.js'
import { safepayProblems } from '../_lib/safepay.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// What happened to the payment we just sent someone to make.
//
// Safepay's hosted page returns the customer to the platform with `tracker=track_…`
// on the URL, and this reads that session back from Safepay rather than believing
// anything the browser reports: the state, the settled charge, the card. A webhook
// usually arrives too, and both paths write the same facts in the same place
// (`settle` in _lib/safepay-billing.js), so whichever lands first wins and the other
// is a no-op.
//
// It exists because a webhook cannot be relied on to arrive at all — no endpoint
// registered yet, a deployment asleep, a sandbox with no public URL — and a customer
// who has just paid must see their subscription active immediately, not "within five
// minutes if Safepay can reach us".

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to check a payment.' })

  if (!(await withinRateLimit(request, response, { route: 'safepay-settle', max: 60, actorId: actor.id }))) return

  const problems = safepayProblems()
  if (problems.length) return response.status(503).json({ error: `${problems.join(', ')} is not set for this deployment.` })

  const body = request.body || {}
  const restaurantId = actor.isStaff ? body.restaurantId : actor.restaurantId
  let trackerId = String(body.tracker || '').trim()

  try {
    // No tracker on the request: settle whatever this restaurant is waiting on, which
    // is what a reload of the billing screen does.
    if (!trackerId) {
      if (!restaurantId || !uuid.test(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })
      const { data: row } = await admin.from('subscriptions').select('safepay_tracker_id').eq('restaurant_id', restaurantId).maybeSingle()
      trackerId = row?.safepay_tracker_id || ''
      if (!trackerId) return response.status(200).json({ settled: false, result: 'nothing-waiting' })
    } else {
      // A tracker named by the caller must belong to the caller's restaurant, or a
      // restaurant admin could settle somebody else's payment into their own row.
      const row = await subscriptionForTracker(admin, trackerId, null)
      if (!row) return response.status(404).json({ error: 'That payment does not belong to any subscription.' })
      if (!actor.isStaff && row.restaurant_id !== actor.restaurantId) {
        return response.status(403).json({ error: 'That payment belongs to another restaurant.' })
      }
    }

    const result = await settle(admin, trackerId, { source: 'return', actorId: actor.isStaff ? actor.id : null })
    const restaurant = result.subscription?.restaurant_id || restaurantId
    const { data: fresh } = restaurant
      ? await admin.from('subscriptions').select('*').eq('restaurant_id', restaurant).maybeSingle()
      : { data: null }

    return response.status(200).json({
      settled: result.settled,
      result: result.result,
      state: result.state || null,
      charge: result.charge || null,
      // Present when a card save was followed by the first period's charge: the
      // screen says what actually happened to the money, not just that a card
      // was accepted.
      first_charge: result.first_charge || null,
      subscription: fresh || result.subscription || null,
    })
  } catch (error) {
    console.error('[safepay/settle] failed:', error)
    return response.status(500).json({ error: error?.message || 'The payment could not be checked.' })
  }
}
