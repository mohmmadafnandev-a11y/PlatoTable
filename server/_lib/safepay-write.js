// What Safepay told us, written down.
//
// The webhook is the only writer of a subscription's real state. Safepay is
// explicit that a redirect is UI feedback and can be missed, duplicated or
// forged, while a webhook is retried by them — so the money facts come from the
// event, never from the browser's return trip.
//
// The mapping is small and deliberately kept in one file:
//
//   Safepay            → the platform
//   pending            → past_due   (no money yet; the sweep's grace applies)
//   active             → active
//   payment_failed     → past_due   (access continues through the grace period)
//   cancelled          → canceled
//
// Nothing here converts currency. A Safepay charge is in rupees, the platform
// bills in rupees, and the ledger stores what was actually taken — a conversion
// would put a figure in the ledger that matches no bank statement.
//
// Every function is failure-tolerant in the same way the notification helper is:
// once the webhook has been accepted, a write that fails is logged and reported,
// never thrown back at Safepay as a reason to retry an event we already stored.

import { CURRENCY } from '../../shared/plans.js'

/** Safepay's vocabulary, mapped onto the platform's. */
export const statusForSafepay = (status) => ({
  active: 'active',
  trialing: 'trialing',
  pending: 'past_due',
  payment_failed: 'past_due',
  past_due: 'past_due',
  cancelled: 'canceled',
  canceled: 'canceled',
}[String(status || '').toLowerCase()] || 'past_due')

/**
 * A timestamp from whatever Safepay sent.
 *
 * Events have carried dates as ISO strings and as unix seconds across the API's
 * versions, and a null here is not cosmetic: a null period end is what makes the
 * billing sweep decide a restaurant is overdue. Both shapes are read, and an
 * unparseable value is null rather than "1970".
 */
export function isoDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' || /^\d{9,13}$/.test(String(value))) {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return null
    return new Date(number < 1e12 ? number * 1000 : number).toISOString()
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * The first key that is actually present, so a payload can carry either name.
 *
 * Safepay's own documentation has used `subscription_id` and `sub_id` for the
 * same field on different pages, and `reference` is ours.
 */
export const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '')

/**
 * Writes the subscription row from a Safepay subscription event.
 *
 * Keyed on the restaurant, because the platform's model is one subscription per
 * restaurant: a re-subscribe updates the row rather than growing a second one.
 * `trial_used_at` is stamped when a trial is actually running, which is what
 * stops a cancel-and-resubscribe from farming free weeks through the trial plan.
 */
export async function writeSafepaySubscription(admin, {
  restaurantId,
  subscriptionId,
  planId,
  status,
  currency,
  amount,
  trialStart,
  trialEnd,
  periodStart,
  periodEnd,
  cancelAtPeriodEnd,
  canceledAt,
  stampTrial = false,
}) {
  if (!restaurantId) return { error: 'no restaurant' }

  const record = {
    restaurant_id: restaurantId,
    provider: 'safepay',
    ...(subscriptionId ? { provider_subscription_id: subscriptionId } : {}),
    ...(planId ? { plan_id: planId } : {}),
    ...(status ? { status: statusForSafepay(status) } : {}),
    ...(currency ? { currency: String(currency).toUpperCase() } : {}),
    ...(amount !== undefined && amount !== null && Number.isFinite(Number(amount)) ? { amount: Number(amount) } : {}),
    ...(trialStart ? { trial_start: trialStart } : {}),
    ...(trialEnd ? { trial_end: trialEnd } : {}),
    ...(periodStart ? { current_period_start: periodStart } : {}),
    ...(periodEnd ? { current_period_end: periodEnd } : {}),
    ...(cancelAtPeriodEnd === undefined ? {} : { cancel_at_period_end: Boolean(cancelAtPeriodEnd) }),
    ...(canceledAt ? { canceled_at: canceledAt } : {}),
    ...(stampTrial ? { trial_used_at: new Date().toISOString() } : {}),
  }

  const { error } = await admin.from('subscriptions').upsert(record, { onConflict: 'restaurant_id' })
  if (error) console.error('[safepay-write] could not write the subscription:', error.message)
  return { error: error?.message || null }
}

/**
 * Records one settled (or failed) charge in the ledger both panels read.
 *
 * Keyed on Safepay's transaction id so the same charge cannot be counted twice:
 * a webhook retry, the return path and a manual sync all describe the same
 * money, and only the first of them creates the row.
 */
export async function recordSafepayPayment(admin, {
  restaurantId,
  subscriptionId,
  transactionId,
  amount,
  currency,
  status,
  invoiceUrl,
  cardBrand,
  cardLast4,
  paymentMethod,
}) {
  if (!restaurantId || !transactionId) return { error: null }
  const { error } = await admin.from('payment_transactions').upsert({
    restaurant_id: restaurantId,
    subscription_id: subscriptionId || null,
    provider: 'safepay',
    provider_transaction_id: String(transactionId),
    amount: Number(amount || 0),
    currency: String(currency || CURRENCY).toUpperCase(),
    status,
    invoice_url: invoiceUrl || null,
    // Which card paid, in the only form this application is ever allowed to hold:
    // the brand and the last four digits. Safepay never returns the full number
    // to a server that did not itself take the card, which is the whole reason
    // the card is entered on Safepay's page and not here.
    card_brand: cardBrand || null,
    card_last4: cardLast4 || null,
    payment_method: paymentMethod || (cardLast4 ? 'card' : null),
  }, { onConflict: 'provider_transaction_id' })
  if (error) console.error('[safepay-write] could not record the payment:', error.message)
  return { error: error?.message || null }
}
