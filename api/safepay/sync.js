import { admin } from '../_lib/admin.js'
import { requireActor } from '../_lib/actor.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { refreshSavedCard, settle } from '../_lib/safepay-billing.js'
import { safepayProblems } from '../_lib/safepay.js'
import { cancelDueSubscriptions } from './manage.js'

// Reconciles what the platform believes with what Safepay actually holds.
//
// A webhook and the return trip between them write every payment, but both can be
// missed: the return trip happens in a browser that may have been closed, and a
// webhook cannot be delivered to a deployment that is asleep, or to a laptop with no
// public address at all. This is the repair path for exactly those cases, and it is
// what the billing screen calls when it comes back from a checkout, so the row is
// right the moment the customer returns rather than whenever Safepay can reach us.
//
// It asks Safepay two questions and writes the answers down:
//
//   * what happened to the payment session this subscription is waiting on, and
//   * which card does this restaurant have on file right now — the one Safepay
//     accepted, not the one the browser claimed.
//
// It deliberately does not charge anything. A renewal is a money movement, and it
// belongs to the schedule (the billing sweep), not to whoever last pressed refresh.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value) => uuid.test(String(value || ''))

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to refresh a subscription.' })

  if (!(await withinRateLimit(request, response, { route: 'safepay-sync', max: 30, actorId: actor.id }))) return

  const problems = safepayProblems()
  if (problems.length) return response.status(503).json({ error: `${problems.join(', ')} is not set for this deployment.` })

  const requested = request.body?.restaurantId
  const restaurantId = actor.isStaff ? requested : actor.restaurantId
  if (!isUuid(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })

  try {
    const { data: row, error } = await admin.from('subscriptions').select('*').eq('restaurant_id', restaurantId).maybeSingle()
    if (error) throw error
    if (!row) return response.status(404).json({ error: 'That restaurant has no subscription yet.' })

    // Housekeeping runs for staff callers only: it is a platform-wide action, and a
    // restaurant's own "refresh this page" should not trigger it.
    const housekeeping = actor.isStaff ? await cancelDueSubscriptions(admin) : { cancelled: 0 }

    const result = row.safepay_tracker_id
      ? await settle(admin, row.safepay_tracker_id, { source: 'sync', actorId: actor.isStaff ? actor.id : null })
      : { settled: false, result: 'nothing-waiting' }

    if (row.provider_customer_id) {
      await refreshSavedCard(admin, { restaurantId, customerId: row.provider_customer_id }).catch((failure) => {
        console.error('[safepay/sync] could not read the saved card:', failure?.message)
      })
    }

    const { data: fresh } = await admin.from('subscriptions').select('*').eq('restaurant_id', restaurantId).maybeSingle()

    await admin.from('activity_logs').insert({
      super_admin_id: actor.isStaff ? actor.id : null,
      restaurant_id: restaurantId,
      action: 'subscription.refreshed',
      details: { tracker: row.safepay_tracker_id, outcome: result.result, by: actor.label },
    })

    return response.status(200).json({
      synced: true,
      settled: result.settled,
      outcome: result.result,
      tracker: row.safepay_tracker_id || null,
      subscription: fresh || row,
      housekeeping,
    })
  } catch (error) {
    console.error('[safepay/sync] failed:', error)
    return response.status(500).json({ error: error?.message || 'The subscription could not be refreshed.' })
  }
}
