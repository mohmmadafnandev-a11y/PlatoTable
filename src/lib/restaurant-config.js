import { resolveTenantSlug } from './tenant'

// Resolved from the current URL at module load (subdomain, then path, then the
// VITE_RESTAURANT_SLUG fallback) instead of being baked in at build time, so one
// build serves every restaurant.
export const restaurantSlug = resolveTenantSlug()

export const restaurantName = import.meta.env.VITE_RESTAURANT_NAME || 'Restaurant'

// One shared bucket for every tenant. Objects are isolated by a
// <restaurant_id>/ folder prefix, which is what the storage policies authorise
// against, so the bucket must NOT be named per restaurant.
export const menuImageBucket = 'menu-images'

// QR links must always point at the real customer URL, never at whatever host
// the admin panel happens to be running on (a Vercel preview URL would bake
// itself into every printed QR code). Falls back to the current origin so local
// development keeps working before the variable is configured.
export const canonicalBaseUrl = (import.meta.env.VITE_CANONICAL_BASE_URL || '').replace(/\/+$/, '')

export const scanLink = (token) => `${canonicalBaseUrl || window.location.origin}/scan/${token}`
