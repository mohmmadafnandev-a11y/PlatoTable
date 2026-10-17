import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const subdomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const optionalText = (value) => typeof value === 'string' && value.trim() ? value.trim() : null
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
    const currency = optionalText(body.currency)?.toUpperCase() || 'PKR'
    const planId = optionalText(body.planId)
    const trialDays = body.trialDays === undefined ? 7 : Number(body.trialDays)
    const adminUrl = optionalText(body.adminUrl)
    const userUrl = optionalText(body.userUrl)
    const customDomain = optionalText(body.customDomain)

    if (!name || !ownerName || !ownerEmail || !subdomain || !emailPattern.test(ownerEmail)) return response.status(400).json({ error: 'Restaurant name, owner name, valid owner email, and subdomain are required' })
    if (!subdomainPattern.test(subdomain)) return response.status(400).json({ error: 'Subdomain must contain only lowercase letters, numbers, and hyphens' })
    if (ownerPassword.length < 12 || ownerPassword.length > 72) return response.status(400).json({ error: 'Owner password must be between 12 and 72 characters' })
    if (!['USD', 'AED', 'PKR'].includes(currency)) return response.status(400).json({ error: 'Currency must be USD, AED, or PKR' })
    if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) return response.status(400).json({ error: 'Trial days must be a whole number between 0 and 365' })
    if (planId && !uuidPattern.test(planId)) return response.status(400).json({ error: 'Plan is invalid' })
    if (![adminUrl, userUrl].every(validUrl)) return response.status(400).json({ error: 'Admin and user URLs must be valid HTTP(S) URLs' })

    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
      user_metadata: { name: ownerName },
    })
    if (createUserError || !createdUser.user) {
      if (createUserError?.message?.toLowerCase().includes('already')) return response.status(409).json({ error: 'An Auth user already exists for this owner email' })
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
    })

    if (onboardingError || !onboarding?.[0]) throw onboardingError || new Error('Onboarding transaction returned no result')

    const subscriptionUpdate = trialDays > 0
      ? { trial_used_at: new Date().toISOString() }
      : { status: 'suspended', trial_used_at: new Date().toISOString() }
    const { error: subscriptionError } = await admin.from('subscriptions').update(subscriptionUpdate).eq('id', onboarding[0].subscription_id)
    if (subscriptionError) throw subscriptionError

    return response.status(201).json({ restaurant: onboarding[0] })
  } catch {
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId)
    return response.status(500).json({ error: 'Restaurant onboarding could not be completed' })
  }
}
