import { admin } from './_lib/admin.js'

// Exchange rates for the whole platform, fetched once and cached.
//
// This is an endpoint rather than a browser call for two reasons:
//
//   * The key stays on the server. A VITE_ variable is compiled into the bundle
//     and readable by anyone who opens devtools.
//   * One refresh serves every operator. The provider publishes rates once a
//     day, so a panel that fetched on every visit would spend the quota to learn
//     the same numbers.
//
// The browser may ask for a forced refresh (?refresh=1). A cached answer is
// served whenever it is younger than REFRESH_AFTER_HOURS *or* whenever the
// upstream call fails, so a provider outage degrades to yesterday's rates rather
// than to no rates at all.

const REFRESH_AFTER_HOURS = 12
const BASE = 'USD'

async function isPlatformStaff(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return false
  const { data: { user } } = await admin.auth.getUser(token).catch(() => ({ data: {} }))
  if (!user) return false
  const { data } = await admin.from('super_admins').select('is_active').eq('user_id', user.id).maybeSingle()
  return Boolean(data?.is_active)
}

const ageInHours = (fetchedAt) => (fetchedAt ? (Date.now() - new Date(fetchedAt).getTime()) / 3600000 : Infinity)

async function fetchFromProvider() {
  const key = process.env.EXCHANGE_RATE_API_KEY || process.env.VITE_EXCHANGE_RATE_API_KEY
  if (!key) return { error: 'EXCHANGE_RATE_API_KEY is not configured' }

  const response = await fetch(`https://v6.exchangerate-api.com/v6/${key}/latest/${BASE}`).catch(() => null)
  if (!response) return { error: 'The exchange rate provider could not be reached.' }
  if (!response.ok) return { error: `The exchange rate provider returned ${response.status}.` }

  const body = await response.json().catch(() => null)
  if (body?.result !== 'success' || !body.conversion_rates) {
    return { error: body?.['error-type'] || 'The exchange rate provider returned no rates.' }
  }
  return { base: body.base_code || BASE, rates: body.conversion_rates, source: 'exchangerate-api' }
}

export default async function handler(request, response) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' })
  }
  if (!(await isPlatformStaff(request))) {
    return response.status(403).json({ error: 'Only platform staff can read exchange rates.' })
  }

  const query = request.query || {}
  const force = String(query.refresh ?? query.force ?? '') === '1' || String(query.refresh) === 'true'

  const { data: cached } = await admin
    .from('currency_rates')
    .select('base, rates, fetched_at, source')
    .eq('base', BASE)
    .maybeSingle()

  const age = ageInHours(cached?.fetched_at)
  const stale = !cached || age >= REFRESH_AFTER_HOURS

  if (!stale && !force) {
    return response.status(200).json({
      ok: true,
      base: cached.base,
      rates: cached.rates,
      fetched_at: cached.fetched_at,
      age_hours: Number(age.toFixed(1)),
      source: cached.source,
      refreshed: false,
    })
  }

  const fresh = await fetchFromProvider()
  if (fresh.error) {
    if (cached?.rates) {
      return response.status(200).json({
        ok: true,
        base: cached.base,
        rates: cached.rates,
        fetched_at: cached.fetched_at,
        age_hours: Number(age.toFixed(1)),
        source: cached.source,
        refreshed: false,
        warning: fresh.error,
      })
    }
    return response.status(502).json({ error: fresh.error })
  }

  const fetchedAt = new Date().toISOString()
  const { error: writeError } = await admin
    .from('currency_rates')
    .upsert({ base: fresh.base, rates: fresh.rates, fetched_at: fetchedAt, source: fresh.source }, { onConflict: 'base' })
  if (writeError) return response.status(500).json({ error: writeError.message })

  // The same request that refreshes rates also retires rate-limit windows older
  // than a day. This endpoint already runs on a schedule, so the cleanup rides
  // along instead of needing a job of its own.
  const { data: pruned } = await admin.rpc('rate_limits_prune').catch(() => ({ data: null }))
  if (typeof pruned === 'number' && pruned > 0) console.log(`[rates] pruned ${pruned} expired rate-limit windows`)

  return response.status(200).json({
    ok: true,
    base: fresh.base,
    rates: fresh.rates,
    fetched_at: fetchedAt,
    age_hours: 0,
    source: fresh.source,
    refreshed: true,
  })
}
