import { admin } from './admin.js'

// A per-route request budget.
//
// Supabase limits its own auth endpoints; nothing limited ours. `onboard`
// creates an Auth user, a restaurant and a Safepay plan, and `restaurant-delete`
// removes a tenant — a stolen session token could do either of those hundreds of
// times a minute. Every endpoint that writes something expensive or destructive
// asks here first.
//
// The counter lives in the database (see migration 020) rather than in memory,
// because serverless instances are created and thrown away per request: an
// in-process counter would start at zero for almost every request and limit
// nothing at all.
//
// Callers are identified by their account when they have one, and by address
// otherwise, so one signed-in operator cannot spend another's budget.

const clientAddress = (request) => {
  const headers = request?.headers || {}
  // Vercel sets x-forwarded-for; the first entry is the client, the rest are
  // proxies. x-real-ip is the fallback for other hosts.
  const forwarded = String(headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || String(headers['x-real-ip'] || '').trim() || 'unknown'
}

/**
 * Counts this request and answers 429 when the budget is spent.
 *
 * Returns true when the caller may continue. A counter that cannot be written
 * (a database blip) lets the request through and says so in the log: refusing
 * every request because the limiter is down would turn a hiccup into an outage.
 */
export async function withinRateLimit(request, response, { route, max, windowSeconds = 600, actorId }) {
  const key = `${route}:${actorId || clientAddress(request)}`
  const { data, error } = await admin.rpc('rate_limit_hit', { p_key: key, p_window_seconds: windowSeconds, p_max: max })

  if (error) {
    console.error('[rate-limit] could not count', route, error.message)
    return true
  }
  if (data?.allowed) return true

  const retryAfter = Math.max(1, Math.ceil((new Date(data.reset_at).getTime() - Date.now()) / 1000))
  const minutes = Math.ceil(retryAfter / 60)
  response.setHeader('Retry-After', String(retryAfter))
  response.status(429).json({ error: `Too many requests. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.` })
  return false
}
