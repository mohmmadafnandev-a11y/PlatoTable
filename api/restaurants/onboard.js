import { createClient } from '@supabase/supabase-js'
import { CURRENCIES, COUNTRY_CODES, passwordError, slugError } from '../../shared/slug.js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// The public base every tenant link is built from. VITE_CANONICAL_BASE_URL comes
// first because these are customer-facing links and it is the same variable the
// QR generator reads, so a printed code and a stored URL can never disagree;
// VITE_APP_URL is accepted as a fallback for environments that only set that.
const appUrl = (process.env.VITE_CANONICAL_BASE_URL || process.env.VITE_APP_URL || '').replace(/\/+$/, '')

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

  // Undo whatever this request managed to create, in reverse order. Deleting
  // the restaurant cascades to its subscription, settings, URLs, and admin row.
  const rollback = async () => {
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

    const body = request.body || {}
    const name = optionalText(body.name)
    const ownerName = optionalText(body.ownerName)
    const ownerEmail = optionalText(body.ownerEmail)?.toLowerCase()
    const ownerPassword = typeof body.ownerPassword === 'string' ? body.ownerPassword : ''
    const subdomain = optionalText(body.subdomain)?.toLowerCase()
    const phone = optionalText(body.phone)
    const currency = (optionalText(body.currency) || 'PKR').toUpperCase()
    const country = optionalText(body.country)
    const notes = optionalText(body.notes)
    const planId = optionalText(body.planId)
    const trialDays = body.trialDays === undefined ? 7 : Number(body.trialDays)
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

    if (!CURRENCIES.includes(currency)) {
      return response.status(400).json({ error: `Currency must be one of ${CURRENCIES.join(', ')}` })
    }

    if (country && !COUNTRY_CODES.includes(country)) {
      return response.status(400).json({ error: 'Choose a supported country' })
    }

    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
      return response.status(400).json({ error: 'Trial days must be a whole number between 0 and 365' })
    }

    if (planId && !uuidPattern.test(planId)) return response.status(400).json({ error: 'Plan is invalid' })

    if (customDomain && !domainPattern.test(customDomain)) {
      return response.status(400).json({ error: 'Enter a custom domain like menu.example.com, without http:// or a path' })
    }

    // Tenant links are derived, never hand-entered, so they cannot drift from
    // the routing scheme. Without a configured base the links are omitted
    // rather than guessed from the request host, which on a preview deployment
    // would be a preview URL.
    const adminUrl = appUrl ? `${appUrl}/admin/${subdomain}` : optionalText(body.adminUrl)
    const userUrl = appUrl ? `${appUrl}/${subdomain}` : optionalText(body.userUrl)

    if (![adminUrl, userUrl].every(validUrl)) {
      return response.status(400).json({ error: 'Admin and customer URLs must be valid HTTP(S) URLs' })
    }

    if (customDomain) {
      const { data: taken } = await admin.from('restaurant_urls').select('id').eq('custom_domain', customDomain).maybeSingle()
      if (taken) return response.status(409).json({ error: `${customDomain} is already mapped to another restaurant` })
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

    const subscriptionUpdate = trialDays > 0
      ? { trial_used_at: new Date().toISOString() }
      : { status: 'suspended', trial_used_at: new Date().toISOString() }
    const { error: subscriptionError } = await admin.from('subscriptions').update(subscriptionUpdate).eq('id', record.out_subscription_id)
    if (subscriptionError) throw subscriptionError

    // Returned once, for the hand-over panel. The password is not stored
    // anywhere by the platform, so this response is the only time it is visible.
    return response.status(201).json({
      restaurant: record,
      credentials: { email: ownerEmail, password: ownerPassword },
      links: { admin: adminUrl, menu: userUrl, customDomain: customDomain || null },
    })
  } catch (error) {
    await rollback()
    console.error('[onboard] unexpected failure:', error)
    return response.status(500).json({ error: 'Restaurant onboarding could not be completed' })
  }
}
