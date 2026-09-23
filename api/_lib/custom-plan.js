import { CURRENCIES, CUSTOM_INTERVAL, PRICE_COLUMNS, customPlanError, customPlanName, planDurationDays } from '../../shared/plans.js'
import { syncSavedPlan } from './stripe-plans.js'

// A plan sized for one restaurant.
//
// Not every restaurant should be pushed onto a catalogue plan. A five-table cafe
// that wants "90 days for PKR 5,000, no trial" is a real deal, and forcing it
// into a monthly plan means either losing the sale or inventing a catalogue plan
// nobody else will ever buy. This creates that plan, keeps it out of the public
// catalogue (`is_custom` / `is_public`), and puts it in Stripe so the restaurant
// can still subscribe to it with a card.
//
// The plan is created by the onboarding handler, which runs with the service
// role, so it is never reachable from a browser session.

/**
 * Writes the bespoke plan and mirrors it into Stripe.
 *
 * Returns the saved row. The Stripe half is reported, not thrown: a plan the
 * operator typed must not be lost because Stripe was unreachable, and
 * `stripe_sync_error` is what tells them to re-sync it.
 */
export async function createCustomPlan(admin, { restaurantName, currency, days, price, trialDays }) {
  const problem = customPlanError({ days, price, trialDays, currency })
  if (problem) return { error: problem }

  const code = String(currency).toUpperCase()
  const period = Number(days)
  const trial = Number(trialDays) || 0

  // `name` is unique. Two restaurants may legitimately want the same period, so
  // a taken name is suffixed rather than allowed to fail the onboarding after
  // the owner's account already exists.
  let name = customPlanName(restaurantName, period)
  let suffix = 1
  for (;;) {
    const { data: taken } = await admin.from('subscription_plans').select('id').eq('name', name).maybeSingle()
    if (!taken) break
    suffix += 1
    if (suffix > 50) return { error: 'Could not find a free name for the custom plan.' }
    name = customPlanName(restaurantName, period, suffix)
  }

  const record = {
    name,
    interval: CUSTOM_INTERVAL,
    interval_count: period,
    trial_days: trial,
    duration_days: planDurationDays(CUSTOM_INTERVAL, period),
    is_active: true,
    // Kept out of the catalogue: only the restaurant it was made for may be put
    // on it, and onboarding lists `is_public` plans only.
    is_custom: true,
    is_public: false,
    features: [],
  }

  // The three NOT NULL price columns must all carry a value, but `0` is the
  // honest one for a currency this plan is not sold in: `resolvePlanPrice`
  // treats a zero as "not priced here" and refuses rather than charging nothing.
  // Leaving the column's default (19 USD) would silently sell the plan in
  // dollars.
  for (const item of CURRENCIES) record[PRICE_COLUMNS[item]] = item === code ? Number(price) : 0

  const { data: saved, error } = await admin.from('subscription_plans').insert(record).select('*').single()
  if (error) return { error: error.code === '23505' ? 'A plan with this name already exists.' : error.message }

  const { plan, report } = await syncSavedPlan(admin, saved)
  return { plan, stripe: report }
}
