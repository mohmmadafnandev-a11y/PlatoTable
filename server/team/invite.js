import { withinRateLimit } from '../_lib/rate-limit.js'
import { passwordError, suggestPassword } from '../../shared/slug.js'
import { admin } from '../_lib/admin.js'

const ROLES = ['super_admin', 'support', 'billing']
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// A Super Admin row references auth.users with ON DELETE CASCADE, so a team
// member is created and removed as an Auth user first. Creating the row alone
// would leave an account that can never sign in; deleting the row alone would
// leave a working login with no permissions, which is worse.

async function requireSuperAdmin(request) {
  const authorization = request.headers.authorization
  const token = typeof authorization === 'string' ? authorization.match(/^Bearer\s+(.+)$/i)?.[1] : null
  if (!token) return null

  const { data: { user }, error: userError } = await admin.auth.getUser(token)
  if (userError || !user) return null

  const { data: staff, error: staffError } = await admin
    .from('super_admins')
    .select('id, role, is_active, user_id')
    .eq('user_id', user.id)
    .maybeSingle()

  // Only a full super admin may manage the team; support and billing cannot.
  return !staffError && staff?.is_active && staff.role === 'super_admin' ? staff : null
}

/** Find an existing Auth user by email. The Admin API cannot filter, so page. */
async function findUserByEmail(email) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return null
    const match = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase())
    if (match) return match
    if (data.users.length < 200) return null
  }
  return null
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const caller = await requireSuperAdmin(request)
  if (!caller) return response.status(403).json({ error: 'Only an active Super Admin can manage the team.' })

  // Inviting creates an Auth user with a working password; removing deletes one.
  if (!(await withinRateLimit(request, response, { route: 'team-invite', max: 30, actorId: caller.user_id }))) return

  const body = request.body || {}
  const action = body.action === 'remove' ? 'remove' : 'invite'

  if (action === 'remove') {
    const targetId = typeof body.userId === 'string' ? body.userId : ''
    if (!targetId) return response.status(400).json({ error: 'A user id is required.' })
    if (targetId === caller.user_id) return response.status(400).json({ error: 'You cannot remove your own account.' })

    const { error } = await admin.auth.admin.deleteUser(targetId)
    if (error) return response.status(400).json({ error: error.message })
    return response.status(200).json({ removed: true })
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const role = ROLES.includes(body.role) ? body.role : null
  const password = typeof body.password === 'string' && body.password ? body.password : suggestPassword(16)

  if (!emailPattern.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' })
  if (!name) return response.status(400).json({ error: 'Enter the team member\u2019s name.' })
  if (!role) return response.status(400).json({ error: `Role must be one of: ${ROLES.join(', ')}.` })
  const passwordProblem = passwordError(password)
  if (passwordProblem) return response.status(400).json({ error: passwordProblem })

  const existing = await findUserByEmail(email)
  let userId = existing?.id || null

  if (existing) {
    // Re-inviting an existing account: reset the password rather than fail, and
    // make sure the address is confirmed so the new password actually works.
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true })
    if (error) return response.status(400).json({ error: error.message })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (error || !data?.user) return response.status(400).json({ error: error?.message || 'The account could not be created.' })
    userId = data.user.id
  }

  const { data: member, error: upsertError } = await admin
    .from('super_admins')
    .upsert({ user_id: userId, email, name, role, is_active: true }, { onConflict: 'user_id' })
    .select()
    .maybeSingle()

  if (upsertError) {
    // Do not leave an orphaned login behind if the row could not be written.
    if (!existing) await admin.auth.admin.deleteUser(userId)
    return response.status(400).json({ error: upsertError.message })
  }

  return response.status(200).json({ member, password, reusedExistingAccount: !!existing })
}
