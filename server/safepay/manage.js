import { admin } from '../_lib/admin.js'
import { requireActor } from '../_lib/actor.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { deletePaymentMethod } from '../_lib/safepay.js'

// Changing a subscription the platform is billing itself.
//
// There is no Safepay subscription object to call any more: the platform opens a
// tracker for each period and charges the saved card for each renewal, so every
// action here is a decision recorded on the platform's own row.
//
//   * `cancel`      stops the renewal — the current paid period runs to its end and
//                   nothing more is charged. Access is not cut off mid-period, and
//                   the billing sweep is what finally marks it cancelled once the
//                   period it paid for is over.
//   * `autoRenew`   switches the next charge off and back on. Turning it back on
//                   needs a card on file, because a renewal with nothing to charge
//                   would simply fail at the end of the period.
//   * `removeCard`  forgets the card on Safepay's side and here, which is the
//                   honest answer to "stop charging my card" for a restaurant that
//                   intends to leave — and it is also what a test of the failed-card
//                   path needs.
//
// Both scopes are enforced the same way everywhere: a restaurant admin cannot name
// a restaurant, and a staff member can only act on a restaurant that has a
// subscription.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Marks a subscription as no longer renewing.
 *
 * `atPeriodEnd` is returned rather than assumed: an owner whose period still has
 * days left keeps them, and the caller's confirmation text should say so.
 */
export async function cancelSubscriptionNow(admin, row, { reason = 'cancelled from the platform', actorId = null } = {}) {
  const covered = row.current_period_end && new Date(row.current_period_end).getTime() > Date.now()
  const atPeriodEnd = Boolean(covered) && ['active', 'trialing', 'past_due'].includes(row.status)

  await admin.from('subscriptions').update({
    // `cancel_at_period_end` is what the renewal engine reads before it charges
    // anything, so setting it is what actually stops the money.
    cancel_at_period_end: atPeriodEnd,
    ...(atPeriodEnd ? {} : { status: 'canceled', canceled_at: new Date().toISOString() }),
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', row.restaurant_id)

  await admin.from('activity_logs').insert({
    super_admin_id: actorId,
    restaurant_id: row.restaurant_id,
    action: atPeriodEnd ? 'subscription.renewal_cancelled' : 'subscription.cancelled_on_platform',
    details: {
      reason,
      at_period_end: atPeriodEnd,
      ends_at: atPeriodEnd ? row.current_period_end : null,
      card: row.card_last4 ? `${row.card_brand || 'card'} ${row.card_last4}` : null,
    },
  })

  return { canceled: true, atPeriodEnd, endsAt: atPeriodEnd ? row.current_period_end : null }
}

/**
 * Stops the subscriptions whose paid period has ended and whose renewal was
 * switched off.
 *
 * This is the last step of a cancellation: the owner decided not to renew, the days
 * they paid for have run out, and the row stops claiming to be active. It runs from
 * the billing sweep, which a schedule calls, and from a manual sync — so a quiet week
 * cannot leave a cancelled subscription looking alive.
 */
export async function cancelDueSubscriptions(admin, { limit = 25 } = {}) {
  const now = new Date().toISOString()
  const { data: due, error } = await admin
    .from('subscriptions')
    .select('id, restaurant_id, status, cancel_at_period_end, current_period_end')
    .eq('provider', 'safepay')
    .eq('cancel_at_period_end', true)
    .in('status', ['active', 'trialing', 'past_due'])
    .lte('current_period_end', now)
    .limit(limit)

  if (error) {
    console.error('[safepay/manage] could not read due cancellations:', error.message)
    return { cancelled: 0, error: error.message }
  }

  let cancelled = 0
  for (const row of due || []) {
    const result = await cancelSubscriptionNow(admin, row, { reason: 'renewal was switched off and the paid period ended' })
    if (result.canceled) cancelled += 1
  }
  return { cancelled, considered: (due || []).length }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor) return response.status(403).json({ error: 'Sign in to manage a subscription.' })

  if (!(await withinRateLimit(request, response, { route: 'safepay-manage', max: 30, actorId: actor.id }))) return

  const { action, restaurantId: requested, on } = request.body || {}
  const restaurantId = actor.isStaff ? requested : actor.restaurantId
  if (!restaurantId || !uuid.test(restaurantId)) return response.status(400).json({ error: 'A valid restaurant is required.' })

  const { data: row } = await admin
    .from('subscriptions')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (!row) return response.status(404).json({ error: 'That restaurant has no subscription yet.' })

  try {
    if (action === 'cancel') {
      if (row.status === 'canceled' && !row.cancel_at_period_end) return response.status(200).json({ canceled: true, alreadyCanceled: true })
      const result = await cancelSubscriptionNow(admin, row, { reason: `cancelled by ${actor.label}`, actorId: actor.isStaff ? actor.id : null })
      return response.status(200).json(result)
    }

    if (action === 'autoRenew') {
      const enabled = on !== false
      if (enabled && !row.safepay_card_pointer) {
        return response.status(409).json({ error: 'There is no card on file to renew with. Add a payment method first.' })
      }
      if (!['active', 'trialing', 'past_due'].includes(row.status)) {
        return response.status(409).json({ error: 'Only a running subscription has a renewal to switch.' })
      }

      await admin.from('subscriptions').update({
        cancel_at_period_end: !enabled,
        updated_at: new Date().toISOString(),
      }).eq('restaurant_id', restaurantId)

      await admin.from('activity_logs').insert({
        super_admin_id: actor.isStaff ? actor.id : null,
        restaurant_id: restaurantId,
        action: enabled ? 'subscription.renewal_enabled' : 'subscription.renewal_disabled',
        details: { by: actor.label, current_period_end: row.current_period_end },
      })
      return response.status(200).json({ autoRenew: enabled, cancelAtPeriodEnd: !enabled })
    }

    if (action === 'removeCard') {
      if (!row.safepay_payment_method_id) return response.status(409).json({ error: 'This restaurant has no card on file.' })
      // Safepay is asked first, and a refusal is reported: the card must actually be
      // gone from their side, or the platform would keep a token that still works.
      const removed = await deletePaymentMethod(row.provider_customer_id, row.safepay_payment_method_id)
      if (!removed.deleted) {
        return response.status(502).json({ error: `Safepay refused to remove the card: ${removed.error || 'unknown reason'}` })
      }

      await admin.from('subscriptions').update({
        safepay_payment_method_id: null,
        safepay_card_pointer: null,
        card_brand: null,
        card_last4: null,
        card_exp_month: null,
        card_exp_year: null,
        // Nothing to charge at the end of the period any more, so renewals stop
        // rather than failing silently.
        cancel_at_period_end: true,
        updated_at: new Date().toISOString(),
      }).eq('restaurant_id', restaurantId)

      await admin.from('activity_logs').insert({
        super_admin_id: actor.isStaff ? actor.id : null,
        restaurant_id: restaurantId,
        action: 'payment_method.removed',
        details: { card: row.card_last4 ? `${row.card_brand || 'card'} ${row.card_last4}` : null, by: actor.label },
      })
      return response.status(200).json({ removed: true })
    }

    return response.status(400).json({ error: `Unknown action "${action}".` })
  } catch (error) {
    console.error('[safepay/manage] failed:', error)
    return response.status(500).json({ error: error?.message || 'The subscription could not be changed.' })
  }
}
