// The subscription lifecycle, written once.
//
// Safepay's Subscriptions product cannot be used by this platform: it has no
// create API ("Subscriptions cannot be created using APIs since a customer has to
// subscribe to a plan") and its hosted checkout puts every shopper through
// Safepay's own account login, so a restaurant owner would have to sign up with
// Safepay before they could pay us. See `_lib/safepay.js` for the measurements.
//
// What replaces it is a small amount of bookkeeping this module owns:
//
//   openCardCapture()  the hosted "add a card" page: a zero-amount verification
//                      that stores the card in the restaurant's own customer.
//                      This is where a subscription starts now — see below.
//   settle()           read the tracker back from Safepay and write what happened:
//                      the period, the ledger row, the notifications, the card,
//                      and (after a card save that leaves money owed) the first
//                      merchant-initiated charge.
//   charge()           one period's money, taken against the card on file with
//                      nobody at the keyboard — used for the first charge and
//                      every renewal.
//   openPayment()      the hosted *payment* page. Kept for the record, but it
//                      cannot bill a restaurant: its enrolment step refuses a
//                      tracker that carries the merchant-managed customer with
//                      401 "this request requires merchant authentication"
//                      (measured on the sandbox). Do not re-wire checkout onto it.
//
// Three rules hold everywhere here, and they are the same rules the Stripe era
// had: the browser never names an amount, Safepay is the only source of truth for
// money, and every write is idempotent because a webhook, a return trip and a
// manual refresh all describe the same payment.
//
// The restaurant's customer is the one piece of Safepay state this platform owns.
// It is created on demand (`provider_customer_id`) and holds the saved card; the
// card's tokens are restricted to this merchant by Safepay, which is exactly the
// scope wanted for a restaurant paying a menu platform.

import { CURRENCY, planDurationDays } from '../../shared/plans.js'
import { recordPaymentNotifications } from './billing-notify.js'
import {
  chargeSavedCard,
  createCustomer,
  createInstrumentTracker,
  createPaymentTracker,
  cardFromTracker,
  chargeFromTracker,
  hostedCheckoutUrl,
  listPaymentMethods,
  readTracker,
  trackerOpen,
  trackerPaid,
} from './safepay.js'
import { isoDate, pick, recordSafepayPayment } from './safepay-write.js'

const day = 86_400_000

/** The plan's period, counted from the moment a charge settles. */
export function periodEndFrom(plan, from = new Date()) {
  const days = Number(plan?.duration_days) || planDurationDays(plan?.interval, plan?.interval_count)
  return new Date(from.getTime() + Math.max(1, days) * day).toISOString()
}

/**
 * When this subscription is next owed money, or null when nothing is owed.
 *
 * One rule, shared by the renewal run and by the charge that follows a card
 * being saved, so the two can never disagree:
 *
 *   * a trial is due at its trial end — the days were promised free, and the
 *     first charge belongs at the edge of them, not before;
 *   * a paid subscription is due at its period end;
 *   * a row that has a past_due status and has never had a period is due
 *     immediately: it exists because someone started a subscription and the
 *     money has not been taken yet.
 */
export function subscriptionDueAt(row) {
  if (!row) return null
  if (row.status === 'trialing') return row.trial_end ? new Date(row.trial_end).getTime() : null
  if (row.current_period_end) return new Date(row.current_period_end).getTime()
  return row.status === 'past_due' ? 0 : null
}

/** True when money is owed right now. */
export const paymentIsDue = (row, now = Date.now()) => {
  const due = subscriptionDueAt(row)
  return due !== null && due <= now
}

/** `transactionId` for the ledger: Safepay's charge id, or the tracker when there is none. */
const chargeId = (payment, trackerId) =>
  String(pick(chargeFromTracker(payment)?.id, payment?.charge?.token, trackerId))

/**
 * The restaurant's Safepay customer, created the first time it is needed.
 *
 * Held on the subscription row rather than derived, because a customer carries the
 * saved card: creating a second one would leave the card on file behind and make
 * the platform ask for a card it already has.
 */
export async function ensureCustomer(admin, { restaurant, row }) {
  if (row?.provider_customer_id) return row.provider_customer_id

  const { customerId } = await createCustomer({
    name: restaurant.name,
    email: restaurant.owner_email,
    phone: restaurant.phone,
  })

  await admin.from('subscriptions').update({
    provider_customer_id: customerId,
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', restaurant.id)

  return customerId
}

/**
 * Where a hosted checkout should return the customer.
 *
 * The caller's own host wins over the configured base, so a checkout started on
 * localhost comes back to localhost; and a restaurant admin lands back on their
 * own billing screen rather than the platform's subscription list.
 */
export function returnUrlFor({ base, actor, restaurant }) {
  const path = actor?.isStaff ? '/admin/subscriptions' : `/admin/${restaurant.subdomain}/subscription`
  return {
    redirect: `${base}${path}?checkout=success&restaurant=${restaurant.id}`,
    cancel: `${base}${path}?checkout=canceled&restaurant=${restaurant.id}`,
    path,
  }
}

/**
 * Opens the payment page for one period of a plan.
 *
 * NOT used to start a subscription any more, and not safe to re-enable without
 * reading this: the hosted payment page refuses the enrolment step for a tracker
 * that carries the restaurant's merchant-managed customer — the same tracker the
 * card must be saved against for renewals — answering
 * `401 this request requires merchant authentication` (reproduced on the sandbox
 * against the exact payload the checkout page sends). The platform takes the
 * first period itself after the card is saved instead: see openCardCapture and
 * the first-charge block in settle().
 *
 * The amount is the plan's rupee price, resolved by the caller from the row — never
 * a figure the browser sent. The tracker is recorded on the subscription before the
 * customer is sent anywhere, so a return trip, a webhook or a reload can all find
 * the same attempt.
 */
export async function openPayment(admin, { restaurant, row, plan, customerId, amount, currency = CURRENCY, base, actor }) {
  const { tracker, totals } = await createPaymentTracker({
    customerId,
    amount,
    currency,
    reference: restaurant.id,
  })

  const urls = returnUrlFor({ base, actor, restaurant })
  const url = await hostedCheckoutUrl({ tracker, customerId, redirectUrl: urls.redirect, cancelUrl: urls.cancel })

  // 'past_due' is the honest status: no money has moved yet. The settle path (or
  // the webhook) replaces it the moment Safepay says otherwise.
  const record = {
    plan_id: plan?.id || row?.plan_id || null,
    provider: 'safepay',
    provider_customer_id: customerId,
    safepay_tracker_id: tracker,
    amount,
    currency: String(currency).toUpperCase(),
    updated_at: new Date().toISOString(),
  }
  if (row) await admin.from('subscriptions').update(record).eq('restaurant_id', restaurant.id)
  else await admin.from('subscriptions').insert({ restaurant_id: restaurant.id, status: 'past_due', ...record })

  return { url, tracker, amount, currency: record.currency, totals }
}

/**
 * Opens the "add a card" page: a zero-amount verification that stores the card.
 *
 * This is how the platform starts a subscription now. The hosted *payment* page
 * cannot be used for a restaurant's first period: every tracker it would open
 * carries the merchant-managed customer that holds the card, and Safepay's
 * checkout page refuses the enrolment step for exactly that tracker with
 * `401 this request requires merchant authentication` (measured on the sandbox —
 * the page authenticates as a Safepay guest/user while the tracker demands
 * merchant authentication). The card is saved here instead, and the first period
 * is taken immediately afterwards by `charge()` — the same merchant-initiated
 * path every renewal already uses.
 *
 * `plan` and `amount` are recorded when the caller knows what the card is being
 * saved *for*, so the charge that follows settles against the right plan. A card
 * added only to repair a renewal leaves both exactly as they were.
 */
export async function openCardCapture(admin, { restaurant, customerId, base, actor, plan = null, amount = null, currency = null }) {
  const { tracker } = await createInstrumentTracker({ customerId, reference: restaurant.id })
  const urls = returnUrlFor({ base, actor, restaurant })
  const url = await hostedCheckoutUrl({ tracker, customerId, redirectUrl: urls.redirect, cancelUrl: urls.cancel })

  await admin.from('subscriptions').update({
    provider: 'safepay',
    provider_customer_id: customerId,
    safepay_tracker_id: tracker,
    ...(plan?.id ? { plan_id: plan.id } : {}),
    ...(amount !== null && Number.isFinite(Number(amount)) ? { amount: Number(amount) } : {}),
    ...(currency ? { currency: String(currency).toUpperCase() } : {}),
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', restaurant.id)

  return { url, tracker }
}

/** The row a tracker belongs to: by its stored tracker id, or by the reference it carried. */
export async function subscriptionForTracker(admin, trackerId, payment) {
  if (trackerId) {
    const { data } = await admin.from('subscriptions').select('*').eq('safepay_tracker_id', trackerId).maybeSingle()
    if (data) return data
  }
  // The reference the platform sends is the restaurant id, and it comes back on the
  // payment as `order_id`. The reporter wraps it in an object (`{ value: ... }`),
  // which is why both shapes are read.
  const reference = pick(payment?.metadata?.order_id?.value, payment?.metadata?.order_id, payment?.reference)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(reference || ''))) {
    const { data } = await admin.from('subscriptions').select('*').eq('restaurant_id', String(reference)).maybeSingle()
    if (data) return data
  }
  return null
}

/**
 * Reads the card Safepay holds for this restaurant and writes it down.
 *
 * Called after any tracker settles, because a `payment` tracker saves the card only
 * when the customer ticked "save my card", and an `instrument` tracker saves it
 * always — and neither tells us anything except through the wallet. Only the brand,
 * the last four and the expiry are stored, plus the two tokens a later charge needs.
 */
export async function refreshSavedCard(admin, { restaurantId, customerId, payment = null }) {
  const cards = await listPaymentMethods(customerId)
  const fromTracker = payment ? cardFromTracker(payment) : {}
  // Prefer the card that actually paid, when the customer holds more than one.
  const chosen = (fromTracker.last4 && cards.find((card) => card.last4 === fromTracker.last4)) || cards[0] || null
  if (!chosen) return null

  await admin.from('subscriptions').update({
    safepay_payment_method_id: chosen.token,
    safepay_card_pointer: chosen.pointer || fromTracker.pointer || null,
    card_brand: fromTracker.brand || chosen.brand || null,
    card_last4: chosen.last4 || fromTracker.last4 || null,
    card_exp_month: chosen.expMonth || null,
    card_exp_year: chosen.expYear || null,
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', restaurantId)

  return chosen
}

/**
 * Writes down what a tracker ended up doing.
 *
 * This is the single place a payment becomes a period, whether we learned about it
 * from the return trip, from a webhook, from a manual refresh, or from the
 * platform's own renewal charge. Every branch is safe to run twice: the ledger is
 * keyed on Safepay's charge id, the notifications on the tracker, and the period is
 * a function of "now" rather than of what the row already held.
 */
export async function settle(admin, trackerId, { source = 'return', actorId = null } = {}) {
  const payment = await readTracker(trackerId)
  if (!payment) return { settled: false, result: 'unknown' }

  const row = await subscriptionForTracker(admin, trackerId, payment)
  if (!row) {
    console.warn('[safepay-billing] a settled tracker matches no subscription:', trackerId)
    return { settled: false, result: 'no-match' }
  }

  const { data: restaurant } = await admin.from('restaurants').select('id, name, subdomain, is_active').eq('id', row.restaurant_id).maybeSingle()
  const { data: plan } = row.plan_id
    ? await admin.from('subscription_plans').select('*').eq('id', row.plan_id).maybeSingle()
    : { data: null }

  // Still waiting on the customer: nothing to write, and the row keeps the plan it
  // was sent to pay for.
  if (trackerOpen(payment)) return { settled: false, result: 'pending', state: payment.state }

  const card = cardFromTracker(payment)
  const chargeRecord = chargeFromTracker(payment)

  // A tracker that ended means one of three things, and telling them apart is what
  // decides whether money moved:
  //
  //   * a settled charge            -> a payment; the amount comes from the charge.
  //   * no charge object on a       -> the card-capture verification: the card was
  //     zero-amount tracker             stored and no money moved. Safepay reports
  //     (mode `instrument`)             *no* charge at all for these — measured —
  //                                     so the zero has to be read from the
  //                                     tracker's own totals, not from a charge
  //                                     that never materialises. Reading it from
  //                                     the charge is why a saved card used to
  //                                     fall into "unsettled" and never reach the
  //                                     subscription row.
  //   * no charge, non-zero         -> a refused or abandoned attempt: nothing was
  //     tracker                         taken, and the row must stop pretending.
  const trackerMinor = Number(payment?.purchase_totals?.quote_amount?.amount ?? NaN)
  const zeroAmountTracker = Number.isFinite(trackerMinor) && trackerMinor <= 0
  const chargeAmount = chargeRecord?.amount === undefined || chargeRecord?.amount === null ? null : Number(chargeRecord.amount)
  const isVerification = chargeAmount === null ? zeroAmountTracker : chargeAmount <= 0

  if (trackerPaid(payment) && (isVerification || chargeAmount > 0)) {
    const amount = isVerification ? 0 : chargeAmount
    const currency = String(chargeRecord?.currency || row.currency || CURRENCY).toUpperCase()
    const paidAt = chargeRecord?.captured ? new Date(chargeRecord.captured) : new Date()
    const transactionId = chargeId(payment, trackerId)
    // Paying while a period is still running buys the *next* period, not a new one
    // starting today: the days already paid for are never thrown away, which is what
    // an owner renewing a week early would otherwise lose. A trial counts as covered
    // time too, so converting mid-trial does not cost the owner the days they were
    // promised for free.
    const coveredUntil = row.status === 'trialing' && row.trial_end ? row.trial_end : row.current_period_end
    const covered = coveredUntil && new Date(coveredUntil).getTime() > paidAt.getTime()
    const periodStart = covered ? new Date(coveredUntil) : paidAt

    await admin.from('subscriptions').update({
      status: isVerification ? (row.status === 'canceled' ? 'canceled' : row.status || 'past_due') : 'active',
      amount: isVerification ? row.amount : amount,
      currency: isVerification ? row.currency : currency,
      last_payment_status: isVerification ? row.last_payment_status : 'paid',
      current_period_start: isVerification ? row.current_period_start : periodStart.toISOString(),
      current_period_end: isVerification ? row.current_period_end : periodEndFrom(plan, periodStart),
      cancel_at_period_end: isVerification ? row.cancel_at_period_end : false,
      canceled_at: isVerification ? row.canceled_at : null,
      last_charge_at: isVerification ? row.last_charge_at : paidAt.toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('restaurant_id', row.restaurant_id)

    if (!isVerification) {
      await recordSafepayPayment(admin, {
        restaurantId: row.restaurant_id,
        subscriptionId: row.id,
        transactionId,
        amount,
        currency,
        status: 'succeeded',
        cardBrand: card.brand,
        cardLast4: card.last4,
        paymentMethod: card.last4 ? 'card' : null,
      })

      await recordPaymentNotifications(admin, {
        restaurantId: row.restaurant_id,
        restaurantName: restaurant?.name,
        planName: plan?.name,
        succeeded: true,
        amount,
        currency,
        // Keyed on the charge, so the webhook, the return trip and a manual refresh
        // collapse into one notification pair.
        dedupeKey: `safepay-charge:${transactionId}`,
        source,
      })

      // The money moved, so a restaurant the billing sweep had taken offline comes
      // back. The sweep's own notice tells the owner to renew to restore the menu,
      // and this is what makes that sentence true — otherwise a paid restaurant's
      // public page and QR menus stayed unavailable until a staff member noticed
      // and flipped the switch by hand.
      if (row.status === 'suspended' || restaurant?.is_active === false) {
        await admin.from('restaurants').update({ is_active: true, updated_at: new Date().toISOString() }).eq('id', row.restaurant_id)
      }
    }

    await refreshSavedCard(admin, {
      restaurantId: row.restaurant_id,
      customerId: pick(row.provider_customer_id, payment.customer?.token),
      payment,
    })

    // A card that has just been saved is what turns "wants to subscribe" into
    // "can be charged", so the first period is taken the same way every later one
    // is: a merchant-initiated charge against the card on file. Safepay's hosted
    // payment page cannot do this for this customer (see openCardCapture), and a
    // subscription that only *looks* subscribed — card saved, nothing charged —
    // would leave the restaurant in grace the moment the clock noticed.
    //
    // The guard is the due-date rule every billing job shares, plus a short
    // window after an attempt: the return trip and a webhook describe the same
    // card save, and the second of them must be a no-op, not a second charge.
    let firstCharge = null
    if (isVerification) {
      const { data: carded } = await admin.from('subscriptions').select('*').eq('restaurant_id', row.restaurant_id).maybeSingle()
      const owed = Number(carded?.amount) || Number(plan?.price_pkr) || 0
      const attemptedAt = carded?.renewal_attempted_at ? new Date(carded.renewal_attempted_at).getTime() : 0
      const recentlyAttempted = attemptedAt && Date.now() - attemptedAt < 10 * 60_000
      if (carded?.safepay_card_pointer && !carded.cancel_at_period_end && owed > 0 && paymentIsDue(carded) && !recentlyAttempted) {
        const attempted = await charge(admin, carded, { plan, amount: owed, source: 'first-payment', actorId })
        firstCharge = { charged: Boolean(attempted.charged), reason: attempted.reason || null, tracker: attempted.tracker || null }
      }
    }

    await admin.from('activity_logs').insert({
      super_admin_id: actorId,
      restaurant_id: row.restaurant_id,
      action: isVerification ? 'payment_method.saved' : 'subscription.payment_recorded',
      details: {
        tracker: trackerId,
        charge: chargeRecord?.id || null,
        amount: isVerification ? (firstCharge?.charged ? Number(row.amount) || null : 0) : amount,
        currency,
        card: card.last4 ? `${card.brand || 'card'} ${card.last4}` : null,
        source,
        first_charge: firstCharge,
      },
    })

    const { data: fresh } = await admin.from('subscriptions').select('*').eq('restaurant_id', row.restaurant_id).maybeSingle()
    return {
      settled: true,
      result: isVerification ? (firstCharge?.charged ? 'paid' : 'card-saved') : 'paid',
      first_charge: firstCharge,
      subscription: fresh,
      charge: chargeRecord?.id || null,
    }
  }

  // The tracker ended without a settled charge: a card the issuer refused, or a
  // session the customer abandoned after an attempt. Access is not taken away —
  // the sweep's grace period decides that — but the row must stop pretending a
  // payment is on its way.
  await admin.from('subscriptions').update({
    status: row.status === 'canceled' ? 'canceled' : 'past_due',
    last_payment_status: row.last_payment_status === 'paid' ? 'paid' : 'failed',
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', row.restaurant_id)

  await admin.from('activity_logs').insert({
    super_admin_id: actorId,
    restaurant_id: row.restaurant_id,
    action: 'subscription.payment_unsettled',
    details: { tracker: trackerId, state: payment.state, source },
  })

  return { settled: false, result: 'unsettled', state: payment.state }
}

/**
 * Charges the saved card for the next period — the renewal itself.
 *
 * Nobody is at the keyboard, so this is the one path where a failure is not
 * something a customer can retry on the spot: it is recorded, notified, and left for
 * the sweep's grace period. The attempt is stamped on the row first, so a failing
 * card cannot be charged again on every pass of the schedule.
 */
export async function charge(admin, row, { plan, amount, source = 'renewal', actorId = null } = {}) {
  const customerId = row.provider_customer_id
  const pointer = row.safepay_card_pointer
  const chargeAmount = Number(amount ?? row.amount) || Number(plan?.price_pkr) || 0

  if (!customerId || !pointer) {
    return { charged: false, reason: 'no saved card' }
  }
  if (!(chargeAmount > 0)) {
    return { charged: false, reason: 'no amount' }
  }

  await admin.from('subscriptions').update({
    renewal_attempted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('restaurant_id', row.restaurant_id)

  let tracker
  try {
    const attempt = await chargeSavedCard({
      customerId,
      amount: chargeAmount,
      currency: row.currency || CURRENCY,
      pointer,
      reference: row.restaurant_id,
    })
    tracker = attempt.tracker
  } catch (error) {
    tracker = error?.tracker || null
    const reason = error?.message || String(error)
    const { data: restaurant } = await admin.from('restaurants').select('name').eq('id', row.restaurant_id).maybeSingle()

    await admin.from('subscriptions').update({
      status: 'past_due',
      last_payment_status: 'failed',
      ...(tracker ? { safepay_tracker_id: tracker } : {}),
      updated_at: new Date().toISOString(),
    }).eq('restaurant_id', row.restaurant_id)

    await recordSafepayPayment(admin, {
      restaurantId: row.restaurant_id,
      subscriptionId: row.id,
      transactionId: tracker || `failed:${row.restaurant_id}:${new Date().toISOString()}`,
      amount: chargeAmount,
      currency: row.currency || CURRENCY,
      status: 'failed',
      cardBrand: row.card_brand,
      cardLast4: row.card_last4,
      paymentMethod: row.card_last4 ? 'card' : null,
    })

    await recordPaymentNotifications(admin, {
      restaurantId: row.restaurant_id,
      restaurantName: restaurant?.name,
      planName: plan?.name,
      succeeded: false,
      amount: chargeAmount,
      currency: row.currency || CURRENCY,
      dedupeKey: `safepay-charge:${tracker || `${row.restaurant_id}:${new Date().toISOString().slice(0, 16)}`}`,
      source,
    })

    await admin.from('activity_logs').insert({
      super_admin_id: actorId,
      restaurant_id: row.restaurant_id,
      action: 'subscription.renewal_failed',
      details: { tracker, reason, card: row.card_last4 ? `${row.card_brand || 'card'} ${row.card_last4}` : null },
    })

    return { charged: false, reason, tracker }
  }

  // The charge went through: settle it like any other payment, so the period, the
  // ledger and the notifications are written in exactly one place.
  const settled = await settle(admin, tracker, { source: 'renewal', actorId })
  return { charged: settled.result === 'paid', tracker, result: settled.result }
}

/** Turns a stored ISO date into one Safepay will accept, or null. */
export const safeDate = (value) => isoDate(value)
