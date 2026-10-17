// Where a notification's call to action points.
//
// The path is stored on the row, and the restaurant-facing rows written before
// this was understood point at the platform's own routes — '/admin/subscription',
// '/admin/billing', '/admin/payment'. Those are the Super Admin's pages: an owner
// clicking "Renew now" was taken out of their own workspace, and the operator's
// copy of the same link pointed at a screen that is not the restaurant's either.
//
// So a stored path is read as "which page", and rebuilt under the tenant it is
// about. Both panels do this, which is also what repairs the rows already in the
// database — the fix does not depend on every writer having been correct. Anything
// that is not one of these pages is returned untouched: a receipt Safepay hosts, or
// a platform alert's '/admin/subscriptions/<id>', which is already absolute.

const pages = new Set(['dashboard', 'menu', 'offers', 'categories', 'qr', 'subscription', 'billing', 'payment', 'notifications', 'usage', 'settings'])

export function notificationTarget(url, slug) {
  const value = String(url || '')
  if (!value || /^https?:\/\//i.test(value)) return value
  const [path, query] = value.split('?')
  const page = path.split('/').filter(Boolean).pop()
  if (!pages.has(page) || !slug) return value
  return `/admin/${slug}/${page}${query ? `?${query}` : ''}`
}
