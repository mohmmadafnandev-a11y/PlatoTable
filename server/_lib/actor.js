// Who is allowed to touch a restaurant's billing.
//
// Several endpoints ask the same question — Safepay checkout, the subscription
// manager, attach, and the reconcile that lands a payment — and every copy of an
// authorisation rule is a chance for one of them to be weaker than the others. In
// particular the rule that matters: a restaurant admin may only ever act on the
// restaurant they belong to, so an id sent from the browser is ignored in favour of
// their membership rather than trusted.

import { admin } from './admin.js'

// Re-exported: every existing caller imports `admin` from this module, and the
// client itself now lives in ./admin.js so non-billing helpers can share it.
export { admin }

/**
 * Resolves the caller, or null when nobody is signed in.
 *
 * `roles` is the set of staff roles this endpoint accepts; a restaurant admin is
 * always accepted, and is always scoped to their own restaurant.
 */
export async function requireActor(request, roles = ['super_admin', 'billing']) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const { data: { user } } = await admin.auth.getUser(token)
  if (!user) return null

  const [{ data: staff }, { data: membership }] = await Promise.all([
    admin.from('super_admins').select('id, role, is_active').eq('user_id', user.id).maybeSingle(),
    admin.from('restaurant_admins').select('restaurant_id, is_active').eq('user_id', user.id).maybeSingle(),
  ])

  const isStaff = Boolean(staff?.is_active && roles.includes(staff.role))
  return {
    id: user.id,
    isStaff,
    // Their own restaurant, if they administer one. This is the only restaurant a
    // non-staff caller is ever allowed to touch.
    restaurantId: membership?.is_active ? membership.restaurant_id : null,
    label: isStaff ? `staff:${staff.role}` : 'restaurant admin',
  }
}

/**
 * Which restaurant this call is about.
 *
 * Staff may name any restaurant; everyone else is answered with the restaurant they
 * belong to, whatever the request said.
 */
export const restaurantFor = (actor, requested) => (actor.isStaff ? requested : actor.restaurantId)
