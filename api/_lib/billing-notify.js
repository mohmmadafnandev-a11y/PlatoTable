// Payment notifications, written once and reused by every path that learns a
// payment happened.
//
// Both the webhook and the manual sync endpoint need this, and they disagree
// about nothing except how they found out — so the text, the audience split and
// the dedupe key live here. Two copies would eventually produce two different
// sentences for the same event.
//
// Every function here is deliberately failure-tolerant: a notification is a
// courtesy, and it must never be the reason a payment path returns an error
// after the money has already moved.

const punctuation = (currency) => String(currency || '').toUpperCase()

/** `PKR 2,000.00` — the same shape the SQL formatter uses. */
export function formatAmount(amount, currency) {
  const value = Number(amount || 0)
  const fixed = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${punctuation(currency)} ${fixed}`
}

/**
 * Records a settled or failed payment for both audiences.
 *
 * `dedupeKey` is supplied by the caller because only it knows the event's
 * identity (an invoice id, a subscription id). The same event arriving twice —
 * a webhook retry, or a webhook followed by a manual sync — collapses to one
 * pair of rows instead of spamming the restaurant.
 */
export async function recordPaymentNotifications(admin, {
  restaurantId,
  restaurantName,
  succeeded,
  amount,
  currency,
  planName,
  dedupeKey,
  invoiceUrl,
  source,
}) {
  if (!restaurantId || !dedupeKey) return { written: 0 }

  const name = restaurantName || 'The restaurant'
  const money = formatAmount(amount, currency)
  const plan = planName ? ` (${planName})` : ''
  const stamp = new Date().toISOString()

  const rows = succeeded
    ? [
        {
          restaurant_id: restaurantId,
          audience: 'restaurant',
          type: 'success',
          title: 'Payment received',
          message: `We received ${money}${plan}. Your subscription is active — thank you.`,
          background_color: 'green',
          dedupe_key: `${dedupeKey}:restaurant`,
          // Prefer the document Stripe hosts for this payment; the billing page is
          // the fallback for a payment that has no invoice behind it (a manual
          // record, or an invoice Stripe has not generated yet).
          action_url: invoiceUrl || '/admin/billing',
          action_label: 'View receipt',
        },
        {
          restaurant_id: restaurantId,
          audience: 'platform',
          type: 'success',
          title: `${name} completed a payment`,
          message: `${name} paid ${money}${plan} through Stripe ${source === 'sync' ? '(recovered by a manual sync)' : 'checkout'}.`,
          background_color: 'green',
          dedupe_key: `${dedupeKey}:platform`,
          action_url: '/admin/subscriptions',
          action_label: 'Open subscription',
        },
      ]
    : [
        {
          restaurant_id: restaurantId,
          audience: 'restaurant',
          type: 'critical',
          title: 'Payment failed',
          message: `We could not charge ${money}${plan}. Update your payment method to avoid losing access to your menu.`,
          background_color: 'red',
          dedupe_key: `${dedupeKey}:restaurant`,
          action_url: '/admin/payment',
          action_label: 'Update payment method',
        },
        {
          restaurant_id: restaurantId,
          audience: 'platform',
          type: 'critical',
          title: `Payment failed for ${name}`,
          message: `${name} could not be charged ${money}${plan}. It stays in grace until it pays or is suspended by the billing sweep.`,
          background_color: 'red',
          dedupe_key: `${dedupeKey}:platform`,
          action_url: '/admin/subscriptions',
          action_label: 'Open subscription',
        },
      ]

  const { error } = await admin
    .from('system_notifications')
    .upsert(rows.map((row) => ({ ...row, created_at: stamp })), { onConflict: 'dedupe_key', ignoreDuplicates: true })

  if (error) {
    console.error('[billing-notify] could not record payment notifications:', error.message)
    return { written: 0 }
  }
  return { written: rows.length }
}

/** The price a plan charges in a given currency, or null. Mirrors shared/plans.js. */
export function planNameFor(plan) {
  return plan?.name || null
}
