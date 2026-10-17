// A way back in for a team member who cannot receive mail.
//
// The Team screen used to offer "Reset password", which called
// `resetPasswordForEmail` and reported that an email was sent. On a project with
// no SMTP provider configured that is a button that does nothing while saying it
// worked — the worst kind of broken, because the person waiting for the mail
// blames themselves. This endpoint does the part that always works: it mints a
// one-time recovery link the operator can hand over by chat, and the recipient
// chooses their own password on the platform's own recovery screen.
//
// Two rules keep this from being a way into an account:
//
//   * only an active `super_admin` may call it — support and billing cannot
//     hand out sign-in links
//   * the target must already be a row in `super_admins`, so this can never mint
//     a link for a restaurant owner or for an arbitrary Auth user id
//
// The link carries the token itself (the same shape the restaurant owner card
// uses), so it works on whatever host the panel is being used from and does not
// depend on the Supabase project's redirect allow-list.

import { admin } from '../_lib/admin.js'
import { redirectBase } from '../_lib/origin.js'
import { withinRateLimit } from '../_lib/rate-limit.js'
import { requireActor } from '../_lib/actor.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request, ['super_admin'])
  if (!actor?.isStaff) return response.status(403).json({ error: 'Only a Super Admin can create a sign-in link.' })
  if (!(await withinRateLimit(request, response, { route: 'team-reset-link', max: 30, actorId: actor.id }))) return

  const userId = typeof request.body?.userId === 'string' ? request.body.userId : ''
  if (!uuid.test(userId)) return response.status(400).json({ error: 'Choose the team member this link is for.' })

  const { data: member } = await admin
    .from('super_admins')
    .select('id, user_id, email, name, is_active')
    .eq('user_id', userId)
    .maybeSingle()
  if (!member) return response.status(404).json({ error: 'That account is not a member of this team.' })
  if (!member.is_active) return response.status(400).json({ error: 'Activate this member before creating a sign-in link — a deactivated account cannot use the panel.' })

  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: member.email })
  if (error) return response.status(502).json({ error: `A sign-in link could not be created: ${error.message}` })

  const tokenHash = link?.properties?.hashed_token || ''
  const base = redirectBase(request)
  const handover = tokenHash && base
    ? `${base}/admin/login?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`
    : ''
  if (!handover) return response.status(502).json({ error: 'A sign-in link could not be created for this address.' })

  const { data: staffRow } = await admin.from('super_admins').select('id').eq('user_id', actor.id).maybeSingle()
  await admin.from('activity_logs').insert({
    super_admin_id: staffRow?.id || null,
    action: 'team_reset_link_created',
    details: { email: member.email, name: member.name },
  })

  return response.status(200).json({
    email: member.email,
    // Single-use and time-limited: the recipient sets their own password, and
    // nothing here records it.
    link: handover,
    expiresInMinutes: 60,
  })
}
