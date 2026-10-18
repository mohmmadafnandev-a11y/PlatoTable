import { COUNTRY_CODES, CURRENCY, passwordError, slugError } from '../../shared/slug.js'
import { customPlanError } from '../../shared/plans.js'
import { createCustomPlan } from '../_lib/custom-plan.js'
import { linkBase } from '../_lib/origin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { retireSafepayPlans } from '../_lib/safepay-plans.js'
import { admin } from '../_lib/admin.js'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const domainPattern = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/

const optionalText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)

const validUrl = (value) => {
  if (!value) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch { return false }
}

async function requireSuperAdmin(request) {
  const authorization = request.headers.authorization
  const token = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : null
  if (!token) return null

  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user) return null

  const { data: staff, error: staffError } = await admin
    .from('super_admins')
    .select('id, role, is_active')
    .eq('user_id', user.id)
    .maybeSingle()

  return !staffError && staff?.is_active && staff.role === 'super_admin' ? staff : null
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  let ownerUserId = null
  // Set only once the database has created the tenant, so a later failure can
  // undo it. Without this, a failed onboarding left a restaurant behind with no
  // owner account at all: deleting the Auth user cascades to restaurant_admins
  // but never removes the restaurant, so the tenant occupied its slug with no
  // way to sign in to it.
  let createdRestaurantId = null
  // A bespoke plan is created before the owner account, so a failure later has to
  // remove it too — otherwise a failed attempt leaves an orphan plan in the
  // catalogue list that no restaurant is on.
  let createdPlanId = null
  let createdPlanSynced = false

  // Undo whatever this request managed to create, in reverse order. Deleting
  // the restaurant cascades to its subscription, settings, URLs, and admin row.
  const rollback = async () => {
    if (createdPlanId) {
      // The Safepay plans are read before the row goes: closing them needs the
      // tokens, and the tokens live on the row. A plan this young has no
      // payments behind it, so closing it is safe — leaving it active would keep
      // it sellable by anyone holding the id.
      const { data: planRow } = await admin
        .from('subscription_plans')
        .select('id, name, safepay_plan_id, safepay_plan_id_trial')
        .eq('id', createdPlanId)
        .maybeSingle()
      const { error } = await admin.from('subscription_plans').delete().eq('id', createdPlanId)
      if (error) console.error('[onboard] rollback could not remove custom plan', createdPlanId, error.message)
      if (planRow) await retireSafepayPlans(planRow)
      createdPlanId = null
    }
    if (createdRestaurantId) {
      const { error } = await admin.from('restaurants').delete().eq('id', createdRestaurantId)
      if (error) console.error('[onboard] rollback could not remove restaurant', createdRestaurantId, error.message)
      createdRestaurantId = null
    }
    if (ownerUserId) {
      await admin.auth.admin.deleteUser(ownerUserId)
      ownerUserId = null
    }
  }

  try {
    const superAdmin = await requireSuperAdmin(request)
    if (!superAdmin) return response.status(403).json({ error: 'Not authorized' })

    // One onboarding creates an Auth user, a restaurant, and possibly a Safepay
    // plan, so this is the most expensive endpoint on the platform and the one
    // worth capping hardest.
    if (!(await withinRateLimit(request, response, { route: 'restaurant-onboard', max: 20, actorId: superAdmin.user_id }))) return

    const body = request.body || {}
    const name = optionalText(body.name)
    const ownerName = optionalText(body.ownerName)
    const ownerEmail = optionalText(body.ownerEmail)?.toLowerCase()
    const ownerPassword = typeof body.ownerPassword === 'string' ? body.ownerPassword : ''
    const subdomain = optionalText(body.subdomain)?.toLowerCase()
    const phone = optionalText(body.phone)
    // Not read from the request. The platform prices and bills in one currency,
    // so a stale form — or a hand-made request — must not be able to open a
    // second one. Country is still taken from the form; it identifies the market,
    // not the money.
    const currency = CURRENCY
    const country = optionalText(body.country)
    const notes = optionalText(body.notes)
    const requestedPlanId = optionalText(body.planId)
    // A bespoke plan replaces the catalogue choice: it is created here, from the
    // period and price the operator typed, instead of being picked from the list.
    const customPlan = body.customPlan && typeof body.customPlan === 'object' ? body.customPlan : null
    // `let`, because a bespoke plan carries its own trial length and overrides
    // the form's toggle once it exists (see the custom-plan block below).
    let trialDays = body.trialDays === undefined ? 7 : Number(body.trialDays)
    // Free days after the trial or the paid period ends, before the sweep
    // suspends the restaurant. Chosen here, editable from the panels later.
    const backupDays = body.backupDays === undefined || body.backupDays === null || body.backupDays === ''
      ? 0
      : Number(body.backupDays)
    const customDomain = optionalText(body.customDomain)?.toLowerCase()

    if (!name || !ownerName || !ownerEmail || !emailPattern.test(ownerEmail)) {
      return response.status(400).json({ error: 'Restaurant name, owner name, and a valid owner email are required' })
    }

    // Shared with the onboarding form, the router, and the database constraint,
    // so a slug that reaches here has already passed the same rules everywhere.
    const slugProblem = slugError(subdomain)
    if (slugProblem) return response.status(400).json({ error: slugProblem })

    const passwordProblem = passwordError(ownerPassword)
    if (passwordProblem) return response.status(400).json({ error: passwordProblem })

    if (country && !COUNTRY_CODES.includes(country)) {
      return response.status(400).json({ error: 'Choose a supported country' })
    }

    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
      return response.status(400).json({ error: 'Trial days must be a whole number between 0 and 365' })
    }

    if (!Number.isInteger(backupDays) || backupDays < 0 || backupDays > 365) {
      return response.status(400).json({ error: 'Backup days must be a whole number between 0 and 365' })
    }

    if (requestedPlanId && !uuidPattern.test(requestedPlanId)) return response.status(400).json({ error: 'Plan is invalid' })

    // Validated before anything is created, because the alternative is an owner
    // account and a restaurant that exist only to be rolled back.
    if (customPlan) {
      const problem = customPlanError({
        days: customPlan.days,
        price: customPlan.price,
        trialDays: customPlan.trialDays ?? trialDays,
        currency,
      })
      if (problem) return response.status(400).json({ error: problem })
    }

    if (customDomain && !domainPattern.test(customDomain)) {
      return response.status(400).json({ error: 'Enter a custom domain like menu.example.com, without http:// or a path' })
    }

    // Tenant links are derived, never hand-entered, so they cannot drift from
    // the routing scheme. The host comes from the request that created the
    // restaurant, so a restaurant created in the local admin panel is handed
    // back localhost links rather than a link to a deployment it does not exist
    // on yet. The configured canonical base is only the fallback for a request
    // with no usable host.
    const base = linkBase(request)
    const adminUrl = base ? `${base}/admin/${subdomain}` : optionalText(body.adminUrl)
    const userUrl = base ? `${base}/${subdomain}` : optionalText(body.userUrl)

    if (![adminUrl, userUrl].every(validUrl)) {
      return response.status(400).json({ error: 'Admin and customer URLs must be valid HTTP(S) URLs' })
    }

    if (customDomain) {
      const { data: taken } = await admin.from('restaurant_urls').select('id').eq('custom_domain', customDomain).maybeSingle()
      if (taken) return response.status(409).json({ error: `${customDomain} is already mapped to another restaurant` })
    }

    // The bespoke plan first, so its id can be handed to the onboarding RPC in
    // the same call that creates the subscription.
    let planId = requestedPlanId
    if (customPlan) {
      const created = await createCustomPlan(admin, {
        restaurantName: name,
        currency,
        days: customPlan.days,
        price: customPlan.price,
        trialDays: customPlan.trialDays ?? trialDays,
      })
      if (created.error) return response.status(400).json({ error: created.error })
      createdPlanId = created.plan.id
      createdPlanSynced = Boolean(created.plan.safepay_plan_id || created.plan.safepay_plan_id_trial)
      planId = created.plan.id
      // A bespoke plan decides its own trial, so the operator's "trial" toggle is
      // already folded into it rather than being applied twice.
      if (customPlan.trialDays !== undefined) trialDays = Number(customPlan.trialDays) || 0
    }

    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { name: ownerName },
    })
    if (createUserError || !createdUser.user) {
      if (createUserError?.message?.toLowerCase().includes('already')) {
        return response.status(409).json({ error: 'An account already exists for this owner email. Use a different email or reset that account’s password.' })
      }
      return response.status(502).json({ error: 'Could not create the restaurant owner account' })
    }

    ownerUserId = createdUser.user.id
    const { data: onboarding, error: onboardingError } = await admin.rpc('onboard_restaurant', {
      p_name: name,
      p_subdomain: subdomain,
      p_owner_email: ownerEmail,
      p_owner_user_id: ownerUserId,
      p_phone: phone,
      p_currency: currency,
      p_plan_id: planId,
      p_trial_days: trialDays,
      p_admin_url: adminUrl,
      p_user_url: userUrl,
      p_custom_domain: customDomain,
      p_super_admin_id: superAdmin.id,
      p_country: country,
      p_notes: notes,
    })

    if (onboardingError) {
      await rollback()
      // A failed onboarding must leave a trace: the caller only ever sees a
      // terse message, and without this a 500 here is undebuggable.
      console.error('[onboard] onboard_restaurant failed:', onboardingError.code, onboardingError.message)
      // The pricing and validation guards in the RPC raise deliberately
      // informative messages ("The Basic plan has no GBP price configured").
      // Passing those through is the difference between a fixable form error
      // and an unexplained failure.
      const message = onboardingError.code === 'P0001' || /^[A-Z].*\.$|no .* price|reserved|already in use|not active/i.test(onboardingError.message || '')
        ? onboardingError.message
        : 'Restaurant onboarding could not be completed'
      return response.status(onboardingError.code === 'P0001' ? 400 : 500).json({ error: message })
    }

    const record = Array.isArray(onboarding) ? onboarding[0] : onboarding
    // The tenant exists from here on, so every later failure must remove it too.
    createdRestaurantId = record?.out_restaurant_id || null
    if (!createdRestaurantId) {
      await rollback()
      return response.status(500).json({ error: 'Restaurant onboarding returned no result' })
    }

    // `trial_used_at` records that the free trial has been spent, so it can only
    // ever be offered once per restaurant. The backup window travels with it.
    const subscriptionUpdate = trialDays > 0
      ? { trial_used_at: new Date().toISOString() }
      : { status: 'suspended', trial_used_at: new Date().toISOString() }
    // The backup_days column arrives with migration 024; until it is applied the
    // onboarding still succeeds and simply keeps the platform-wide grace, rather
    // than failing an onboarding an owner has already been created for.
    let { error: subscriptionError } = await admin
      .from('subscriptions')
      .update({ ...subscriptionUpdate, backup_days: backupDays })
      .eq('id', record.out_subscription_id)
    if (subscriptionError && /backup_days/.test(subscriptionError.message || '')) {
      console.warn('[onboard] backup_days column is missing — run migration 024 to record backup windows')
      ;({ error: subscriptionError } = await admin.from('subscriptions').update(subscriptionUpdate).eq('id', record.out_subscription_id))
    }
    if (subscriptionError) throw subscriptionError

    // Returned once, for the hand-over panel. The password is not stored
    // anywhere by the platform, so this response is the only time it is visible.
    return response.status(201).json({
      restaurant: record,
      credentials: { email: ownerEmail, password: ownerPassword },
      links: { admin: adminUrl, menu: userUrl, customDomain: customDomain || null },
      customPlan: createdPlanId ? { id: createdPlanId, safepaySynced: createdPlanSynced } : null,
    })
  } catch (error) {
    await rollback()
    console.error('[onboard] unexpected failure:', error)
    return response.status(500).json({ error: 'Restaurant onboarding could not be completed' })
  }
}
