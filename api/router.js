// One function to serve every /api route.
//
// Why a single file: Vercel's Hobby plan allows at most twelve serverless
// functions per deployment and this platform has more endpoints than that — the
// build simply refuses once the limit is passed. The handlers live in `server/`
// (outside the deployment's function scan) and this router is the only function
// Vercel creates for the API; every public URL is unchanged
// (`/api/safepay/checkout` and friends all land here and are dispatched below).
//
// Why a rewrite and not `api/[...path].js`: measured on the deployed site, this
// project type does NOT treat the bracket form as a catch-all — a one-segment
// URL like /api/safepay reached the handler, while /api/safepay/status was
// answered by Vercel's own NOT_FOUND page, and the literal bracket path behaved
// like a normal file. Multi-segment API routes only exist if `vercel.json`
// rewrites them here (`/api/:path*` -> `/api/router?route=:path*`), which every
// plan supports.
//
// The route table is written out by hand rather than derived from the filesystem:
// a bundler can only follow imports it can see statically, and a computed path
// would either pull in the whole directory or — worse — compile into something
// that fails at runtime with a module that was never bundled.
//
// Body handling: `bodyParser` is turned off so the webhook can verify its HMAC
// over the raw bytes. Every other handler receives the parsed object it always
// received. When a runtime ignores that setting and parses the body first (the
// request stream is then empty), the handlers still work because `request.body`
// is already set, and the webhook falls back to Safepay's data-based signature
// scheme — its verifier deliberately accepts both.

export const config = { api: { bodyParser: false } }

const routes = {
  'rates': () => import('../server/rates.js'),
  'billing/sweep': () => import('../server/billing/sweep.js'),
  'restaurants/delete': () => import('../server/restaurants/delete.js'),
  'restaurants/onboard': () => import('../server/restaurants/onboard.js'),
  'restaurants/owner': () => import('../server/restaurants/owner.js'),
  'safepay/card': () => import('../server/safepay/card.js'),
  'safepay/checkout': () => import('../server/safepay/checkout.js'),
  'safepay/manage': () => import('../server/safepay/manage.js'),
  'safepay/plans': () => import('../server/safepay/plans.js'),
  'safepay/settle': () => import('../server/safepay/settle.js'),
  'safepay/status': () => import('../server/safepay/status.js'),
  'safepay/sync': () => import('../server/safepay/sync.js'),
  'safepay/webhook': () => import('../server/safepay/webhook.js'),
  'team/invite': () => import('../server/team/invite.js'),
  'team/link': () => import('../server/team/link.js'),
}

/** The request body as bytes. The stream exists unless the runtime parsed first. */
const readBody = (request) => new Promise((resolve) => {
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', () => resolve(Buffer.alloc(0)))
})

/**
 * The requested route, e.g. `safepay/checkout`.
 *
 * The rewrite hands the segments over as `?route=safepay/checkout`; the local dev
 * shim and any direct call present the URL itself, so both are read and only
 * plain path segments are accepted — that is what keeps `..` and extension
 * tricks out of the route lookup. An unknown route is a 404.
 */
function routeFrom(request) {
  const viaQuery = request?.query?.route
  const raw = Array.isArray(viaQuery) ? viaQuery.join('/') : typeof viaQuery === 'string' ? viaQuery : ''
  const fromUrl = String(request?.url || '').split('?')[0].replace(/^\/api\/?/i, '')
  const segments = (raw || fromUrl).split('/').filter(Boolean)
  if (!segments.length || segments.some((segment) => !/^[a-z0-9][a-z0-9-]*$/i.test(segment))) return null
  return segments.join('/').replace(/\.js$/i, '')
}

export default async function handler(request, response) {
  const route = routeFrom(request)
  const load = route ? routes[route] : null
  if (!load) return response.status(404).json({ error: 'Not found.' })

  // Parse the body ourselves unless the runtime already did (see the note above).
  // The raw bytes are kept on the request because the webhook's HMAC is computed
  // over exactly what Safepay sent, not over a re-serialisation of it.
  if (request.body === undefined && request.method !== 'GET' && request.method !== 'HEAD' && typeof request.on === 'function') {
    const raw = await readBody(request)
    request.rawBody = raw
    if (raw.length) {
      const text = raw.toString('utf8')
      try { request.body = JSON.parse(text) } catch { request.body = text }
    }
  }

  const module = await load()
  if (typeof module.default !== 'function') {
    return response.status(500).json({ error: `/api/${route} has no default export` })
  }
  return module.default(request, response)
}
