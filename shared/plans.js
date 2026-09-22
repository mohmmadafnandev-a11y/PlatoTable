// Shared plan rules.
//
// Deliberately dependency-free, exactly like ./slug.js and for the same reason:
// this module is imported by the browser bundle (the Plans & pricing screen and
// the onboarding form) AND by the serverless functions that write to Stripe. A
// plan the form accepts can therefore never be rejected by the server for a
// different reason, and the currency→column mapping exists in one place instead
// of drifting between the two.
//
// Keep it pure: no `window`, no `import.meta.env`, no Stripe client, no Supabase.

import { CURRENCIES } from './slug.js'

export { CURRENCIES }

// Where each currency's price lives on `subscription_plans`. Three of these are
// NOT NULL in the database (USD, AED, PKR) and two are optional (GBP, SAR),
// which is why GBP/SAR may legitimately be absent for a plan.
export const PRICE_COLUMNS = {
  USD: 'price_usd',
  AED: 'price_aed',
  PKR: 'price_pkr',
  GBP: 'price_gbp',
  SAR: 'price_sar',
}

/** `USD` → `stripe_price_usd`, the column holding that currency's Stripe Price id. */
export const stripePriceColumn = (currency) => `stripe_price_${String(currency).toLowerCase()}`

export const INTERVALS = [
  { value: 'month', label: 'Monthly', every: 'month' },
  { value: 'year', label: 'Yearly', every: 'year' },
]

// Mirrors the NOT NULL columns on `subscription_plans`. Changing either list
// without the matching migration turns a clear form error into a 500.
export const REQUIRED_PRICE_CURRENCIES = ['USD', 'AED', 'PKR']
export const OPTIONAL_PRICE_CURRENCIES = ['GBP', 'SAR']

export const PLAN_NAME_MIN = 2
export const PLAN_NAME_MAX = 60
export const TRIAL_DAYS_MAX = 365
export const INTERVAL_COUNT_MAX = 36

// Stripe takes amounts in the currency's smallest unit. Most currencies have two
// decimal places, but a handful (JPY, KRW, VND, …) have none, and multiplying
// those by 100 would charge 100x. None of the five currencies sold today is
// zero-decimal, so this list exists purely so that adding one later is a
// one-line change rather than a customer being overcharged.
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])

export const decimalPlaces = (currency) => (ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase()) ? 0 : 2)

/** 19 USD → 1900 minor units. Rounded to avoid float dust (19.99 * 100 = 1998.99…). */
export function toMinorUnits(amount, currency) {
  const places = decimalPlaces(currency)
  return Math.round(Number(amount) * 10 ** places)
}

/** 1900 minor units → 19. Inverse of the above, used when reading Stripe back. */
export function fromMinorUnits(minor, currency) {
  const places = decimalPlaces(currency)
  return Number(minor) / 10 ** places
}

export const priceForCurrency = (plan, currency) => {
  const value = plan?.[PRICE_COLUMNS[String(currency).toUpperCase()]]
  return value === null || value === undefined || value === '' ? null : Number(value)
}

/** The interval the way a person says it: "Monthly", "Every 3 months", "Yearly". */
export function intervalLabel(planOrInterval, count = 1) {
  const interval = typeof planOrInterval === 'string' ? planOrInterval : planOrInterval?.interval
  const intervalCount = typeof planOrInterval === 'string' ? count : planOrInterval?.interval_count ?? 1
  if (interval === 'year') return intervalCount === 1 ? 'Yearly' : `Every ${intervalCount} years`
  return intervalCount === 1 ? 'Monthly' : `Every ${intervalCount} months`
}

/** "Monthly" → "month", for the `/mo` and `/yr` suffix in a price line. */
export const intervalUnit = (planOrInterval) => (typeof planOrInterval === 'string' ? planOrInterval : planOrInterval?.interval) === 'year' ? 'yr' : 'mo'

/**
 * Mirrors the `subscription_plans_sync_duration` trigger in migration 005. The
 * database remains the authority; this copy exists so the form can preview the
 * billing cycle before the row is written.
 */
export function planDurationDays(interval, intervalCount = 1) {
  const count = Number(intervalCount) || 1
  return interval === 'year' ? 365 * count : 30 * count
}

/** Features arrive as textarea lines from the form and as jsonb from the row. */
export function featureList(features) {
  if (Array.isArray(features)) return features.map((item) => String(item).trim()).filter(Boolean)
  if (typeof features === 'string') return features.split('\n').map((item) => item.trim()).filter(Boolean)
  return []
}

/**
 * Returns an empty string when the plan is acceptable, otherwise a message
 * written for the person editing it. The server calls this too, so a malformed
 * request can never reach Stripe.
 */
export function planError(plan = {}) {
  const name = String(plan.name ?? '').trim()
  if (!name) return 'Enter a plan name.'
  if (name.length < PLAN_NAME_MIN || name.length > PLAN_NAME_MAX) return `Use between ${PLAN_NAME_MIN} and ${PLAN_NAME_MAX} characters for the plan name.`

  const interval = String(plan.interval ?? 'month')
  if (!['month', 'year'].includes(interval)) return 'Choose a monthly or yearly billing period.'

  const count = Number(plan.interval_count ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > INTERVAL_COUNT_MAX) {
    return `Billing period must be a whole number between 1 and ${INTERVAL_COUNT_MAX}.`
  }

  const trial = Number(plan.trial_days ?? 0)
  if (!Number.isInteger(trial) || trial < 0 || trial > TRIAL_DAYS_MAX) {
    return `Trial length must be a whole number of days between 0 and ${TRIAL_DAYS_MAX}.`
  }

  // USD, AED and PKR are NOT NULL columns on `subscription_plans`, so a plan
  // missing one of them would be rejected by the database with an opaque
  // constraint error. Requiring them here keeps the form and the table in
  // agreement. GBP and SAR are genuinely optional: a plan need not be sold in
  // every market.
  for (const currency of REQUIRED_PRICE_CURRENCIES) {
    const raw = plan[PRICE_COLUMNS[currency]]
    if (raw === null || raw === undefined || raw === '') return `Enter a ${currency} price — every plan must be priced in ${currency}.`
    const amount = Number(raw)
    if (!Number.isFinite(amount)) return `Enter a valid ${currency} price.`
    // A zero or negative recurring charge is far more likely to be a slipped
    // keystroke than an intended free plan, and Stripe cannot bill nothing.
    if (amount <= 0) return `${currency} price must be greater than zero.`
  }

  for (const currency of OPTIONAL_PRICE_CURRENCIES) {
    const raw = plan[PRICE_COLUMNS[currency]]
    if (raw === null || raw === undefined || raw === '') continue
    const amount = Number(raw)
    if (!Number.isFinite(amount)) return `Enter a valid ${currency} price.`
    if (amount <= 0) return `${currency} price must be greater than zero, or leave it blank to not sell this plan in ${currency}.`
  }

  return ''
}

/**
 * The price a restaurant should be billed, given the currency its account trades
 * in. Returns null when the plan has no price in that currency, which the
 * onboarding form surfaces instead of letting the database refuse the row.
 */
export function resolvePlanPrice(plan, currency) {
  const code = String(currency ?? 'USD').toUpperCase()
  const amount = priceForCurrency(plan, code)
  if (amount === null || amount <= 0) return null
  return { currency: code, amount, priceId: plan?.[stripePriceColumn(code)] || null }
}
