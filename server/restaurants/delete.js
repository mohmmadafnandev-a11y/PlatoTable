// Removing a restaurant, in the two ways an operator actually needs.
//
//   erase  — "this tenant should never have existed". Every row of theirs, the
//            images they uploaded, the money ledger they wrote, and the owner
//            account. Nothing is left to point at.
//
//   detach — "this tenant is gone, but the payments happened". The restaurant
//            row goes, its own data goes with it, and the ledger survives with
//            its restaurant_id nulled and the name copied onto each row. That is
//            what migration 017 made possible: before it, deleting a restaurant
//            deleted its payment history, because the column could not be null.
//
// Both modes forget the Safepay payer first. A tenant that has been deleted from
// the panel but whose card Safepay would still charge is the worst outcome here,
// so a Safepay failure stops the deletion rather than proceeding past it. Since
// the platform bills its own subscriptions (there is no Safepay subscription
// object to cancel), "forget the payer" means deleting the merchant-managed
// customer: the saved card lives in their wallet, and the customer going takes the
// card with it.
//
// Deletion is a two-step operation on purpose: the restaurant must be suspended
// first, and the operator must type its subdomain to confirm. Both are enforced
// here rather than only in the dialog, because this endpoint is reachable
// directly with a session token.

import { withinRateLimit } from '../_lib/rate-limit.js'
import { admin, requireActor } from '../_lib/actor.js'
import { deleteCustomer, safepayProblems } from '../_lib/safepay.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BUCKET = 'menu-images'
const MODES = ['erase', 'detach']

// Rows whose restaurant_id is ON DELETE SET NULL: they outlive the restaurant
// unless this request removes them itself. Read from the schema, not assumed.
const LEDGER_TABLES = ['payment_transactions', 'wallet_transactions', 'activity_logs']

const countRows = async (table, restaurantId) => {
  const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId)
  if (error) {
    console.error(`[restaurant-delete] could not count ${table}`, error.message)
    return 0
  }
  return count || 0
}

const countMenuImages = async (restaurantId) => {
  const { data, error } = await admin.storage.from(BUCKET).list(restaurantId, { limit: 1000 })
  return error ? 0 : (data || []).filter((entry) => entry.id).length
}

// Empty one restaurant's folder in the image bucket. Objects are stored under
// `${restaurantId}/...`, so the prefix is the whole footprint. Folders are
// descended into recursively; `id` is present on files only.
//
// Everything is listed before anything is removed: `list` takes an offset, and
// removing as it goes would shift the rows out from under the next page. A
// restaurant with a large menu is one page away from leaving files behind, so
// the listing loops until a short page arrives.
async function collectImages(prefix, found = []) {
  const pageSize = 1000
  let offset = 0
  for (;;) {
    const { data, error } = await admin.storage.from(BUCKET).list(prefix, { limit: pageSize, offset })
    if (error) throw error
    const entries = data || []
    for (const entry of entries) {
      const path = `${prefix}/${entry.name}`
      if (entry.id) found.push(path)
      else await collectImages(path, found)
    }
    if (entries.length < pageSize) break
    offset += pageSize
  }
  return found
}

async function clearImages(prefix) {
  const files = await collectImages(prefix)
  // Removed in chunks: the Storage API takes the whole list in one call, and a
  // thousands-long statement is not worth sending.
  for (let index = 0; index < files.length; index += 500) {
    const { error } = await admin.storage.from(BUCKET).remove(files.slice(index, index + 500))
    if (error) throw error
  }
  return files.length
}

// A card that keeps working for a deleted tenant is the one thing this endpoint
// must never leave behind. The deletion is idempotent: a customer Safepay no
// longer knows about counts as removed rather than as a failure.
async function forgetSafepayPayer(customerId) {
  const problems = safepayProblems()
  if (problems.length) {
    return { removed: false, warning: `${problems.join(', ')} is not set for this deployment, so the card held for this restaurant could not be removed. Delete the customer in the Safepay dashboard.` }
  }
  const result = await deleteCustomer(customerId)
  if (result.deleted) return { removed: true }
  return { removed: false, error: result.error || 'Safepay could not be reached.' }
}

/**
 * Owner accounts that exist only because of this restaurant.
 *
 * An account is left alone when it belongs to platform staff, or when it also
 * administers another restaurant — deleting it would lock someone out of a
 * tenant that still exists. Everything else is this restaurant's account and
 * goes with it, in `erase` mode only: `detach` keeps the person so the operator
 * can re-onboard the same email.
 */
async function ownerAccountsToRemove(restaurantId) {
  const { data: members, error } = await admin.from('restaurant_admins').select('user_id').eq('restaurant_id', restaurantId)
  if (error) {
    console.error('[restaurant-delete] could not read restaurant admins', error.message)
    return []
  }
  const unique = [...new Set((members || []).map((row) => row.user_id).filter(Boolean))]
  const removable = []
  for (const userId of unique) {
    const [{ data: staff }, { data: others }] = await Promise.all([
      admin.from('super_admins').select('id').eq('user_id', userId).maybeSingle(),
      admin.from('restaurant_admins').select('restaurant_id').eq('user_id', userId).neq('restaurant_id', restaurantId).limit(1),
    ])
    if (!staff && !(others || []).length) removable.push(userId)
  }
  return removable
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request, ['super_admin'])
  if (!actor?.isStaff) return response.status(403).json({ error: 'Only a super admin can delete a restaurant.' })
  // requireActor identifies the caller by their auth user id; activity_logs
  // points at the super_admins row instead, so the two are resolved separately
  // rather than assumed to be the same value.
  const { data: staffRow } = await admin.from('super_admins').select('id').eq('user_id', actor.id).maybeSingle()

  if (!(await withinRateLimit(request, response, { route: 'restaurant-delete', max: 10, actorId: actor.id }))) return

  const { restaurantId, mode, confirm } = request.body || {}
  if (!uuid.test(restaurantId || '')) return response.status(400).json({ error: 'A valid restaurant is required.' })
  if (!MODES.includes(mode)) return response.status(400).json({ error: 'Choose what to remove: the whole restaurant, or the restaurant but not its payment history.' })

  const { data: restaurant, error: readError } = await admin
    .from('restaurants')
    .select('id, name, subdomain, owner_email, is_active')
    .eq('id', restaurantId)
    .maybeSingle()
  if (readError) return response.status(500).json({ error: 'The restaurant could not be read.' })
  if (!restaurant) return response.status(404).json({ error: 'That restaurant no longer exists.' })

  // Two independent guards, both re-checked here: the operator has to have put
  // the restaurant out of service, and has to have named it.
  if (restaurant.is_active) {
    return response.status(409).json({ error: 'Suspend the restaurant before deleting it. A live restaurant must be taken out of service first.' })
  }
  if (String(confirm || '').trim().toLowerCase() !== restaurant.subdomain) {
    return response.status(400).json({ error: `Type ${restaurant.subdomain} to confirm you are deleting the right restaurant.` })
  }

  // Counted before anything is removed, so the answer describes what was there.
  const [menuImages, payments, walletRows, activityRows, menuItems, categories, qrCodes] = await Promise.all([
    countMenuImages(restaurant.id),
    countRows('payment_transactions', restaurant.id),
    countRows('wallet_transactions', restaurant.id),
    countRows('activity_logs', restaurant.id),
    countRows('menu_items', restaurant.id),
    countRows('categories', restaurant.id),
    countRows('qr_tokens', restaurant.id),
  ])

  // ── Safepay first ─────────────────────────────────────────────────────────
  const { data: subscription } = await admin
    .from('subscriptions')
    .select('id, provider, provider_customer_id, safepay_payment_method_id, card_brand, card_last4')
    .eq('restaurant_id', restaurant.id)
    .maybeSingle()

  const warnings = []
  if (subscription?.provider_customer_id) {
    const result = await forgetSafepayPayer(subscription.provider_customer_id)
    if (result.error) {
      return response.status(502).json({
        error: `Safepay could not forget the card held for this restaurant (${subscription.provider_customer_id}), so nothing was deleted. ${result.error}`,
      })
    }
    if (result.warning) warnings.push(result.warning)
  }

  const ownerUsers = mode === 'erase' ? await ownerAccountsToRemove(restaurant.id) : []

  // ── Ledger rows, in erase mode only ───────────────────────────────────────
  // These are the rows the schema would otherwise keep by setting their
  // restaurant_id to null. `detach` exists precisely to keep them, so it skips
  // this entirely and lets the foreign keys do the work.
  if (mode === 'erase') {
    for (const table of LEDGER_TABLES) {
      const { error } = await admin.from(table).delete().eq('restaurant_id', restaurant.id)
      if (error) {
        console.error(`[restaurant-delete] could not clear ${table}`, error.message)
        return response.status(500).json({ error: `The restaurant was not deleted: its ${table.replace('_', ' ')} could not be removed.` })
      }
    }
  }

  // ── The tenant itself ─────────────────────────────────────────────────────
  // One delete; categories, menu items, offers, QR codes, settings, URLs,
  // subscription and admin memberships all cascade from this row.
  const { error: deleteError } = await admin.from('restaurants').delete().eq('id', restaurant.id)
  if (deleteError) {
    console.error('[restaurant-delete] could not delete restaurant', deleteError.message)
    return response.status(500).json({ error: 'The restaurant could not be deleted.' })
  }

  // ── Images ────────────────────────────────────────────────────────────────
  // Uploaded files are not rows, so nothing cascades to them. Left behind they
  // would sit in the bucket forever, unreadable and counted against the project.
  let removedImages = 0
  try {
    await clearImages(restaurant.id)
    removedImages = menuImages
  } catch (error) {
    console.error('[restaurant-delete] could not clear menu images', error?.message)
    warnings.push(`${menuImages} menu image${menuImages === 1 ? '' : 's'} could not be removed from storage.`)
  }

  // ── Owner accounts, in erase mode only ────────────────────────────────────
  let removedAccounts = 0
  for (const userId of ownerUsers) {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) {
      console.error('[restaurant-delete] could not delete owner account', userId, error.message)
      warnings.push('One owner account could not be removed. Delete it from the Supabase users list.')
    } else {
      removedAccounts += 1
    }
  }

  // Logged after the delete: activity_logs.restaurant_id is ON DELETE SET NULL,
  // so this row survives with no restaurant, which is exactly right — the record
  // of a deletion must outlive the thing it describes.
  await admin.from('activity_logs').insert({
    super_admin_id: staffRow?.id || null,
    restaurant_id: null,
    action: 'restaurant.deleted',
    details: {
      mode,
      restaurant_id: restaurant.id,
      name: restaurant.name,
      subdomain: restaurant.subdomain,
      owner_email: restaurant.owner_email,
      removed: { menu_items: menuItems, categories, qr_codes: qrCodes, menu_images: removedImages, payments: mode === 'erase' ? payments : 0, owner_accounts: removedAccounts },
      kept: mode === 'detach' ? { payments, wallet_transactions: walletRows, activity_logs: activityRows } : {},
      warnings,
    },
  })

  return response.status(200).json({
    deleted: { id: restaurant.id, name: restaurant.name, subdomain: restaurant.subdomain, mode },
    removed: {
      menu_items: menuItems,
      categories,
      qr_codes: qrCodes,
      menu_images: removedImages,
      payments: mode === 'erase' ? payments : 0,
      owner_accounts: removedAccounts,
    },
    kept: mode === 'detach' ? { payments, wallet_transactions: walletRows, activity_logs: activityRows } : { payments: 0, wallet_transactions: 0, activity_logs: 0 },
    safepayPayerRemoved: Boolean(subscription?.provider_customer_id),
    warnings,
  })
}
