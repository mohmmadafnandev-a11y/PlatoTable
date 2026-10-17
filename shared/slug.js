// Shared tenant rules.
//
// Deliberately dependency-free: no `window`, no `import.meta.env`, no Supabase.
// This module is imported by the browser bundle (routing + the onboarding form)
// AND by the Vercel serverless function that creates restaurants, so a slug the
// form accepts can never be rejected by the server for a different reason, and
// the reserved list can never drift between the two. Keep it pure.
//
// The same reserved list is also enforced in the database, because redirect
// targets and route names are code, and a slug that shadows `/admin` or `/api`
// has to be impossible at the data layer too — not merely discouraged in a form.

export const SLUG_MIN = 3
export const SLUG_MAX = 30

// A slug here would collide with a real route rather than name a restaurant.
// Every Super Admin and platform segment must appear, otherwise `/admin/<slug>`
// and `/<slug>` become ambiguous.
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'assets', 'scan', 'login', 'logout', 'settings',
  'restaurants', 'subscriptions', 'plans', 'notifications', 'analytics',
  'team', 'logs', 'revenue', 'transactions', 'urls', 'dashboard', 'billing',
  'payment', 'help', 'support', 'about', 'contact', 'terms', 'privacy',
  'signup', 'signin', 'signout', 'register', 'auth',
  'new', 'null', 'undefined', 'favicon.ico', 'robots.txt', 'sitemap.xml',
])

export const RESERVED_SLUG_LIST = [...RESERVED_SLUGS].sort()

// Returns an empty string when the slug is acceptable, otherwise a message
// written for the person filling in the onboarding form.
export function slugError(slug) {
  const value = String(slug ?? '').trim().toLowerCase()
  if (!value) return 'Enter a subdomain.'
  if (value.length < SLUG_MIN || value.length > SLUG_MAX) return `Use between ${SLUG_MIN} and ${SLUG_MAX} characters.`
  if (!/^[a-z0-9-]+$/.test(value)) return 'Use lowercase letters, numbers, and hyphens only.'
  if (value.startsWith('-') || value.endsWith('-')) return 'Cannot start or end with a hyphen.'
  if (value.includes('--')) return 'Use single hyphens only.'
  if (RESERVED_SLUGS.has(value)) return 'This subdomain is reserved by the platform. Please choose another.'
  return ''
}

export const isValidSlug = (slug) => !slugError(slug)

// Turns a restaurant name into a suggested subdomain: "BBQ Today!" -> "bbq-today".
// Returns '' when nothing usable remains, so callers can fall back to manual entry.
export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

// The owner signs in with a real mailbox, so this password is the account's only
// credential until they change it. 12 is the floor the form and the endpoint
// both apply; Supabase's leaked-password protection rejects breached values on
// top of that.
export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 72

export function passwordError(password) {
  const value = String(password ?? '')
  if (!value) return 'Enter a password for the restaurant owner.'
  if (value.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`
  if (value.length > PASSWORD_MAX) return `Use no more than ${PASSWORD_MAX} characters.`
  return ''
}

// Generates a readable temporary password. Ambiguous characters (O/0, l/1) are
// left out because these are dictated over the phone and typed by hand.
export function suggestPassword(length = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%'
  const bytes = new Uint8Array(length)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')
}

// One currency, everywhere: the platform is priced, billed, and reported in
// Pakistani rupees, on both panels and on the public page — the money is taken
// by Safepay, which is a Pakistani gateway. Restaurants are onboarded in
// different countries, not in different currencies — a second currency allowed a
// plan to be read in one figure and billed in another, and it is deliberately
// unrepresentable now.
export const CURRENCY = 'PKR'
export const CURRENCIES = [CURRENCY]

// Country is still collected: it says which market a restaurant trades in, and
// it is what the directory's country filter groups by. It no longer decides a
// billing currency.
export const COUNTRIES = [
  { code: 'PK', name: 'Pakistan' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SA', name: 'Saudi Arabia' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'INTL', name: 'International' },
]

export const COUNTRY_CODES = COUNTRIES.map((country) => country.code)
