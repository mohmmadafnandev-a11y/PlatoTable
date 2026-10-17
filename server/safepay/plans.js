import { CURRENCIES, PRICE_COLUMNS, featureList, planDurationDays, planError, withLegacyPricesZeroed } from '../../shared/plans.js'
import { admin } from '../_lib/admin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { retireSafepayPlans, syncSavedPlan } from '../_lib/safepay-plans.js'

// The whole point of this endpoint: a plan is only real once Safepay can charge
// for it. Prices are immutable there — changing an amount means creating a new
// plan and retiring the old one — so this module owns that dance rather than
// leaving it to whichever caller happens to run first.
//
// Two principles run through it:
//
//  1. The database row is written BEFORE Safepay is called. An operator who
//     typed a plan must not lose it because Safepay was unreachable.
//     Synchronisation is then reported honestly, and the checkout refuses a plan
//     whose token is stale rather than charging the old price.
//
//  2. Safepay's own refusals are reported rather than hidden. They land in
//     `safepay_sync_error` and on the screen, instead of a blanket failure that
//     hides which part worked.

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

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const staff = await requireBillingStaff(request)
  if (!staff) return response.status(403).json({ error: 'Only a super admin or billing operator can manage plans.' })

  // Saving a plan creates or retires Safepay plans.
  if (!(await withinRateLimit(request, response, { route: 'safepay-plans', max: 60, actorId: staff.id }))) return

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

      const { data: existing } = await admin
        .from('subscription_plans')
        .select('id, name, safepay_plan_id, safepay_plan_id_trial')
        .eq('id', id)
        .maybeSingle()
      if (!existing) return response.status(404).json({ error: 'That plan no longer exists.' })

      const { error } = await admin.from('subscription_plans').delete().eq('id', id)
      if (error) throw error

      await retireSafepayPlans(existing)

      await admin.from('activity_logs').insert({
        super_admin_id: staff.id,
        action: 'plan.deleted',
        details: {
          plan_id: id,
          name: existing.name,
          safepay_plan_id: existing.safepay_plan_id,
          safepay_plan_id_trial: existing.safepay_plan_id_trial,
        },
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

    const isCustom = plan?.is_custom === true || plan?.is_custom === 'true'
    const input = {
      id: uuid.test(plan?.id || '') ? plan.id : null,
      name: String(plan?.name ?? '').trim(),
      interval: ['day', 'month', 'year'].includes(plan.interval) ? plan.interval : 'month',
      interval_count: Number(plan.interval_count ?? 1),
      trial_days: Number(plan.trial_days ?? 0),
      is_active: plan?.is_active !== false,
      is_custom: isCustom,
      is_public: !(plan?.is_public === false || plan?.is_public === 'false'),
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
      is_custom: input.is_custom,
      is_public: input.is_public,
      features: input.features,
      updated_at: new Date().toISOString(),
    }
    // duration_days is derived by the database trigger; send the value the trigger
    // will compute anyway so the returned row is correct on the insert path too.
    record.duration_days = planDurationDays(input.interval, input.interval_count)
    for (const currency of CURRENCIES) record[PRICE_COLUMNS[currency]] = input.prices[currency]
    // Anything the platform used to sell in is written as 0, never left at the
    // column's default or at a figure an older save stored.
    withLegacyPricesZeroed(record)

    // The unique index on lower(name) turns a duplicate into a real error rather
    // than two Safepay plans sharing one name.
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

    // Now Safepay. A failure here is reported, never thrown: the plan the
    // operator typed is already saved and must not be rolled back behind their
    // back.
    const { plan: synced, report } = await syncSavedPlan(admin, saved)
    saved = synced

    await admin.from('activity_logs').insert({
      super_admin_id: staff.id,
      action: input.id ? 'plan.updated' : 'plan.created',
      details: {
        plan_id: saved.id,
        name: saved.name,
        interval: saved.interval,
        interval_count: saved.interval_count,
        safepay_plan_id: saved.safepay_plan_id,
        safepay_plan_id_trial: saved.safepay_plan_id_trial,
        safepay_synced: report.synced,
        safepay_errors: report.errors,
      },
    })

    return response.status(200).json({ plan: saved, safepay: report })
  } catch (error) {
    // A unique-name violation is a user mistake, not a server fault, so it earns
    // a 409 and a sentence a person can act on.
    if (error?.code === '23505') return response.status(409).json({ error: `A plan called “${plan?.name?.trim()}” already exists. Plan names must be unique.` })
    console.error('[safepay/plans] failed:', error)
    return response.status(500).json({ error: error?.message || 'The plan could not be saved.' })
  }
}
