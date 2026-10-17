import { CURRENCY, PRICE_COLUMNS, featureList, intervalLabel } from '../../shared/plans.js'
import { createPlan, deletePlan, safepayProblems } from './safepay.js'

// Pushing a plan into Safepay, in one place.
//
// Two principles shape it:
//
//   1. The database row is written BEFORE Safepay is called. An operator who
//      typed a plan must not lose it because Safepay was unreachable.
//   2. A failure is reported rather than hidden: the row keeps whatever token it
//      had, `safepay_sync_error` says what went wrong, and the screen shows it.
//
// One thing is new. Safepay keeps the trial period on the *plan*, not on the
// checkout, so a restaurant that has already used its trial cannot be sent to the
// same plan as a first-timer without handing out a second free week. Every plan
// is therefore mirrored twice: a renewal plan with no trial, and — when the plan
// offers one — a trial plan. `safepayPlanFor` picks between them using the
// restaurant's own `trial_used_at`, so a restaurant that has already had its free
// week is never sent to the trial plan again.
//
// Prices are immutable in Safepay, so a changed price means a new token. The payload that produced each token is stored beside
// it (`safepay_sync`), which is what lets a save tell "nothing changed, keep the
// token" from "the price moved, mint a new one". A token whose payload no longer
// matches is treated as *not linked* by the checkout rather than used: charging
// last month's price is worse than refusing to start.

const INTERVAL_CODES = { day: 'DAY', month: 'MONTH', year: 'YEAR' }

// Safepay validates a plan name against a narrow grammar. Measured against the
// live sandbox, it is word-based rather than character-based:
//
//   accepted      letters, digits, `_` and `-` *inside* a word; words separated
//                 by a single space
//   refused       `. , & ' + @ % / ( ) — •`, accented letters, repeated spaces,
//                 leading or trailing spaces…
//   and, least obviously, a hyphen standing alone between two words —
//                 `Alpha-Beta` is accepted, `Alpha - Beta` is not.
//
// That matters because the platform's own names are not written for Safepay: an
// operator types “Pro (Annual)”, a bespoke plan is named “Spice Garden — 90
// days”, and “Ali's & Co.” is an ordinary restaurant name. The row keeps the name
// the operator typed — it is what the panel shows and what the receipt
// references — and only the mirror's name is made legal.
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9 _-]+/g
// Punctuation worth spelling out rather than dropping, so “Ali's & Co.” reads as
// “Alis and Co” instead of losing the words.
const NAME_EQUIVALENTS = [[/[\u2014\u2013]/g, ' '], [/&/g, ' and '], [/[\u2018\u2019'\u201c\u201d"]/g, '']]
// A hyphen with nothing on at least one side of it: the separator grammar
// Safepay refuses. Word-internal hyphens are left alone.
const LOOSE_HYPHEN = /(^|\s)-+(?=\s|$)/g

/**
 * A plan name Safepay will accept.
 *
 * Rewrites anything it refuses into spaces, drops hyphens that are standing
 * alone, collapses the runs that leaves behind, trims, and appends the trial
 * marker where needed — as a word, not as `(trial)`, because parentheses are
 * exactly one of the things it rejects. Falls back to a fixed word so a name made
 * entirely of punctuation still yields a plan instead of a 400.
 */
export function safepayPlanName(name, { trial = false } = {}) {
  let cleaned = String(name ?? '')
  for (const [pattern, replacement] of NAME_EQUIVALENTS) cleaned = cleaned.replace(pattern, replacement)
  cleaned = cleaned.replace(UNSAFE_NAME_CHARS, ' ')
  cleaned = cleaned.replace(/\s+/g, ' ').replace(LOOSE_HYPHEN, ' ').replace(/\s+/g, ' ').trim()
  if (trial) cleaned = `${cleaned} Trial`.trim()
  return cleaned || 'Plan'
}

/** The exact body Safepay is given, for one of the two variants. */
export function planPayload(plan, { trial }) {
  const amount = Number(plan?.[PRICE_COLUMNS[CURRENCY]] || 0)
  const features = featureList(plan?.features)
  return {
    name: safepayPlanName(plan?.name, { trial }),
    amount,
    currency: CURRENCY,
    interval: INTERVAL_CODES[plan?.interval] || 'MONTH',
    interval_count: Math.max(1, Number(plan?.interval_count) || 1),
    trial_days: trial ? Math.max(0, Number(plan?.trial_days) || 0) : 0,
    product: `platotable-${plan?.id}${trial ? '-trial' : ''}`,
    description: features.length ? features.map((item) => `• ${item}`).join('\n') : null,
    label: intervalLabel(plan, Number(plan?.interval_count) || 1),
  }
}

/**
 * One payload expressed so two of them can be compared.
 *
 * Not a plain `JSON.stringify`: the payload is stored in a `jsonb` column, and
 * `jsonb` does not keep the insertion order of an object's keys — it rewrites
 * them shortest-first, bytewise. Comparing a payload read back from the database
 * against one just built in JavaScript therefore never matched, which made every
 * save look like a changed plan (minting a duplicate in Safepay each time) and
 * made the checkout refuse a linked plan as stale. Sorting the keys on both
 * sides is what makes the comparison about the values again.
 */
const canonical = (value) => JSON.stringify(value, (key, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((entry) => [entry, item[entry]]))
    : item
))

const samePayload = (a, b) => Boolean(a && b) && canonical(a) === canonical(b)

const storedFor = (plan, variant) => {
  const stored = plan?.safepay_sync
  if (!stored || typeof stored !== 'object') return { id: null, payload: null }
  const entry = stored[variant]
  return { id: entry?.id || null, payload: entry?.payload || null }
}

/**
 * Which Safepay plan a restaurant should be sent to.
 *
 * Returns `{ planId: null, reason }` when the linked token cannot be trusted —
 * either there is none, or the plan has changed since the token was minted. The
 * checkout turns that into a sentence telling the operator to re-save the plan.
 */
export function safepayPlanFor(plan, { trial }) {
  const variant = trial ? 'trial' : 'renewal'
  const column = trial ? plan?.safepay_plan_id_trial : plan?.safepay_plan_id
  const desired = planPayload(plan, { trial })
  if (Number(desired.amount) <= 0) return { planId: null, variant, reason: `This plan has no ${CURRENCY} price, so it cannot be sold.` }
  if (!column) return { planId: null, variant, reason: 'not-linked' }
  const stored = storedFor(plan, variant)
  if (!samePayload(stored.payload, desired)) return { planId: null, variant, reason: 'stale' }
  return { planId: column, variant }
}

/**
 * Mirrors one saved plan into Safepay and records the tokens.
 *
 * Returns `{ plan, report }` where `plan` is the row as it now stands (never
 * null) and `report` says whether the sync worked. It does not throw for a
 * Safepay failure: the row is already written, and an onboarding that is halfway
 * through must not be rolled back because the payment provider is down.
 */
export async function syncSavedPlan(admin, plan) {
  const problems = safepayProblems()
  if (problems.length) {
    const message = `${problems.join(', ')} is not set for this deployment, so the plan is saved here but not in Safepay.`
    const { data } = await admin.from('subscription_plans').update({
      safepay_sync_error: message,
      safepay_synced_at: null,
    }).eq('id', plan.id).select('*').single()
    return { plan: data || plan, report: { synced: false, errors: [message], planIds: { renewal: plan.safepay_plan_id || null, trial: plan.safepay_plan_id_trial || null } } }
  }

  const desired = {
    renewal: planPayload(plan, { trial: false }),
    trial: Number(plan?.trial_days) > 0 ? planPayload(plan, { trial: true }) : null,
  }

  if (desired.renewal.amount <= 0) {
    const message = `This plan has no ${CURRENCY} price, so there is nothing for Safepay to charge and no plan was created.`
    const { data } = await admin.from('subscription_plans').update({ safepay_sync_error: message }).eq('id', plan.id).select('*').single()
    return { plan: data || plan, report: { synced: false, errors: [message], planIds: { renewal: null, trial: null } } }
  }

  const errors = []
  const ids = {
    renewal: plan.safepay_plan_id || null,
    trial: desired.trial ? plan.safepay_plan_id_trial || null : null,
  }
  const payloads = {
    renewal: storedFor(plan, 'renewal').payload,
    trial: storedFor(plan, 'trial').payload,
  }

  // The renewal variant: always needed, and recreated only when the body differs
  // from the one that produced the token it is holding.
  if (!(ids.renewal && samePayload(payloads.renewal, desired.renewal))) {
    try {
      const created = await createPlan(desired.renewal)
      ids.renewal = created.planId
      payloads.renewal = desired.renewal
    } catch (error) {
      errors.push(`Renewal plan: ${error?.message || 'Safepay refused the plan.'}`)
    }
  }

  // The trial variant, when the plan offers one.
  if (desired.trial && !(ids.trial && samePayload(payloads.trial, desired.trial))) {
    try {
      const created = await createPlan(desired.trial)
      ids.trial = created.planId
      payloads.trial = desired.trial
    } catch (error) {
      errors.push(`Trial plan: ${error?.message || 'Safepay refused the plan.'}`)
      // The trial is a courtesy on top of a working subscription: the plan is
      // still sellable without it, so this alone does not mark the plan unsynced.
    }
  }

  const record = {
    safepay_plan_id: ids.renewal,
    safepay_plan_id_trial: ids.trial,
    safepay_synced_at: new Date().toISOString(),
    safepay_sync_error: errors.length ? errors.join(' ') : null,
    safepay_sync: {
      renewal: ids.renewal ? { id: ids.renewal, payload: payloads.renewal } : null,
      trial: desired.trial && ids.trial ? { id: ids.trial, payload: payloads.trial } : null,
    },
  }

  const { data, error } = await admin.from('subscription_plans').update(record).eq('id', plan.id).select('*').single()
  if (error) {
    console.error('[safepay-plans] could not record the tokens for', plan.id, error.message)
    return { plan: { ...plan, ...record }, report: { synced: !errors.length, errors, planIds: ids } }
  }

  return { plan: data || plan, report: { synced: !errors.length, errors, planIds: ids } }
}

/**
 * Closes the Safepay plans behind a plan row that is being removed.
 *
 * Only reachable for a plan that has no subscriptions — the delete endpoint
 * refuses the rest — so nothing is billing against the plans being closed.
 */
export async function retireSafepayPlans(plan) {
  const ids = [plan?.safepay_plan_id, plan?.safepay_plan_id_trial].filter(Boolean)
  const results = await Promise.all(ids.map((id) => deletePlan(id)))
  return { retired: results.filter((result) => result.deleted).length, results }
}
