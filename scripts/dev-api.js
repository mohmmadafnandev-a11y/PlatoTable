import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnv } from 'vite'

// Runs the Vercel-style handlers under `vite dev`.
//
// Why this exists: the platform's server-only work (restaurant onboarding, the
// Safepay checkout and webhook endpoints) lives in serverless functions, and
// plain `vite dev` knows nothing about them. Without this, a request to /api/...
// falls through to the SPA fallback and the endpoint returns index.html, so the
// whole server half of the product can only be exercised by deploying — which is
// exactly the loop we are trying to avoid.
//
// The handlers themselves live in `server/`; Vercel ships one catch-all function
// (`api/[...path].js`) that dispatches to them, because the Hobby plan caps a
// deployment at twelve functions and this platform has more endpoints than that.
// Requests here go through that same router, so dev and production exercise
// identical dispatch rather than two lookalike copies.
//
// This is dev-only (`apply: 'serve'`). Production still runs the real Vercel
// function; nothing here ships in the bundle.
//
// Caveat worth knowing: `vercel dev` remains the authority on Vercel-specific
// behaviour such as `vercel.json` rewrites and how the function interacts with
// them. This shim only guarantees the dispatch and the handler behave.

function readBody(request) {
  return new Promise((resolve) => {
    if (request.method === 'GET' || request.method === 'HEAD') return resolve(undefined)
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      // Vercel hands handlers a parsed object for JSON bodies. Match that so a
      // handler behaves identically under this shim.
      if (String(request.headers['content-type'] || '').includes('application/json')) {
        try { return resolve(JSON.parse(raw)) } catch { return resolve(undefined) }
      }
      resolve(raw)
    })
    request.on('error', () => resolve(undefined))
  })
}

// The subset of the Vercel response API the handlers in this repo use.
function createResponse(response) {
  let statusCode = 200
  const send = (payload) => {
    response.statusCode = statusCode
    response.end(payload)
    return api
  }
  const api = {
    status(code) { statusCode = code; return api },
    setHeader(name, value) { response.setHeader(name, value); return api },
    json(payload) { response.setHeader('Content-Type', 'application/json'); return send(JSON.stringify(payload)) },
    send(payload) { return send(payload) },
    end(payload) { return send(payload) },
  }
  return api
}

export default function devApiRoutes() {
  return {
    name: 'platotable:dev-api-routes',
    apply: 'serve',
    config(_config, environment) {
      const root = process.cwd()
      // The root `.env.local` is the single home of every value now (the legacy
      // nested project's env files were consolidated into it).
      const env = loadEnv(environment.mode, root, '')
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value) process.env[key] = value
      }
      const missing = ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((key) => !process.env[key])
      if (missing.length) console.warn(`[dev-api] Missing ${missing.join(', ')} — /api handlers will fail until these are set.`)
    },
    configureServer(server) {
      // Registered directly (not returned) so it runs before Vite's internal
      // middlewares, which would otherwise answer /api/... with index.html.
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, 'http://localhost')
        if (!url.pathname.startsWith('/api/')) return next()
        // The handlers live in `server/` and production ships one catch-all
        // function (Vercel's Hobby plan caps a deployment at twelve, and this
        // platform has more endpoints than that). Requests here go through the
        // very same router so dev and production exercise identical dispatch;
        // the pre-check keeps unknown paths falling through to the SPA as before.
        const segments = url.pathname.replace(/^\/api\/?/i, '').split('/').filter(Boolean)
        const known = segments.length
          && segments.every((segment) => /^[a-z0-9][a-z0-9-]*$/i.test(segment))
          && existsSync(resolve(process.cwd(), 'server', ...segments) + '.js')
        if (!known) return next()
        const file = resolve(process.cwd(), 'api', '[...path].js')
        try {
          const module = await server.ssrLoadModule(file)
          if (typeof module.default !== 'function') {
            response.statusCode = 500
            response.setHeader('Content-Type', 'application/json')
            return response.end(JSON.stringify({ error: `${url.pathname} has no default export` }))
          }
          const handlerRequest = {
            method: request.method,
            headers: request.headers,
            query: Object.fromEntries(url.searchParams),
            body: await readBody(request),
            url: request.url,
          }
          await module.default(handlerRequest, createResponse(response))
        } catch (error) {
          server.ssrFixStacktrace?.(error)
          console.error(`[dev-api] ${url.pathname} threw:`, error)
          if (!response.headersSent) {
            response.statusCode = 500
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({ error: error.message }))
          }
        }
      })
    },
  }
}
