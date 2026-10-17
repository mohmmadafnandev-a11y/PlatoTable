import { daysBetween, money, shortDate } from './format'

// Describes where a subscription is in its life, as data.
//
// Kept out of the component file both because React Fast Refresh wants a module
// that exports only components, and because this is the part worth reasoning
// about on its own: given a subscription row, what is true about its period, what
// is charged next, and how much of the period has been spent.
//
// The states, and what each is called:
//
//   trialing, running      the trial bar: trial elapsed against the time left
//                          before the first charge, with its amount and date
//   trialing, not started  the same bar with nothing elapsed yet
//   trialing, over         the trial has ended and the first charge is overdue
//   active                 the current paid period, and the next renewal
//   active, ending         the last paid period, and that no charge follows
//   past_due               the period whose payment failed
//   suspended / canceled   no running period, so no bar: just the state

const DAY = 86400000

const clamp = (value) => Math.min(1, Math.max(0, value))

/** Days from now until `value`, floored at 0. Null when there is no date. */
const daysLeft = (value) => (value ? daysBetween(value) : null)

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

const legend = (elapsedLabel, remainingLabel) => [
  { label: elapsedLabel, kind: 'solid' },
  { label: remainingLabel, kind: 'outline' },
]

const nothing = (eyebrow, headline, footer, tone = 'slate') => ({
  eyebrow, headline, footer, tone, ratio: null, legend: [], payLabel: '', payValue: '',
})

export function progressView(subscription = {}) {
  const amount = money(subscription.amount, subscription.currency)
  const status = subscription.status || 'unconfigured'

  if (status === 'canceled') {
    return nothing(
      'CANCELLED',
      'No active period',
      'This subscription is cancelled, so Safepay is not asked for anything. Start a new checkout below to bill this restaurant again.',
      'danger',
    )
  }

  if (status === 'suspended') {
    return {
      ...nothing(
        'SUSPENDED',
        'Billing paused',
        'No payment is collected while the subscription is suspended. Reactivate it to put the plan back in force.',
        'danger',
      ),
      payLabel: 'RECURRING AMOUNT',
      payValue: amount,
    }
  }

  const trialStart = subscription.trial_start ? new Date(subscription.trial_start).getTime() : null
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end).getTime() : null

  // A trial that has not begun yet. Onboarded on a Friday to start on Monday is
  // a real case, and it must not read as "7 days left".
  if (status === 'trialing' && trialStart && trialStart > Date.now()) {
    const startsIn = daysLeft(subscription.trial_start)
    return {
      eyebrow: 'TRIAL SCHEDULED',
      headline: startsIn > 0 ? `Starts in ${plural(startsIn, 'day')}` : 'Starts today',
      payLabel: 'FIRST PAYMENT',
      payValue: amount,
      legend: legend('Trial days', 'First paid month'),
      ratio: 0,
      tone: 'slate',
      footer: `The trial runs from ${shortDate(subscription.trial_start)} to ${shortDate(subscription.trial_end)}. Safepay takes the first payment of ${amount} on ${shortDate(subscription.trial_end)}.`,
    }
  }

  if (status === 'trialing') {
    const left = daysLeft(subscription.trial_end)
    // No end date at all: the bar cannot say anything honest, so it is omitted
    // rather than drawn empty.
    if (left === null) {
      return {
        eyebrow: 'FREE TRIAL',
        headline: 'No end date set',
        payLabel: 'FIRST PAYMENT',
        payValue: amount,
        legend: [], ratio: null, tone: 'slate',
        footer: 'This trial has no end date, so nothing is scheduled to be charged. Set a period in Actions to start billing.',
      }
    }

    const total = trialStart && trialEnd && trialEnd > trialStart ? trialEnd - trialStart : null
    const ratio = total ? clamp((Date.now() - trialStart) / total) : 0

    if (left <= 0) {
      return {
        eyebrow: 'TRIAL ENDED',
        headline: `First payment due${left < 0 ? ` ${plural(Math.abs(left), 'day')} ago` : ' today'}`,
        payLabel: 'FIRST PAYMENT',
        payValue: amount,
        legend: legend('Trial days', 'First paid month'),
        ratio: 1,
        tone: 'warning',
        footer: `The trial ended on ${shortDate(subscription.trial_end)}. Safepay takes the first payment of ${amount} when it next collects from the saved card.`,
      }
    }

    return {
      eyebrow: 'FREE TRIAL',
      headline: `${plural(left, 'day')} left`,
      payLabel: 'FIRST PAYMENT',
      payValue: amount,
      legend: legend('Trial days', 'First paid month'),
      ratio,
      tone: 'indigo',
      footer: `Your ${total ? Math.round(total / DAY) : left}-day trial covers this period. Safepay takes the first payment of ${amount} on ${shortDate(subscription.trial_end)}.`,
    }
  }

  // active and past_due both run on the paid period, and both end at the same
  // date; only the copy about the payment differs.
  const periodEnd = subscription.current_period_end || null
  const periodStart = subscription.current_period_start || null
  const end = periodEnd ? new Date(periodEnd).getTime() : null
  const start = periodStart ? new Date(periodStart).getTime() : null
  const total = start && end && end > start ? end - start : null
  const ratio = total ? clamp((Date.now() - start) / total) : 0
  const left = daysLeft(periodEnd)

  if (status === 'past_due') {
    return {
      eyebrow: 'PAYMENT OVERDUE',
      headline: end && end < Date.now() ? `Period ended ${plural(Math.abs(left ?? 0), 'day')} ago` : 'Payment did not go through',
      payLabel: 'AMOUNT DUE',
      payValue: amount,
      legend: legend('Days used', 'Days remaining'),
      ratio,
      tone: 'warning',
      footer: `Safepay could not collect ${amount} for this period. It retries on its own; the restaurant is switched off once the grace period passes.`,
    }
  }

  if (subscription.cancel_at_period_end) {
    return {
      eyebrow: 'ENDING AT PERIOD END',
      headline: left === null ? 'Ends at the period end' : `${plural(left, 'day')} left`,
      payLabel: 'NO FURTHER PAYMENT',
      payValue: amount,
      legend: legend('Days used', 'Days remaining'),
      ratio,
      tone: 'warning',
      footer: `This subscription will not renew. Access ends on ${shortDate(periodEnd)} and no further payment of ${amount} is taken.`,
    }
  }

  return {
    eyebrow: 'CURRENT PERIOD',
    headline: left === null ? 'Active' : `${plural(left, 'day')} left`,
    payLabel: 'NEXT PAYMENT',
    payValue: amount,
    legend: legend('Days used', 'Days remaining'),
    ratio,
    tone: 'indigo',
    footer: `This period is paid up to ${shortDate(periodEnd)}. Safepay takes the next payment of ${amount} on ${shortDate(periodEnd)}.`,
  }
}
