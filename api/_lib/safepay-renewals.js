// The renewal run: the platform charging the cards it holds.
//
// Safepay cannot do this for us — its Subscriptions product has no create API and
// its checkout needs a Safepay account — so the platform keeps the clock itself and
// this is the job that ticks. It charges the card on file for the next period,
// writes the payment down through the same `settle()` everything else uses, and
// leaves a failed card in the sweep's grace period rather than in limbo.
//
// It is deliberately conservative about who it touches:
//
//   * only `safepay` rows that are still running — a cancelled subscription has
//     already said no;
//   * only rows whose renewal is switched on, which is the flag an owner clears to
//     stop being billed;
//   * only rows with a card pointer, because a charge with nothing to charge is not
//     a renewal, it is an error;
//   * only rows that are actually due (`paymentIsDue`): a paid period still running
//     is not charged early, a trial is charged the moment its last day ends, and a
//     `past_due` row that has never had a period — a subscription started, money
//     not yet taken — is due immediately;
//   * and at most once per day per subscription. A card that is out of funds is out
//     of funds; retrying it every fifteen minutes would hammer the issuer and turn
//     one failure into ten notifications.
//
// The trial rule is why `trialing` rows are read at all: the days were promised
// free, and the first charge belongs at the edge of them. Without that, a
// restaurant that added a card during its trial would simply be suspended when the
// trial ended — with a working card on file.

import { charge, paymentIsDue } from './safepay-billing.js'

const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000

export async function chargeDueSubscriptions(admin, { limit = 10, now = new Date() } = {}) {
  const { data: due, error } = await admin
    .from('subscriptions')
    .select('id, restaurant_id, plan_id, status, amount, currency, provider_customer_id, safepay_card_pointer, card_brand, card_last4, current_period_end, trial_end, renewal_attempted_at, cancel_at_period_end')
    .eq('provider', 'safepay')
    .eq('cancel_at_period_end', false)
    .in('status', ['active', 'past_due', 'trialing'])
    .not('safepay_card_pointer', 'is', null)
    .order('current_period_end', { ascending: true })
    .limit(limit)

  if (error) {
    console.error('[safepay-renewals] could not read due subscriptions:', error.message)
    return { considered: 0, charged: 0, failed: 0, error: error.message }
  }

  let charged = 0
  let failed = 0
  let skipped = 0

  for (const row of due || []) {
    // The same due-date rule the rest of billing reads: an active period still
    // running or a trial with days left is skipped here, not charged early.
    if (!paymentIsDue(row, now.getTime())) {
      skipped += 1
      continue
    }

    const lastAttempt = row.renewal_attempted_at ? new Date(row.renewal_attempted_at).getTime() : 0
    if (lastAttempt && now.getTime() - lastAttempt < RETRY_WINDOW_MS) {
      skipped += 1
      continue
    }

    const { data: plan } = row.plan_id
      ? await admin.from('subscription_plans').select('*').eq('id', row.plan_id).maybeSingle()
      : { data: null }

    const result = await charge(admin, row, { plan, source: 'renewal' })
    if (result.charged) charged += 1
    else failed += 1
  }

  return { considered: (due || []).length, charged, failed, skipped }
}
