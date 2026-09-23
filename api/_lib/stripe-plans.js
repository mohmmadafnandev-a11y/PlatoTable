import Stripe from 'stripe'
import { CURRENCIES, PRICE_COLUMNS, featureList, stripePriceColumn, toMinorUnits } from '../../shared/plans.js'

// Pushing a plan into Stripe, in one place.
//
// This used to live inside the Plans & pricing endpoint, which was fine while
// that screen was the only thing that could create a plan. Onboarding can now
// create one too (a bespoke plan sized for a single restaurant), and two copies
// of this logic would drift — the second copy would not know that prices are
// immutable in Stripe, or that one rejected currency must not discard the rest.

/**
 * A missing secret is by far the most likely reason nothing reaches Stripe, and
 * the generic Stripe message for it ("Invalid API key") sends you looking in the
 * wrong place. Say the actual thing.
 */
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return { error: 'STRIPE_SECRET_KEY is not set for this deployment, so plans are saved locally but cannot be created in Stripe.' }
  if (!/^(sk|rk)_(test|live)_/.test(key)) return { error: 'STRIPE_SECRET_KEY does not look like a Stripe key.' }
  return { stripe: new Stripe(key) }
}

const describeFeatures = (features) => {
  const list = featureList(features)
  return list.length ? list.map((item) => `• ${item}`).join('\n') : null
}

/**
 * Push one plan to Stripe: its Product, then one Price per currency it is sold
 * in. Returns the ids to persist plus any per-currency failures, so the caller
 * can record both.
 */
export async function syncPlanToStripe(stripe, plan) {
  const productPayload = {
    name: plan.name,
    active: plan.is_active,
    metadata: {
      platotable_plan_id: plan.id,
      interval: plan.interval,
      interval_count: String(plan.interval_count),
    },
  }
  const description = describeFeatures(plan.features)
  if (description) productPayload.description = description

  // A plan that was synced before keeps its product, so its past invoices stay
  // attached to the same product as its future ones.
  let productId = plan.stripe_product_id
  if (productId) {
    try {
      await stripe.products.update(productId, productPayload)
    } catch (error) {
      // The stored product can be gone: the key may have been rotated between a
      // test and a live account, or the product deleted by hand. Recreate.
      if (error?.statusCode === 404 || error?.code === 'resource_missing') {
        productId = null
        plan.stripe_product_id = null
      } else throw error
    }
  }
  if (!productId) {
    const created = await stripe.products.create(productPayload)
    productId = created.id
  }

  const priceIds = {}
  const errors = []

  for (const currency of CURRENCIES) {
    const column = stripePriceColumn(currency)
    const storedId = plan[column]
    const amount = plan[PRICE_COLUMNS[currency]]

    // Currency withdrawn from the plan: stop it being offered, but keep the
    // Price object itself. Existing subscriptions still reference it and Stripe
    // never lets go of pricing history.
    if (amount === null || amount === undefined || amount === '' || Number(amount) <= 0) {
      if (storedId) {
        try { await stripe.prices.update(storedId, { active: false }) } catch { /* already gone or already inactive */ }
      }
      priceIds[column] = null
      continue
    }

    const wanted = {
      currency: String(currency).toLowerCase(),
      unit_amount: toMinorUnits(amount, currency),
      interval: plan.interval,
      interval_count: Number(plan.interval_count) || 1,
    }

    try {
      if (storedId) {
        const current = await stripe.prices.retrieve(storedId).catch((error) => {
          if (error?.statusCode === 404 || error?.code === 'resource_missing') return null
          throw error
        })
        const unchanged = current && current.active
          && current.unit_amount === wanted.unit_amount
          && current.currency === wanted.currency
          && current.recurring?.interval === wanted.interval
          && (current.recurring?.interval_count || 1) === wanted.interval_count
        // Reusing the identical Price matters beyond tidiness: replacing it would
        // change the price a future subscription is billed at for no reason.
        if (unchanged) { priceIds[column] = storedId; continue }
        if (current?.active) await stripe.prices.update(storedId, { active: false })
      }
      // `interval` and `interval_count` must live inside `recurring` and nowhere
      // else: the Stripe SDK rejects them at the top level with "Received unknown
      // parameters", which would fail every currency at once.
      const price = await stripe.prices.create({
        product: productId,
        nickname: `${plan.name} · ${currency}`,
        currency: wanted.currency,
        unit_amount: wanted.unit_amount,
        recurring: { interval: wanted.interval, interval_count: wanted.interval_count },
        metadata: { platotable_plan_id: plan.id, currency },
      })
      priceIds[column] = price.id
    } catch (error) {
      // One currency failing must not discard the others or the saved plan.
      errors.push({ currency, message: error?.message || 'Stripe rejected this price.' })
      priceIds[column] = storedId || null
    }
  }

  return { productId, priceIds, errors }
}

/**
 * Mirror one saved plan row into Stripe and record the outcome on the row.
 *
 * A failure is reported, never thrown: the plan already exists in the database,
 * and losing it because Stripe was unreachable would be worse than a plan that
 * needs re-syncing. `stripe_sync_error` is what the screens surface.
 */
export async function syncSavedPlan(admin, plan) {
  const { stripe, error: keyError } = stripeClient()
  if (keyError) {
    return { plan, report: { synced: false, productId: plan.stripe_product_id, errors: CURRENCIES.map((currency) => ({ currency, message: keyError })) } }
  }

  const priced = CURRENCIES.filter((currency) => Number(plan[PRICE_COLUMNS[currency]] || 0) > 0)
  if (!priced.length) {
    return { plan, report: { synced: false, productId: plan.stripe_product_id, errors: [{ currency: '—', message: 'No currency has a price, so there was nothing to send to Stripe.' }] } }
  }

  try {
    const result = await syncPlanToStripe(stripe, plan)
    const patch = { stripe_product_id: result.productId, ...result.priceIds }
    // Only claim a sync when every currency actually landed.
    patch.stripe_synced_at = result.errors.length === 0 ? new Date().toISOString() : null
    patch.stripe_sync_error = result.errors.length
      ? result.errors.map((error) => `${error.currency}: ${error.message}`).join(' · ')
      : null
    const { data, error } = await admin.from('subscription_plans').update(patch).eq('id', plan.id).select('*').single()
    if (error) throw error
    return { plan: data, report: { synced: result.errors.length === 0, productId: result.productId, errors: result.errors } }
  } catch (error) {
    const message = error?.message || 'Stripe could not be reached.'
    const { data } = await admin.from('subscription_plans')
      .update({ stripe_synced_at: null, stripe_sync_error: message })
      .eq('id', plan.id).select('*').single()
    return { plan: data || plan, report: { synced: false, productId: plan.stripe_product_id, errors: CURRENCIES.map((currency) => ({ currency, message })) } }
  }
}

/** Retire a plan's product and prices. Used when a plan is deleted. */
export async function retireStripePlan(stripeProductId) {
  const { stripe } = stripeClient()
  if (!stripe || !stripeProductId) return
  // Stripe keeps the Product so any historic payment still resolves; it is only
  // closed to new checkouts. Deactivating a price leaves subscriptions that
  // already reference it untouched, but it stops a deleted plan's price from
  // ever being billed again — Stripe itself will not let a price be deleted once
  // it has been used.
  await stripe.products.update(stripeProductId, { active: false }).catch(() => {})
  const prices = await stripe.prices.list({ product: stripeProductId, limit: 100, active: true }).catch(() => null)
  for (const price of prices?.data || []) {
    await stripe.prices.update(price.id, { active: false }).catch(() => {})
  }
}
