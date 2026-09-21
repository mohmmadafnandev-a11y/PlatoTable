// Tenant resolution for the single-bundle app.
//
// One Vercel project serves three surfaces, so the tenant comes from the URL
// rather than from a build-time environment variable:
//
//   /                    landing
//   /scan/:token         customer menu (QR flow, works on any host)
//   /admin               Super Admin
//   /admin/<reserved>    Super Admin inner pages
//   /admin/<slug>        restaurant admin for that tenant
//   /<slug>              customer menu welcome page for that tenant
//
// Precedence is subdomain -> path -> VITE_RESTAURANT_SLUG.

export const SUPER_ADMIN_BASE = '/admin'

// Slugs that can never belong to a restaurant because they collide with a real
// route. `/admin/login` is the sharpest example: it is the Super Admin sign-in
// screen, so "login" must never resolve to a tenant. Every Super Admin segment
// is in this list, which is what keeps /admin/<page> and /admin/<slug>
// unambiguous.
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'assets', 'scan', 'login', 'logout', 'settings',
  'restaurants', 'subscriptions', 'plans', 'notifications', 'analytics',
  'team', 'logs', 'revenue', 'transactions', 'urls', 'dashboard', 'billing',
  'payment', 'help', 'support', 'about', 'contact', 'terms', 'privacy',
  'signup', 'signin', 'signout', 'register', 'auth',
])

export const SLUG_MIN = 3
export const SLUG_MAX = 30

// The onboarding form and the server-side endpoint must both enforce this, so
// it lives in one place.
export function slugError(slug) {
  const value = String(slug ?? '').trim().toLowerCase()
  if (!value) return 'Enter a subdomain.'
  if (value.length < SLUG_MIN || value.length > SLUG_MAX) return `Use between ${SLUG_MIN} and ${SLUG_MAX} characters.`
  if (!/^[a-z0-9-]+$/.test(value)) return 'Use lowercase letters, numbers, and hyphens only.'
  if (value.startsWith('-') || value.endsWith('-')) return 'Cannot start or end with a hyphen.'
  if (RESERVED_SLUGS.has(value)) return 'This subdomain is reserved. Please choose another.'
  return ''
}

export const isValidSlug = (slug) => !slugError(slug)

// Shared hosting domains, where every deployment is already a subdomain of the
// platform itself. A tenant subdomain can never exist there, so those hosts
// must resolve by path only.
const SHARED_HOSTS = ['vercel.app', 'netlify.app', 'pages.dev', 'localhost']
const ADMIN_LABEL = SUPER_ADMIN_BASE.slice(1)

export function slugFromSubdomain(hostname = '') {
  const host = String(hostname).split(':')[0].toLowerCase()
  if (!host || host === 'localhost' || /^\d+(\.\d+){3}$/.test(host)) return ''
  if (SHARED_HOSTS.some((base) => host === base || host.endsWith(`.${base}`))) return ''
  const labels = host.split('.')
  // A tenant subdomain needs a real domain after it: daynight.platotable.com.
  if (labels.length < 3) return ''
  const [first] = labels
  if (first === 'www' || first === ADMIN_LABEL) return ''
  return isValidSlug(first) ? first : ''
}

export function slugFromPath(pathname = '/') {
  const segments = String(pathname).split('?')[0].split('/').filter(Boolean)
  if (!segments.length) return ''
  const [first, second] = segments
  if (first === ADMIN_LABEL) return second && !RESERVED_SLUGS.has(second) ? second : ''
  if (RESERVED_SLUGS.has(first)) return ''
  return first
}

export function resolveTenantSlug(pathname = window.location.pathname, hostname = window.location.hostname) {
  return slugFromSubdomain(hostname) || slugFromPath(pathname) || (import.meta.env.VITE_RESTAURANT_SLUG || '').trim().toLowerCase()
}

// Absolute path for a Super Admin route. The Super Admin keeps its own route
// names, but they all live under /admin in the merged bundle.
export const saPath = (path = '') => {
  const trimmed = String(path).replace(/^\/+/, '')
  return trimmed ? `${SUPER_ADMIN_BASE}/${trimmed}` : SUPER_ADMIN_BASE
}

// True when the first segment after /admin belongs to the Super Admin rather
// than to a tenant.
export const isSuperAdminSegment = (segment) => !segment || RESERVED_SLUGS.has(segment)
