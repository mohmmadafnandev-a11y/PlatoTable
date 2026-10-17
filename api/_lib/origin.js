// Where a request says it is.
//
// This used to be the configured canonical base, first and only, which is a
// *deployment* setting rather than a fact about the request. Two bugs came from
// that:
//
//   1. A checkout started on localhost handed the operator a link on a
//      deployment the tenant did not exist on.
//   2. Creating a restaurant on localhost handed back
//      https://platotable.vercel.app/admin/<slug>, a link that 404s until the
//      tenant is deployed there.
//
// Both are corrected here, in one place that answers "what host is this request
// being served from?". The canonical base is still right for the one thing that
// genuinely needs a fixed public address: the QR codes printed on tables. A
// printed code must not bake in whatever host the admin panel happened to be
// running on that morning. That is `canonicalBase`, and nothing here changes it.
//
// Nothing is trusted here in a way that matters: every candidate is an http(s)
// origin, and the only thing it can influence is where Safepay returns this
// caller, or which host a link the operator is already looking at points at.

const first = (value) => String(value || '').split(',')[0].trim()

/** `https://example.com/path` -> `https://example.com`. Anything else -> ''. */
function parseOrigin(value) {
  const candidate = first(value)
  if (!candidate) return ''
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : ''
  } catch {
    return ''
  }
}

const isLocal = (host) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host)

/**
 * The origin this request was actually served from.
 *
 * Precedence, most trustworthy first:
 *
 *   1. `Origin` / `Referer` — the browser's own account of where it is. It
 *      carries the port, which is the only way a localhost port survives a
 *      proxy that rewrites Host.
 *   2. The forwarded host, when a proxy is in front (Vercel sets
 *      `x-forwarded-host`; it also sets `host`).
 *
 * Returns '' rather than guessing when neither is usable.
 */
export function requestOrigin(request) {
  const headers = request?.headers || {}
  const stated = parseOrigin(headers.origin) || parseOrigin(headers.referer)
  if (stated) return stated

  const host = first(headers['x-forwarded-host'] || headers.host)
  if (!host) return ''
  if (isLocal(host)) return `http://${host}`

  const proto = first(headers['x-forwarded-proto']).toLowerCase()
  return `${proto === 'http' ? 'http' : 'https'}://${host}`
}

/**
 * The fixed public address of the deployment, for anything printed or stored
 * that has to outlive the request that made it — QR codes above all.
 *
 * Empty when unconfigured, which callers must treat as "no canonical address"
 * rather than substituting the request host.
 */
export const canonicalBase = () =>
  (process.env.VITE_CANONICAL_BASE_URL || process.env.VITE_APP_URL || '').replace(/\/+$/, '')

/**
 * Where a browser should come back to after Safepay finishes.
 *
 * The caller's own host first: a checkout opened on localhost must return to
 * localhost, and a checkout on the deployed domain must return to it. The
 * canonical base is the fallback for the rare machine-to-machine call that has
 * no Origin at all.
 */
export const redirectBase = (request) => requestOrigin(request) || canonicalBase()

/**
 * The base for tenant links shown to the operator — the onboarding hand-over
 * panel and the Custom URLs screen.
 *
 * Same precedence as `redirectBase`, for the same reason: the link is read by
 * the person looking at the screen it was rendered on. On localhost it must say
 * `http://localhost:5173/admin/<slug>`, on the deployment it must say the
 * deployment's own host. Only a request with no usable host at all falls back
 * to the configured canonical base.
 */
export const linkBase = (request) => requestOrigin(request) || canonicalBase()
