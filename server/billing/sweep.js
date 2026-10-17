import { admin } from '../_lib/admin.js'
// The platform bills its own subscriptions now (Safepay's Subscriptions product
// cannot be used — see _lib/safepay.js), so the two halves of the clock run here:
// a subscription whose paid period has ended and whose renewal is switched on is
// charged against its saved card, and one whose renewal was switched off is closed
// once the days it paid for are over. This is the platform's only scheduled entry
// point, which makes the sweep the right place for both.
import { chargeDueSubscriptions } from '../_lib/safepay-renewals.js'
import { cancelDueSubscriptions } from '../safepay/manage.js'

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

    // The jobs that must actually reach Safepay: charge the renewals that are due,
    // then close the subscriptions that asked not to be renewed. A dry run touches
    // neither, for the same reason it does not suspend anything — a charge cannot be
    // undone by a second run.
    const renewals = dryRun
      ? { charged: 0, dry_run: true }
      : await chargeDueSubscriptions(admin).catch((failure) => {
        console.error('[billing/sweep] due renewals failed:', failure?.message)
        return { charged: 0, error: failure?.message }
      })

    const cancellations = dryRun
      ? { cancelled: 0, dry_run: true }
      : await cancelDueSubscriptions(admin).catch((failure) => {
        console.error('[billing/sweep] due cancellations failed:', failure?.message)
        return { cancelled: 0, error: failure?.message }
      })

    if (!dryRun && staff) {
      await admin.from('activity_logs').insert({
        super_admin_id: null,
        action: 'billing.sweep_run_manually',
        details: { result: data },
      })
    }

    return response.status(200).json({ ok: true, triggered_by: cron ? 'cron' : 'platform admin', result: data, renewals, cancellations })
  } catch (error) {
    console.error('[billing/sweep] failed:', error)
    return response.status(500).json({ error: error?.message || 'The billing sweep could not run.' })
  }
}
