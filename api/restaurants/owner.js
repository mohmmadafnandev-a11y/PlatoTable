// The restaurant owner's sign-in details, changed from the platform side.
//
// Three things an operator needs when a restaurant cannot get into its own
// workspace, and each of them is an Auth operation that has to run with the
// service role:
//
//   setEmail     the owner changed their business address and cannot receive
//                mail at the old one
//   setPassword  the operator walks the owner through a new password over the
//                phone (the password is never stored or returned)
//   resetLink    generates a one-time recovery link to hand over, which works
//                even when this deployment has no working SMTP
//
// Everything here is super_admin only. A billing-role staff member can read the
// platform's money; changing somebody's credentials is a different kind of power.
//
// Guard rails, because this endpoint can take over an account:
//   * the target must be a *restaurant owner*, never platform staff — otherwise
//     a stray id turns into a platform takeover
//   * the account must actually be a member of the named restaurant
//   * a new password has to pass the same strength rule the onboarding form uses

import { passwordError } from '../../shared/slug.js'
import { admin } from '../_lib/admin.js'
import { redirectBase } from '../_lib/origin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { requireActor } from '../_lib/actor.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ACTIONS = ['setEmail', 'setPassword', 'resetLink']

/**
 * The account that owns this restaurant, refused when it is anything else.
 *
 * Returning the membership row means the caller cannot pass an arbitrary user
 * id: the only account this endpoint can touch is one already attached to the
 * restaurant in the request.
 */
async function ownerAccount(restaurantId) {
  const { data: members, error } = await admin
    .from('restaurant_admins')
    .select('user_id, username, is_active')
    .eq('restaurant_id', restaurantId)
  if (error) return { error: 'That restaurant\'s accounts could not be read.' }

  const ids = [...new Set((members || []).map((row) => row.user_id).filter(Boolean))]
  for (const userId of ids) {
    const { data: staff } = await admin.from('super_admins').select('id').eq('user_id', userId).maybeSingle()
    if (staff) continue
    return { userId, membership: members.find((row) => row.user_id === userId) }
  }
  return { error: 'No restaurant owner account is attached to this restaurant yet.' }
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request, ['super_admin'])
  if (!actor?.isStaff) return response.status(403).json({ error: 'Only a super admin can manage an owner account.' })
  // activity_logs points at the super_admins row, while the caller is identified
  // by their auth user id — the two are resolved rather than assumed equal.
  const { data: staffRow } = await admin.from('super_admins').select('id').eq('user_id', actor.id).maybeSingle()
  const superAdminId = staffRow?.id || null

  const { restaurantId, action } = request.body || {}
  if (!uuid.test(restaurantId || '')) return response.status(400).json({ error: 'A valid restaurant is required.' })
  if (!ACTIONS.includes(action)) return response.status(400).json({ error: 'Choose what to change about the owner account.' })

  // Credential changes are the most valuable thing a stolen session could reach,
  // so they are budgeted separately from the rest of the panel.
  if (!(await withinRateLimit(request, response, { route: 'restaurant-owner', max: 30, actorId: actor.id }))) return

  const { data: restaurant } = await admin
    .from('restaurants')
    .select('id, name, subdomain, owner_email')
    .eq('id', restaurantId)
    .maybeSingle()
  if (!restaurant) return response.status(404).json({ error: 'That restaurant no longer exists.' })

  const owner = await ownerAccount(restaurant.id)
  if (owner.error) return response.status(409).json({ error: owner.error })
  const { userId } = owner

  const { data: { user }, error: userError } = await admin.auth.admin.getUserById(userId)
  if (userError || !user) return response.status(404).json({ error: 'The owner account no longer exists in Auth.' })

  try {
    if (action === 'setEmail') {
      const email = String(request.body?.email || '').trim().toLowerCase()
      if (!emailPattern.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' })
      if (email === user.email) return response.status(400).json({ error: 'That is already the owner\'s email address.' })

      // `email_confirm` because the operator is making this change deliberately:
      // requiring the old address to confirm an email it can no longer receive
      // would leave the account unreachable.
      const { error } = await admin.auth.admin.updateUserById(userId, { email, email_confirm: true })
      if (error) {
        const taken = /already|registered|exists/i.test(error.message)
        return response.status(taken ? 409 : 502).json({ error: taken ? 'That email address already has an account. Use a different address or remove the other account first.' : `The email could not be changed: ${error.message}` })
      }

      // The restaurant row carries the address the panel shows and the address
      // invoices are described by; leaving it stale is how a screen ends up
      // disagreeing with the account that can actually sign in.
      await admin.from('restaurants').update({ owner_email: email, updated_at: new Date().toISOString() }).eq('id', restaurant.id)
      await admin.from('restaurant_admins').update({ username: email }).eq('user_id', userId).eq('restaurant_id', restaurant.id)
      await admin.from('activity_logs').insert({
        super_admin_id: superAdminId,
        restaurant_id: restaurant.id,
        action: 'owner_email_changed',
        details: { from: user.email, to: email },
      })

      return response.status(200).json({ email, previous: user.email })
    }

    if (action === 'setPassword') {
      const password = typeof request.body?.password === 'string' ? request.body.password : ''
      const problem = passwordError(password)
      if (problem) return response.status(400).json({ error: problem })

      const { error } = await admin.auth.admin.updateUserById(userId, { password })
      if (error) return response.status(502).json({ error: `The password could not be set: ${error.message}` })

      // The password itself is never stored, logged, or returned — only the fact
      // that it changed, which is what an audit trail needs.
      await admin.from('activity_logs').insert({
        super_admin_id: superAdminId,
        restaurant_id: restaurant.id,
        action: 'owner_password_set',
        details: { owner_email: user.email },
      })

      return response.status(200).json({ email: user.email, changed: true })
    }

    // resetLink: a one-time recovery link the operator can hand to the owner.
    // Works without SMTP, which is the state most deployments are in.
    //
    // The link we hand over is built HERE, not the `action_link` Supabase
    // returns. That link asks Supabase to bounce the owner to `redirect_to`,
    // which is rewritten to the project's Site URL unless our host is on the
    // project's redirect allow-list — so on localhost, or on a deployment the
    // dashboard has never heard of, it lands the owner somewhere that is not
    // running this app. Carrying the token ourselves removes that dependency:
    // the owner opens a link on the same host as the panel, and the login screen
    // exchanges the token for a session (see useRecoverySession).
    const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: user.email })
    if (error) return response.status(502).json({ error: `A reset link could not be created: ${error.message}` })

    const tokenHash = link?.properties?.hashed_token || ''
    const base = redirectBase(request)
    const handover = tokenHash && base
      ? `${base}/admin/${restaurant.subdomain}/login?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`
      : ''
    if (!handover) return response.status(502).json({ error: 'A reset link could not be created for this address.' })

    await admin.from('activity_logs').insert({
      super_admin_id: superAdminId,
      restaurant_id: restaurant.id,
      action: 'owner_password_reset_link_created',
      details: { owner_email: user.email },
    })

    return response.status(200).json({
      email: user.email,
      // Built from the request host, so it is usable wherever this endpoint is
      // being called from. Single-use, and it expires like any recovery link.
      link: handover,
      expiresInMinutes: 60,
    })
  } catch (error) {
    console.error('[restaurant-owner] unexpected failure', error)
    return response.status(500).json({ error: 'The owner account could not be updated.' })
  }
}
