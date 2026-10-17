// Both sign-in screens accept both audiences and then ask this one question:
// which surface does the account belong to?
//
// Without it, an owner who opens /admin/login authenticated successfully and
// then died on the platform-staff check ("Super Admin access has not been
// configured yet") with no way forward, while platform staff who opened a
// restaurant's own sign-in URL were told they did not manage that restaurant.
// Resolving the identity once, here, keeps the two screens from disagreeing and
// means neither of them ever renders the other's workspace.
//
// The client is passed in rather than imported: the Super Admin and the
// restaurant admin each hold their own Supabase client, and asking the wrong one
// returns an anonymous answer — an empty result set that reads exactly like
// "this account has no access".
//
// Returns one of:
//   { kind: 'staff' }                  active platform administrator
//   { kind: 'staff-inactive' }         platform administrator whose row is off
//   { kind: 'owner', slug }            active restaurant administrator
//   { kind: 'none' }                   signed in, but attached to nothing
export async function resolveAccountDestination(client, userId) {
  if (!client || !userId) return { kind: 'none' }

  // Read in parallel: a staff account has no restaurant row and an owner has no
  // staff row, so serialising these would add a round trip to every sign-in.
  const [staffResult, membershipResult] = await Promise.all([
    client.from('super_admins').select('id, is_active').eq('user_id', userId).maybeSingle(),
    client
      .from('restaurant_admins')
      .select('restaurant_id, is_active, restaurants!inner(subdomain)')
      .eq('user_id', userId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
  ])

  const staff = staffResult.data
  if (staff?.is_active) return { kind: 'staff' }

  // A suspended restaurant is still this owner's workspace: it is the one place
  // they can add a card and renew, and the workspace itself already restricts a
  // suspended account to its billing pages. The restaurant's own `is_active` was
  // read here and treated as "attached to nothing", which signed those owners
  // straight back out with "manages no restaurant yet" — closing the only route
  // out of suspension. What decides this answer is the membership, not whether
  // the menu is currently live.
  const slug = membershipResult.data?.restaurants?.subdomain || ''
  if (slug) return { kind: 'owner', slug }

  return { kind: staff ? 'staff-inactive' : 'none' }
}
