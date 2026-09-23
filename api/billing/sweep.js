import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// The billing sweep, on a schedule.
//
// This is where "your trial ends in 2 days" and "this restaurant's payment
// failed" actually become notifications. It cannot be done from the browser,
// because the events are dates passing rather than anyone clicking, and a
// dashboard that only warns while someone has it open would warn nobody.
//
// Who may call it:
//
//   * Vercel Cron, which stamps every scheduled invocation with `x-vercel-cron`.
//     Vercel also forwards `CRON_SECRET` as a bearer token when that variable is
//     set, which is the stronger check and is used when available.
//   * A signed-in platform admin pressing "Run now", so the whole lifecycle can
//     be demonstrated without waiting for the clock.
//
// The sweep is idempotent and derived entirely from rows already in the
// database, so a duplicate or hostile invocation cannot invent a charge or an
// account — at worst it brings an already-overdue suspension forward, and any
// restaurant it touches was past its grace period regardless.

async function isPlatformStaff(request) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return false
  const { data: { user } } = await admin.auth.getUser(token).catch(() => ({ data: {} }))
  if (!user) return false
  const { data } = await admin.from('super_admins').select('role, is_active').eq('user_id', user.id).maybeSingle()
  return Boolean(data?.is_active && ['super_admin', 'billing'].includes(data.role))
}

function isCron(request) {
  const secret = process.env.CRON_SECRET
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (secret && bearer === secret) return true
  // Vercel sets this header itself on scheduled invocations.
  return Boolean(request.headers['x-vercel-cron'])
}

export default async function handler(request, response) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' })
  }

  const cron = isCron(request)
  const staff = cron ? false : await isPlatformStaff(request)
  if (!cron && !staff) {
    return response.status(403).json({ error: 'Only the billing schedule or a platform admin can run a sweep.' })
  }

  // A dry run reports what would happen without writing anything, which is the
  // only responsible way to look at a job whose output includes suspensions.
  const query = request.query || {}
  const body = request.body || {}
  const dryRun = String(query.dry ?? body.dry_run ?? body.dryRun ?? '') === 'true'

  try {
    const { data, error } = await admin.rpc('billing_sweep', { p_dry_run: dryRun })
    if (error) return response.status(500).json({ error: error.message })

    if (!dryRun && staff) {
      await admin.from('activity_logs').insert({
        super_admin_id: null,
        action: 'billing.sweep_run_manually',
        details: { result: data },
      })
    }

    return response.status(200).json({ ok: true, triggered_by: cron ? 'cron' : 'platform admin', result: data })
  } catch (error) {
    console.error('[billing/sweep] failed:', error)
    return response.status(500).json({ error: error?.message || 'The billing sweep could not run.' })
  }
}
