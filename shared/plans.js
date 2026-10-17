// Shared plan rules.
//
// Deliberately dependency-free, exactly like ./slug.js and for the same reason:
// this module is imported by the browser bundle (the Plans & pricing screen and
// the onboarding form) AND by the serverless functions that write to Safepay. A
// plan the form accepts can therefore never be rejected by the server for a
// different reason.
//
// The platform sells in one currency, so the plan form has one price field and
// the checkout path has one price to resolve. The other price columns on
// `subscription_plans` still exist and are NOT NULL, which is why every writer
// goes through `withLegacyPricesZeroed`: 0 is what they must hold, because 0 is
// what `resolvePlanPrice` reads as "not sold in this currency" (a leftover
// non-zero figure would be a live price in a currency the platform no longer
// bills in). The column map is kept whole so history stays readable.
//
// Keep it pure: no `window`, no `import.meta.env`, no Safepay client, no Supabase.

import { CURRENCIES, CURRENCY } from './slug.js'

export { CURRENCIES, CURRENCY }

// Where each currency's price lives on `subscription_plans`.
export const PRICE_COLUMNS = {
  USD: 'price_usd',
  AED: 'price_aed',
  PKR: 'price_pkr',
  GBP: 'price_gbp',
  SAR: 'price_sar',
}

// Currencies the platform used to sell in. Their columns are written as 0 on
// every save, so a leftover figure cannot be read as a live price in a currency
// the platform no longer bills in. They stay in the map because the column set
// mirrors the NOT NULL columns on `subscription_plans`: deleting one here
// without a matching migration turns a clear form error into a 500.
export const LEGACY_PRICE_CURRENCIES = Object.keys(PRICE_COLUMNS).filter((code) => code !== CURRENCY)

/**
 * Every plan write goes through this, so a plan can never keep a price in a
 * currency the platform stopped selling in. Mutates and returns the record, to
 * read as one line at the call site.
 */
export function withLegacyPricesZeroed(record) {
  for (const currency of LEGACY_PRICE_CURRENCIES) record[PRICE_COLUMNS[currency]] = 0
  return record
}



export const INTERVALS = [
  { value: 'month', label: 'Monthly', every: 'month' },
  { value: 'year', label: 'Yearly', every: 'year' },
  // A plan for an arbitrary number of days — "90 days for Rs 4,500". Safepay
  // bills this as `interval: 'DAY'` with an interval_count, which is why the interval
  // is a real option here rather than a special case in the form.
  { value: 'day', label: 'Custom (every N days)', every: 'day' },
]

/** The interval a one-off plan created during onboarding uses. */
export const CUSTOM_INTERVAL = 'day'

// Mirrors the NOT NULL columns on `subscription_plans`. Changing either list
// without the matching migration turns a clear form error into a 500. Only the
// currency the platform sells in is required; the rest are written as 0.
export const REQUIRED_PRICE_CURRENCIES = [CURRENCY]
export const OPTIONAL_PRICE_CURRENCIES = []

export const PLAN_NAME_MIN = 2
export const PLAN_NAME_MAX = 60
export const TRIAL_DAYS_MAX = 365
// Matches the widened check constraint: a day interval of up to 365 is what
// Safepay accepts, so a 90 day custom plan is expressible.
export const INTERVAL_COUNT_MAX = 365

// Safepay takes amounts in the currency's smallest unit. Rupees have two decimal
// places, but a handful of currencies (JPY, KRW, VND, …) have none, and treating
// one of those as two-decimal would charge 100x. The platform bills in PKR only,
// so this list exists purely so that adding a zero-decimal currency later is a
// one-line change rather than a customer being overcharged.
const ZERO_DECIMAL_CURRENCIES = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'])

export const decimalPlaces = (currency) => (ZERO_DECIMAL_CURRENCIES.has(String(currency).toUpperCase()) ? 0 : 2)

/** 19 USD → 1900 minor units. Rounded to avoid float dust (19.99 * 100 = 1998.99…). */
export function toMinorUnits(amount, currency) {
  const places = decimalPlaces(currency)
  return Math.round(Number(amount) * 10 ** places)
}

/** 1900 minor units → 19. Inverse of the above, used when reading Safepay back. */
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
  if (interval === 'day') return intervalCount === 1 ? 'Daily' : `Every ${intervalCount} days`
  if (interval === 'year') return intervalCount === 1 ? 'Yearly' : `Every ${intervalCount} years`
  return intervalCount === 1 ? 'Monthly' : `Every ${intervalCount} months`
}

/**
 * The suffix on a price line — `Rs 2,000/mo`, `Rs 69,232/yr`, `Rs 4,500/90 days`.
 * A day interval spells the count out, because "/day" against a 90 day plan
 * would read as a daily charge.
 */
export const intervalUnit = (planOrInterval, count = 1) => {
  const interval = typeof planOrInterval === 'string' ? planOrInterval : planOrInterval?.interval
  const intervalCount = typeof planOrInterval === 'string' ? count : planOrInterval?.interval_count ?? 1
  if (interval === 'day') return intervalCount === 1 ? 'day' : `${intervalCount} days`
  return interval === 'year' ? 'yr' : 'mo'
}

/**
 * Mirrors the `subscription_plans_sync_duration` trigger in migration 005. The
 * database remains the authority; this copy exists so the form can preview the
 * billing cycle before the row is written.
 */
export function planDurationDays(interval, intervalCount = 1) {
  const count = Number(intervalCount) || 1
  if (interval === 'day') return count
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
 * request can never reach Safepay.
 */
/**
 * A name for a bespoke plan that a person can recognise in a list. It is not a
 * catalogue plan, so it never appears in the onboarding dropdown — but it does
 * appear on invoices and in the subscriber list, where "Spice Garden — 90 days"
 * reads far better than a UUID.
 */
export const customPlanName = (restaurantName, days, suffix = 0) =>
  `${String(restaurantName || 'Restaurant').trim()} — ${days} day${Number(days) === 1 ? '' : 's'}${suffix ? ` (${suffix})` : ''}`

export function planError(plan = {}) {
  const name = String(plan.name ?? '').trim()
  if (!name) return 'Enter a plan name.'
  if (name.length < PLAN_NAME_MIN || name.length > PLAN_NAME_MAX) return `Use between ${PLAN_NAME_MIN} and ${PLAN_NAME_MAX} characters for the plan name.`

  const interval = String(plan.interval ?? 'month')
  if (!['day', 'month', 'year'].includes(interval)) return 'Choose a monthly, yearly, or custom-day billing period.'

  const count = Number(plan.interval_count ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > INTERVAL_COUNT_MAX) {
    return `Billing period must be a whole number between 1 and ${INTERVAL_COUNT_MAX}.`
  }

  const trial = Number(plan.trial_days ?? 0)
  if (!Number.isInteger(trial) || trial < 0 || trial > TRIAL_DAYS_MAX) {
    return `Trial length must be a whole number of days between 0 and ${TRIAL_DAYS_MAX}.`
  }

  // A bespoke plan is priced in the one currency the platform bills in. The
  // other columns are legitimately 0, because `resolvePlanPrice` reads 0 as "not
  // sold in this currency" and refuses rather than charging nothing.
  const custom = plan.is_custom === true || plan.is_custom === 'true'
  if (custom) {
    const raw = plan[PRICE_COLUMNS[CURRENCY]]
    const amount = Number(raw)
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(amount) || amount <= 0) {
      return `Enter the price in ${CURRENCY} — what this restaurant pays each billing period.`
    }
    return ''
  }

  // The price column is NOT NULL on `subscription_plans`, so a missing price
  // would be rejected by the database with an opaque constraint error. Requiring
  // it here keeps the form and the table in agreement.
  for (const currency of REQUIRED_PRICE_CURRENCIES) {
    const raw = plan[PRICE_COLUMNS[currency]]
    if (raw === null || raw === undefined || raw === '') return `Enter a ${currency} price — every plan must be priced in ${currency}.`
    const amount = Number(raw)
    if (!Number.isFinite(amount)) return `Enter a valid ${currency} price.`
    // A zero or negative recurring charge is far more likely to be a slipped
    // keystroke than an intended free plan, and Safepay cannot bill nothing.
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
 * Validates the bespoke plan an operator sizes during onboarding — "90 days for
 * Rs 4,500, with a 10 day trial, or without one".
 *
 * Shared with the server so a value the form accepts can never be refused for a
 * different reason, and so the form can refuse a bad number before an owner
 * account has been created for a restaurant that cannot then be billed.
 */
export function customPlanError(plan = {}) {
  const days = Number(plan.days)
  if (!Number.isInteger(days) || days < 1 || days > INTERVAL_COUNT_MAX) {
    return `Billing period must be a whole number of days between 1 and ${INTERVAL_COUNT_MAX}.`
  }

  const price = Number(plan.price)
  if (!Number.isFinite(price) || price <= 0) return 'Enter the amount to charge each billing period.'

  const trial = Number(plan.trialDays ?? 0)
  if (!Number.isInteger(trial) || trial < 0 || trial > TRIAL_DAYS_MAX) {
    return trial > 0
      ? `Trial length must be a whole number of days between 0 and ${TRIAL_DAYS_MAX}, or turn the trial off.`
      : 'Trial length must be a whole number of days.'
  }

  if (!CURRENCIES.includes(String(plan.currency || CURRENCY).toUpperCase())) {
    return `This platform bills in ${CURRENCY}.`
  }

  return ''
}

/** The price a restaurant should be billed, given the currency its account trades
 * in. Returns null when the plan has no price in that currency, which the
 * onboarding form surfaces instead of letting the database refuse the row.
 */
export function resolvePlanPrice(plan, currency = CURRENCY) {
  const code = String(currency || CURRENCY).toUpperCase()
  const amount = priceForCurrency(plan, code)
  if (amount === null || amount <= 0) return null
  return { currency: code, amount }
}
