// The three phases of a subscription's life, in one place.
//
// Deliberately dependency-free, exactly like ./slug.js and ./plans.js: this
// module is read by the operator panel AND the restaurant panel, so the two can
// never draw the same subscription differently. Both bars follow the same
// colours — trial (white) → paid period (green) → backup days (yellow):
//
//   trial_start .. trial_end        the free trial
//   period_start .. period_end      the paid period
//   due_at .. due_at + backup_days  the backup window (or the platform grace
//                                   when the row has no backup days of its own)
//
// "Backup days" are a per-restaurant window (subscriptions.backup_days): when the
// trial or the paid period ends unpaid, the menu stays online for those days
// before the billing sweep suspends the restaurant. `fallbackBackupDays` is the
// platform-wide grace, used when the row does not carry its own number, so the
// bar stays honest for rows created before migration 024.

export const DAY_MS = 86_400_000

export const PHASE_META = {
  trial: { label: 'Free trial' },
  plan: { label: 'Paid period' },
  backup: { label: 'Backup days' },
}

const at = (value) => {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : time
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/**
 * Where this subscription sits right now, and the phases that make up its life.
 *
 * Returns:
 *   phases        ordered { kind, start, end, days, state } — state is 'past',
 *                 'current' or 'next'; dates are millisecond timestamps.
 *                 A plan that has not started yet still appears (a first paid
 *                 period is promised), marked 'next'.
 *   current       the live phase, or null when the subscription is suspended,
 *                 cancelled, or ended without a backup window.
 *   backupDays    the window that applies to this row (own, or the fallback).
 *   dueAt         when the next money moment is (trial end or period end).
 *   accessEndsAt  end of the last phase — when the menu stops being served.
 */
export function billingPhases(subscription = {}, { now = Date.now(), fallbackBackupDays = 0 } = {}) {
  const status = String(subscription.status || '')
  const own = Number(subscription.backup_days)
  const backupDays = Number.isFinite(own) && own > 0 ? Math.min(own, 365) : Math.max(0, Number(fallbackBackupDays) || 0)

  const trialStart = at(subscription.trial_start)
  const trialEnd = at(subscription.trial_end)
  const planStart = at(subscription.current_period_start)
  const planEnd = at(subscription.current_period_end)
  const planDays = Math.max(1, Number(subscription.plan?.duration_days) || Number(subscription.duration_days) || 30)
  const closed = status === 'suspended' || status === 'canceled'

  // Which phase is running. Mirrors `subscription_due_at`: a trial is due at its
  // trial end, everything else at its period end.
  let current = null
  const trialing = status === 'trialing' && trialEnd
  if (!closed && trialing && trialEnd > now) {
    current = { kind: 'trial', start: trialStart || trialEnd - DAY_MS, end: trialEnd }
  } else if (!closed && planEnd && planEnd > now && (status === 'active' || status === 'past_due')) {
    current = { kind: 'plan', start: planStart || planEnd - planDays * DAY_MS, end: planEnd }
  }

  // The date the money was next due: trial end while trialing, else period end.
  const dueAt = trialing ? trialEnd : planEnd
  const windowStart = dueAt
  const windowEnd = dueAt && backupDays > 0 ? dueAt + backupDays * DAY_MS : null

  if (!closed && !current && windowStart && windowEnd && now >= windowStart && now < windowEnd) {
    current = { kind: 'backup', start: windowStart, end: windowEnd }
  }
  if (current) {
    current.ratio = current.end > current.start ? clamp01((now - current.start) / (current.end - current.start)) : 0
    current.daysLeft = Math.max(0, Math.ceil((current.end - now) / DAY_MS))
  }

  // The bar: every phase with dates behind it, plus the projected plan while a
  // trial is running. `state` decides how it is drawn - solid behind, filled
  // where it stands now, hatched ahead.
  const phaseState = (kind, end) => {
    if (current && current.kind === kind) return 'current'
    return end <= now ? 'past' : 'next'
  }

  const phases = []
  if (trialStart && trialEnd && trialEnd > trialStart) {
    phases.push({ kind: 'trial', start: trialStart, end: trialEnd, days: (trialEnd - trialStart) / DAY_MS, state: phaseState('trial', trialEnd) })
  }

  const resolvedPlanStart = planStart || (trialEnd && (!planEnd || trialEnd <= planEnd) ? trialEnd : null)
  if (resolvedPlanStart && (planEnd || (!closed && trialing))) {
    const end = planEnd || resolvedPlanStart + planDays * DAY_MS
    if (end > resolvedPlanStart) {
      phases.push({ kind: 'plan', start: resolvedPlanStart, end, days: (end - resolvedPlanStart) / DAY_MS, state: phaseState('plan', end) })
    }
  }

  if (windowStart && windowEnd && windowEnd > windowStart) {
    phases.push({ kind: 'backup', start: windowStart, end: windowEnd, days: backupDays, state: phaseState('backup', windowEnd) })
  }

  return {
    phases,
    current,
    backupDays,
    dueAt,
    accessEndsAt: phases.length ? phases[phases.length - 1].end : null,
  }
}
