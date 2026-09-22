import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'
import { CURRENCIES, PRICE_COLUMNS, featureList, planError, stripePriceColumn, toMinorUnits } from '../../shared/plans.js'


const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// The whole point of this endpoint: a plan is only real once Stripe knows about
// it. Prices are immutable in Stripe — changing an amount means creating a new
// Price and deactivating the old one — so this module owns that dance rather
// than leaving it to whichever caller happens to run first.
//
// Two principles run through it:
//
//  1. The database row is written BEFORE Stripe is called. An operator who typed
//     a plan must not lose it because Stripe was unreachable or refused one
//     currency. Synchronisation is then reported honestly, per currency.
//
//  2. Partial success is normal and is not hidden. Stripe rejects currencies an
//     account cannot process, so a plan can legitimately end up priced in USD
//     and AED but not PKR. That is recorded in `stripe_sync_error` and shown on
//     the screen, instead of a blanket failure that hides which part worked.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Support and billing roles may read the catalog; only these two may change it. */
async function requireBillingStaff(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null
  const { data } = await admin.from('super_admins').select('id, role, is_active, name, email').eq('user_id', user.id).maybeSingle()
  return data?.is_active && ['super_admin', 'billing'].includes(data.role) ? data : null
}

/**
 * A missing secret is by far the most likely reason nothing reaches Stripe, and
 * the generic Stripe message for it ("Invalid API key") sends you looking in the
 * wrong place. Say the actual thing.
 */
function stripeClient() {
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
async function syncPlanToStripe(stripe, plan) {
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
    if (amount === null || amount === undefined || amount === '') {
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

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const staff = await requireBillingStaff(request)
  if (!staff) return response.status(403).json({ error: 'Only a super admin or billing operator can manage plans.' })

  const { action = 'save', plan } = request.body || {}

  try {
    if (action === 'delete') {
      const id = plan?.id
      if (!uuid.test(id || '')) return response.status(400).json({ error: 'A valid plan is required.' })

      // Deleting a plan a restaurant is billed on would orphan its subscription
      // and blank out its price on the billing screens. Deactivate instead.
      const { count, error: countError } = await admin
        .from('subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', id)
      if (countError) throw countError
      if (count) return response.status(409).json({ error: `${count} restaurant${count === 1 ? ' is' : 's are'} on this plan. Deactivate it instead so their billing history stays intact.` })

      const { data: existing } = await admin.from('subscription_plans').select('id, name, stripe_product_id').eq('id', id).maybeSingle()
      if (!existing) return response.status(404).json({ error: 'That plan no longer exists.' })

      const { error } = await admin.from('subscription_plans').delete().eq('id', id)
      if (error) throw error

      // Stripe keeps the Product so any historic payment still resolves; it is
      // only closed to new checkouts.
      const { stripe } = stripeClient()
      if (stripe && existing.stripe_product_id) {
        await stripe.products.update(existing.stripe_product_id, { active: false }).catch(() => {})
        // Retire its prices as well. Deactivating a price leaves subscriptions
        // that already reference it untouched, but it stops a deleted plan's
        // price from ever being billed again — Stripe itself will not let a
        // price be deleted once it has been used.
        const prices = await stripe.prices.list({ product: existing.stripe_product_id, limit: 100, active: true }).catch(() => null)
        for (const price of prices?.data || []) {
          await stripe.prices.update(price.id, { active: false }).catch(() => {})
        }
      }

      await admin.from('activity_logs').insert({
        super_admin_id: staff.id,
        action: 'plan.deleted',
        details: { plan_id: id, name: existing.name, stripe_product_id: existing.stripe_product_id },
      })
      return response.status(200).json({ deleted: true, id })
    }

    if (action !== 'save') return response.status(400).json({ error: `Unknown action "${action}".` })

    // Validate the caller's own values BEFORE normalising them. Coercing an
    // unknown interval to 'month' first would silently accept a typo such as
    // "week" and store a monthly plan nobody asked for — the validator has to
    // see the raw request to be able to refuse it.
    const problem = planError({
      ...plan,
      name: String(plan?.name ?? '').trim(),
      interval: plan?.interval ?? 'month',
      interval_count: plan?.interval_count,
      trial_days: plan?.trial_days,
    })
    if (problem) return response.status(400).json({ error: problem })

    // Only now normalise, so '' and '19' behave the same as 19 downstream.
    const input = {
      id: uuid.test(plan?.id || '') ? plan.id : null,
      name: String(plan?.name ?? '').trim(),
      interval: plan.interval === 'year' ? 'year' : 'month',
      interval_count: Number(plan.interval_count ?? 1),
      trial_days: Number(plan.trial_days ?? 0),
      is_active: plan?.is_active !== false,
      features: featureList(plan?.features),
      prices: {},
    }
    for (const currency of CURRENCIES) {
      const raw = plan?.[PRICE_COLUMNS[currency]]
      input.prices[currency] = raw === null || raw === undefined || raw === '' ? null : Number(raw)
    }

    const record = {
      name: input.name,
      interval: input.interval,
      interval_count: input.interval_count,
      trial_days: input.trial_days,
      is_active: input.is_active,
      features: input.features,
      updated_at: new Date().toISOString(),
    }
    // duration_days is derived by the database trigger; send the value the trigger
    // will compute anyway so the returned row is correct on the insert path too.
    record.duration_days = input.interval === 'year' ? 365 * input.interval_count : 30 * input.interval_count
    for (const currency of CURRENCIES) record[PRICE_COLUMNS[currency]] = input.prices[currency]

    // The unique index on lower(name) turns a duplicate into a real error rather
    // than two Stripe products sharing one name.
    let saved
    if (input.id) {
      const { data, error } = await admin.from('subscription_plans').update(record).eq('id', input.id).select('*').single()
      if (error) throw error
      saved = data
    } else {
      const { data, error } = await admin.from('subscription_plans').insert(record).select('*').single()
      if (error) throw error
      saved = data
    }

    // Now Stripe. A failure here is reported, never thrown: the plan the operator
    // typed is already saved and must not be rolled back behind their back.
    const { stripe, error: keyError } = stripeClient()
    let stripeReport = { synced: false, productId: saved.stripe_product_id, errors: [] }
    if (keyError) {
      stripeReport.errors = CURRENCIES.map((currency) => ({ currency, message: keyError }))
    } else if (!CURRENCIES.some((currency) => saved[PRICE_COLUMNS[currency]] !== null && saved[PRICE_COLUMNS[currency]] !== undefined)) {
      stripeReport.errors = [{ currency: '—', message: 'No currency has a price, so there was nothing to send to Stripe.' }]
    } else {
      try {
        const result = await syncPlanToStripe(stripe, saved)
        stripeReport = {
          synced: result.errors.length === 0,
          productId: result.productId,
          errors: result.errors,
        }
        const patch = { stripe_product_id: result.productId, ...result.priceIds }
        // Only claim a sync when every currency actually landed.
        patch.stripe_synced_at = result.errors.length === 0 ? new Date().toISOString() : null
        patch.stripe_sync_error = result.errors.length
          ? result.errors.map((error) => `${error.currency}: ${error.message}`).join(' · ')
          : null
        const { data: synced, error } = await admin.from('subscription_plans').update(patch).eq('id', saved.id).select('*').single()
        if (error) throw error
        saved = synced
      } catch (error) {
        const message = error?.message || 'Stripe could not be reached.'
        stripeReport.errors = CURRENCIES.map((currency) => ({ currency, message }))
        const { data: failed, error: writeError } = await admin.from('subscription_plans')
          .update({ stripe_synced_at: null, stripe_sync_error: message })
          .eq('id', saved.id).select('*').single()
        if (!writeError) saved = failed
      }
    }

    await admin.from('activity_logs').insert({
      super_admin_id: staff.id,
      action: input.id ? 'plan.updated' : 'plan.created',
      details: {
        plan_id: saved.id,
        name: saved.name,
        interval: saved.interval,
        interval_count: saved.interval_count,
        stripe_product_id: saved.stripe_product_id,
        stripe_synced: stripeReport.synced,
        stripe_errors: stripeReport.errors,
      },
    })

    return response.status(200).json({ plan: saved, stripe: stripeReport })
  } catch (error) {
    // A unique-name violation is a user mistake, not a server fault, so it earns
    // a 409 and a sentence a person can act on.
    if (error?.code === '23505') return response.status(409).json({ error: `A plan called “${plan?.name?.trim()}” already exists. Plan names must be unique.` })
    console.error('[plans] failed:', error)
    return response.status(500).json({ error: error?.message || 'The plan could not be saved.' })
  }
}
