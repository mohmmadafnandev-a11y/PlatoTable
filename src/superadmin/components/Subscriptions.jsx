import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, CreditCard, ExternalLink, Play, Pause, Receipt, RefreshCw, XCircle } from 'lucide-react'
import { intervalLabel, planDurationDays, resolvePlanPrice } from '../../../shared/plans.js'
import { supabase } from '../lib/supabase'
import { logActivity } from '../lib/data'
import { openBillingPortal, runBillingSweep, startSubscription, syncFromStripe } from '../lib/stripe-api'
import { STATUSES, dateTime, daysBetween, money, plainNumber, shortDate } from '../lib/format'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatCard, StatusBadge, inputClass } from './ui'

function useSubscriptionData() {
  const [subscriptions, setSubscriptions] = useState([])
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return Promise.all([
      supabase
        .from('subscriptions')
        .select('*, restaurants(id, name, subdomain, is_active, currency), subscription_plans(id, name, interval, interval_count)')
        .order('created_at', { ascending: false }),
      supabase.from('subscription_plans')
        .select('id, name, interval, interval_count, price_usd, price_aed, price_pkr, price_gbp, price_sar, stripe_price_usd, stripe_price_aed, stripe_price_pkr, stripe_price_gbp, stripe_price_sar')
        .order('interval').order('name'),
    ]).then(([subscriptionResult, planResult]) => {
      const failure = subscriptionResult.error || planResult.error
      if (failure) setError(failure.message)
      else {
        setSubscriptions(subscriptionResult.data || [])
        setPlans(planResult.data || [])
        setError('')
      }
      setLoading(false)
    })
  }, [])

  useEffect(() => { load() }, [load])
  return { subscriptions, plans, loading, error, load }
}

/**
 * Every charge due inside the window, soonest first.
 *
 * Read from the database rather than from Stripe so the screen still answers
 * when Stripe is unreachable, and so a trial that has never touched Stripe —
 * every restaurant before it adds a card — appears like any other.
 */
function useUpcomingPayments(days = 30) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // `loading` is only ever cleared here, never set: it starts true, and a reload
  // leaves the previous rows on screen instead of blanking the table. Clearing
  // it inside the promise also keeps the call out of the effect body, where a
  // synchronous setState would cause a second render on every mount.
  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.rpc('super_admin_upcoming_payments', { p_days: days }).then(({ data: result, error: requestError }) => {
      if (requestError) setError(requestError.message)
      else { setData(result); setError('') }
      setLoading(false)
    })
  }, [days])

  useEffect(() => { load() }, [load])
  return {
    upcoming: data?.upcoming || [],
    totals: data?.totals || [],
    windowDays: data?.window_days ?? days,
    loading,
    error,
    reload: load,
  }
}

// Exported so the Transactions screen shows the same renewals calendar rather
// than a second, subtly different one.
export function UpcomingPayments() {
  const { upcoming, totals, windowDays, loading, error, reload } = useUpcomingPayments(30)
  const [running, setRunning] = useState('')
  const [feedback, setFeedback] = useState(null)

  // The same job the daily cron runs. Offered here so the trial warning and the
  // grace notices can be seen working without waiting for tomorrow morning.
  const runSweep = async (dryRun) => {
    setRunning(dryRun ? 'dry' : 'live')
    setFeedback(null)
    try {
      const result = await runBillingSweep(dryRun)
      const report = result.result || {}
      setFeedback({
        tone: 'success',
        text: `${dryRun ? 'Dry run' : 'Sweep'} — ${report.due_soon ?? 0} due soon · ${report.grace_warnings ?? 0} in grace · ${report.payment_failures ?? 0} failed payment(s) · ${report.suspended ?? 0} suspended.`,
      })
      if (!dryRun) reload()
    } catch (sweepError) {
      setFeedback({ tone: 'danger', text: sweepError.message })
    }
    setRunning('')
  }

  return (
    <Card className="mt-6 overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 p-5">
        <div>
          <h2 className="font-semibold text-slate-900">Upcoming payments</h2>
          <p className="mt-1 text-sm text-slate-500">Trials ending and renewals due in the next {windowDays} days, soonest first.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={Boolean(running)}
            onClick={() => runSweep(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            {running === 'dry' ? 'Checking…' : 'Dry run sweep'}
          </button>
          <button
            disabled={Boolean(running)}
            onClick={() => runSweep(false)}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            <RefreshCw size={14} className={running === 'live' ? 'animate-spin' : ''} />{running === 'live' ? 'Running…' : 'Run billing sweep'}
          </button>
        </div>
      </div>

      {feedback && <div className="border-b border-slate-100 p-4"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}
      {error && <div className="border-b border-slate-100 p-4"><Notice tone="danger">{error}</Notice></div>}

      {totals.length > 0 && (
        <div className="flex flex-wrap gap-3 border-b border-slate-100 px-5 py-4">
          {totals.map((total) => (
            <span key={total.currency} className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">
              {total.count} due · {money(total.amount, total.currency)}
            </span>
          ))}
        </div>
      )}

      {loading && !upcoming.length
        ? <Spinner label="Loading renewals" />
        : upcoming.length
          ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="p-4 font-semibold">Restaurant</th>
                    <th className="p-4 font-semibold">Plan</th>
                    <th className="p-4 font-semibold">What happens</th>
                    <th className="p-4 font-semibold">Date</th>
                    <th className="p-4 font-semibold">In</th>
                    <th className="p-4 font-semibold">Amount</th>
                    <th className="p-4 font-semibold">Card on file</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((row) => (
                    <tr key={row.subscription_id} className="border-t border-slate-100 transition hover:bg-indigo-50/40">
                      <td className="p-4">
                        <strong className="block font-semibold text-slate-900">{row.restaurant_name}</strong>
                        <small className="mt-1 block text-xs text-slate-400">/{row.subdomain || '—'} · {row.country || '—'}</small>
                      </td>
                      <td className="p-4 text-slate-600">{row.plan_name || 'Custom plan'}</td>
                      <td className="p-4">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.kind === 'trial_ends' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-700'}`}>
                          {row.kind === 'trial_ends' ? 'Trial ends' : 'Renews'}
                        </span>
                      </td>
                      <td className="p-4 text-slate-600">{shortDate(row.due_at)}</td>
                      <td className="p-4">
                        <span className={row.days_until <= 3 ? 'font-semibold text-amber-700' : 'text-slate-600'}>
                          {row.days_until === 0 ? 'today' : `${row.days_until}d`}
                        </span>
                      </td>
                      <td className="p-4 text-slate-600">{money(row.amount, row.currency)}</td>
                      <td className="p-4 text-slate-600">{row.has_stripe ? 'Yes' : <span className="text-amber-700">Not yet</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
          : <EmptyState icon={CalendarClock} title="Nothing due in this window" description="No trial ends or renewals fall inside the next 30 days." />}
    </Card>
  )
}

export function Subscriptions({ navigate }) {
  const { subscriptions, loading, error, load } = useSubscriptionData()
  const [filter, setFilter] = useState('all')

  const counts = STATUSES.map((status) => [status, subscriptions.filter((item) => item.status === status).length])
  const visible = subscriptions.filter((item) => filter === 'all' || item.status === filter)

  return (
    <>
      <SectionHead
        eyebrow="BILLING CONTROL"
        title="Subscriptions"
        description="Trials, billing cycles, and the health of every subscription."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {counts.map(([status, count]) => (
          <button
            key={status}
            onClick={() => setFilter(filter === status ? 'all' : status)}
            className={`rounded-xl border p-4 text-left transition ${filter === status ? 'border-indigo-300 bg-indigo-50 ring-2 ring-indigo-100' : 'border-slate-200 bg-white hover:border-indigo-200'}`}
          >
            <span className="text-xs font-semibold capitalize text-slate-500">{status.replace(/_/g, ' ')}</span>
            <strong className="mt-2 block text-2xl text-slate-900">{count}</strong>
          </button>
        ))}
      </section>

      <UpcomingPayments />

      <div className="mt-6 flex gap-2 overflow-x-auto">
        <button onClick={() => setFilter('all')} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${filter === 'all' ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>All ({subscriptions.length})</button>
        {counts.map(([status, count]) => (
          <button key={status} onClick={() => setFilter(status)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold capitalize ${filter === status ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>
            {status.replace(/_/g, ' ')} ({count})
          </button>
        ))}
      </div>

      {error && <div className="mt-4"><Notice tone="danger" action={<button onClick={load} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <Card className="mt-4 overflow-hidden p-0">
        {loading && !subscriptions.length
          ? <Spinner label="Loading subscriptions" />
          : visible.length
            ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1000px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-4 font-semibold">Restaurant</th>
                      <th className="p-4 font-semibold">Status</th>
                      <th className="p-4 font-semibold">Plan</th>
                      <th className="p-4 font-semibold">Amount</th>
                      <th className="p-4 font-semibold">Renews</th>
                      <th className="p-4 font-semibold">Remaining</th>
                      <th className="p-4 font-semibold">Last payment</th>
                      <th className="p-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((subscription) => {
                      const end = subscription.status === 'trialing' ? subscription.trial_end : subscription.current_period_end
                      const remaining = daysBetween(end)
                      return (
                        <tr key={subscription.id} className="border-t border-slate-100 transition hover:bg-indigo-50/40">
                          <td className="p-4">
                            <strong className="block font-semibold text-slate-900">{subscription.restaurants?.name || 'Restaurant'}</strong>
                            <small className="mt-1 block text-xs text-slate-400">/{subscription.restaurants?.subdomain || '—'}</small>
                          </td>
                          <td className="p-4"><StatusBadge status={subscription.status} /></td>
                          <td className="p-4 text-slate-600">{subscription.subscription_plans?.name || 'Custom'}</td>
                          <td className="p-4 text-slate-600">{money(subscription.amount, subscription.currency)}</td>
                          <td className="p-4 text-slate-600">{end ? shortDate(end) : '—'}</td>
                          <td className="p-4">
                            {remaining === null
                              ? <span className="text-slate-400">—</span>
                              : remaining < 0
                                ? <span className="font-semibold text-red-600">Expired {Math.abs(remaining)}d ago</span>
                                : <span className={remaining <= 3 ? 'font-semibold text-amber-700' : 'text-slate-600'}>{remaining}d</span>}
                          </td>
                          <td className="p-4 text-slate-600">{subscription.last_payment_status || '—'}</td>
                          <td className="p-4 text-right">
                            <button onClick={() => navigate(`/subscriptions/${subscription.id}`)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-white">Manage</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
            : <EmptyState icon={CreditCard} title={subscriptions.length ? 'Nothing matches this filter' : 'No subscriptions yet'} description={subscriptions.length ? 'Pick a different status above.' : 'Onboarding a restaurant creates its subscription automatically.'} />}
      </Card>
    </>
  )
}

export function SubscriptionDetail({ navigate, id, profile }) {
  const { subscriptions, plans, loading, load } = useSubscriptionData()
  const subscription = subscriptions.find((item) => item.id === id)
  const [days, setDays] = useState(7)
  const [saving, setSaving] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [payments, setPayments] = useState([])

  const restaurantId = subscription?.restaurant_id
  useEffect(() => {
    if (!supabase || !id) return undefined
    let active = true
    supabase
      .from('payment_transactions')
      .select('id, amount, currency, status, created_at, card_brand, card_last4, payment_method')
      .eq('subscription_id', id)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (active) setPayments(data || []) })
    return () => { active = false }
  }, [id])

  if (loading && !subscription) return <Spinner label="Loading subscription" />
  if (!subscription) {
    return (
      <section>
        <button onClick={() => navigate('/subscriptions')} className="mb-5 text-sm font-semibold text-indigo-600">← Subscriptions</button>
        <Notice tone="warning">No subscription matches that id.</Notice>
      </section>
    )
  }

  const endField = subscription.status === 'trialing' ? 'trial_end' : 'current_period_end'
  const currentEnd = subscription[endField]

  const write = async (patch, action, details = {}) => {
    setSaving(action)
    const { error } = await supabase
      .from('subscriptions')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', subscription.id)
    setSaving('')
    if (error) return setFeedback({ tone: 'danger', text: error.message })
    await logActivity({ superAdminId: profile?.id, restaurantId, action, details })
    setFeedback({ tone: 'success', text: `${action.replace(/_/g, ' ')} recorded.` })
    load()
  }

  const extend = () => {
    const base = new Date(currentEnd || subscription.created_at)
    base.setDate(base.getDate() + Number(days))
    return write({ [endField]: base.toISOString() }, 'subscription_extended', { days: Number(days), field: endField })
  }

  const changePlan = async (planId) => {
    const plan = plans.find((item) => item.id === planId)
    if (!plan) return write({ plan_id: null }, 'subscription_plan_cleared')
    const currency = (subscription.currency || 'USD').toUpperCase()
    // This used to fall back to the USD price when the plan had no price in the
    // subscription's currency, which silently recorded the wrong amount. Refuse
    // instead: a wrong figure here ends up on an invoice.
    const priced = resolvePlanPrice(plan, currency)
    if (!priced) {
      return setFeedback({ tone: 'warning', text: `${plan.name} has no ${currency} price, so it cannot bill this restaurant. Add that price in Plans & pricing first.` })
    }
    return write(
      { plan_id: plan.id, amount: priced.amount, currency: priced.currency },
      'subscription_plan_changed',
      { plan: plan.name, interval: `${plan.interval_count || 1} ${plan.interval || 'month'}`, amount: priced.amount, currency: priced.currency },
    )
  }

  // Opens hosted Stripe Checkout. The price is resolved on the server from the
  // plan and this restaurant's currency, so the amount charged never depends on
  // anything the browser sends.
  const beginCheckout = async () => {
    if (!subscription.plan_id) return setFeedback({ tone: 'warning', text: 'Choose a catalogue plan before starting a Stripe subscription.' })
    setSaving('checkout'); setFeedback(null)
    try {
      const result = await startSubscription(restaurantId, subscription.plan_id)
      setFeedback({ tone: 'success', text: `Opening Stripe Checkout — ${money(result.amount, result.currency)}${result.trialDays ? ` after a ${result.trialDays} day trial` : ''}. Complete it in the Stripe window.` })
      // `assign` rather than assigning `href`: the lint rule forbids mutating a
      // value owned outside the component, and this is also the honest intent —
      // we are leaving, not setting a property.
      window.location.assign(result.url)
    } catch (error) {
      setFeedback({ tone: 'danger', text: error.message })
      setSaving('')
    }
  }

  const openPortal = async () => {
    setSaving('portal'); setFeedback(null)
    try {
      const { url } = await openBillingPortal(restaurantId)
      window.location.assign(url)
    } catch (error) {
      setFeedback({ tone: 'danger', text: error.message })
      setSaving('')
    }
  }

  // Stripe cannot deliver a webhook to a laptop, so in development this is the
  // only way the subscription actually updates after a test payment. It is also
  // the recovery path if a live webhook delivery was ever missed.
  const syncNow = async () => {
    setSaving('sync'); setFeedback(null)
    try {
      const result = await syncFromStripe('subscriptions')
      const report = result.subscriptions || {}
      const parts = [`Read ${report.checked ?? 0} subscription${report.checked === 1 ? '' : 's'} from Stripe`, `${report.updated ?? 0} updated`, `${report.transactions ?? 0} payment(s) recorded`]
      if (report.unmatched?.length) parts.push(`${report.unmatched.length} not matched to a restaurant`)
      setFeedback({ tone: report.unmatched?.length ? 'warning' : 'success', text: `${parts.join(' · ')}.` })
      load()
    } catch (error) {
      setFeedback({ tone: 'danger', text: error.message })
    }
    setSaving('')
  }

  const setSuspended = async (suspended) => {
    if (!window.confirm(`${suspended ? 'Suspend' : 'Reactivate'} ${subscription.restaurants?.name}?`)) return
    setSaving('suspend')
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .update({ status: suspended ? 'suspended' : 'active', updated_at: new Date().toISOString() })
      .eq('id', subscription.id)
    if (!subscriptionError && restaurantId) {
      // The public lookup and the QR menu read is_active, so suspension has to
      // be written there too or the restaurant keeps serving menus.
      await supabase.from('restaurants').update({ is_active: !suspended, updated_at: new Date().toISOString() }).eq('id', restaurantId)
    }
    setSaving('')
    if (subscriptionError) return setFeedback({ tone: 'danger', text: subscriptionError.message })
    await logActivity({ superAdminId: profile?.id, restaurantId, action: suspended ? 'restaurant_suspended' : 'restaurant_reactivated' })
    setFeedback({ tone: 'success', text: suspended ? 'Subscription suspended.' : 'Subscription reactivated.' })
    load()
  }

  // Recording an offline payment has to create a real transaction row: flipping
  // last_payment_status alone would report money that appears nowhere in the
  // ledger or the revenue totals.
  const markPaid = async () => {
    // One period, as the plan defines it. This used to add exactly one month,
    // which silently gave a yearly plan a monthly period, so the next invoice
    // fell due eleven months early.
    const periodDays = planDurationDays(subscription.subscription_plans?.interval, subscription.subscription_plans?.interval_count)
    if (!window.confirm(`Record an offline payment of ${money(subscription.amount, subscription.currency)} and extend the period by ${periodDays} days?`)) return
    setSaving('mark_paid')
    const periodStart = new Date()
    const periodEnd = new Date(periodStart.getTime() + periodDays * 86400000)

    const { error: paymentError } = await supabase.from('payment_transactions').insert({
      restaurant_id: restaurantId,
      subscription_id: subscription.id,
      provider: 'manual',
      amount: subscription.amount,
      currency: subscription.currency,
      status: 'succeeded',
      payment_method: 'manual',
    })
    if (paymentError) { setSaving(''); return setFeedback({ tone: 'danger', text: paymentError.message }) }

    const { error: updateError } = await supabase
      .from('subscriptions')
      .update({
        status: 'active',
        // `paid`, not `succeeded`. The column is constrained to paid/failed, so
        // `succeeded` was rejected by the database and the whole update failed —
        // which is why this button reported a check-constraint violation with
        // the payment already recorded in the ledger.
        last_payment_status: 'paid',
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscription.id)
    setSaving('')
    if (updateError) return setFeedback({ tone: 'danger', text: updateError.message })
    await logActivity({ superAdminId: profile?.id, restaurantId, action: 'subscription_paid_manually', details: { amount: subscription.amount, days: periodDays } })
    setFeedback({ tone: 'success', text: `Offline payment recorded and the period extended by ${periodDays} days.` })
    load()
  }

  const timeline = [
    ['Created', subscription.created_at],
    ['Trial started', subscription.trial_start],
    ['Trial ended', subscription.trial_end],
    ['Period started', subscription.current_period_start],
    ['Period ends', subscription.current_period_end],
    ['Cancelled', subscription.canceled_at],
  ].filter(([, value]) => value)

  return (
    <>
      <button onClick={() => navigate('/subscriptions')} className="mb-5 text-sm font-semibold text-indigo-600">← Subscriptions</button>

      <SectionHead
        eyebrow="SUBSCRIPTION DETAIL"
        title={subscription.restaurants?.name || 'Subscription'}
        description={subscription.restaurants?.subdomain ? `Restaurant /${subscription.restaurants.subdomain}` : undefined}
        action={<StatusBadge status={subscription.status} />}
      />

      {feedback && <div className="mb-5"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}

      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Recurring amount"
          value={money(subscription.amount, subscription.currency)}
          hint={subscription.subscription_plans
            ? `${subscription.subscription_plans.name} · ${intervalLabel(subscription.subscription_plans)}`
            : 'Custom plan'}
          icon={CreditCard}
          tone="text-indigo-600 bg-indigo-50"
        />
        <StatCard
          label={subscription.status === 'trialing' ? 'Trial ends' : 'Period ends'}
          value={currentEnd ? shortDate(currentEnd) : '—'}
          hint={(() => { const remaining = daysBetween(currentEnd); return remaining === null ? 'No end date recorded' : remaining < 0 ? `Expired ${Math.abs(remaining)} days ago` : `${remaining} days remaining` })()}
          icon={CalendarClock}
          tone="text-amber-600 bg-amber-50"
        />
        <StatCard label="Payments recorded" value={plainNumber(payments.length)} hint={`Last status ${subscription.last_payment_status || 'unknown'}`} icon={Receipt} tone="text-emerald-600 bg-emerald-50" />
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <h2 className="font-semibold text-slate-900">Plan & billing</h2>
          <dl className="mt-5 grid gap-5 sm:grid-cols-2">
            {[
              ['Status', subscription.status.replace(/_/g, ' ')],
              ['Plan', subscription.subscription_plans?.name || 'Custom plan'],
              ['Provider', subscription.provider || 'stripe'],
              ['Currency', subscription.currency],
              ['Stripe customer', subscription.provider_customer_id || 'Not linked'],
              ['Stripe subscription', subscription.provider_subscription_id || 'Not linked'],
              ['Cancels at period end', subscription.cancel_at_period_end ? 'Yes' : 'No'],
              ['Trial already used', subscription.trial_used_at ? shortDate(subscription.trial_used_at) : 'No'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                <dd className="mt-1 break-all text-sm capitalize text-slate-700">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-slate-900">Timeline</h2>
          <ol className="mt-5 grid gap-4">
            {timeline.map(([label, value]) => (
              <li key={label} className="border-l-2 border-slate-200 pl-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
                <p className="mt-1 text-sm text-slate-700">{dateTime(value)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </section>

      <Card className="mt-6 p-6">
        <h2 className="font-semibold text-slate-900">Actions</h2>
        <p className="mt-1 text-sm text-slate-500">Every action here is recorded in the activity log.</p>

        <div className="mt-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Stripe billing</h3>
              <p className="mt-1 text-xs text-slate-600">
                {subscription.provider_subscription_id
                  ? 'This restaurant has a live Stripe subscription. Invoices and status arrive by webhook; pull them manually if a delivery was missed.'
                  : 'No Stripe subscription is attached yet. Checkout uses the plan’s price in this restaurant’s currency, then Stripe keeps the status updated.'}
              </p>
            </div>
            <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-slate-600">Test mode</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              disabled={!!saving || !subscription.plan_id}
              onClick={beginCheckout}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              <ExternalLink size={16} />{saving === 'checkout' ? 'Opening Stripe…' : subscription.provider_subscription_id ? 'Start another subscription' : 'Start Stripe subscription'}
            </button>
            <button
              disabled={!!saving || !subscription.provider_customer_id}
              onClick={openPortal}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
            >
              {saving === 'portal' ? 'Opening…' : 'Update payment method'}
            </button>
            <button
              disabled={!!saving}
              onClick={syncNow}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
            >
              <RefreshCw size={16} className={saving === 'sync' ? 'animate-spin' : ''} />{saving === 'sync' ? 'Syncing…' : 'Sync from Stripe'}
            </button>
          </div>
          {!subscription.plan_id && <p className="mt-3 text-xs font-medium text-amber-700">Choose a plan below first — Checkout charges whatever price that plan carries in {subscription.currency}.</p>}
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Extend the billing period</h3>
            {/* Two different things are easily confused, and the difference
                decides whether a restaurant keeps serving menus. Saying so here
                is cheaper than explaining it on a support call. */}
            <p className="mt-1 text-xs text-slate-500">
              Pushes the next charge date out by these days — a goodwill credit, not a payment.
              {' '}Separately, the platform's grace period already keeps a restaurant online automatically
              after its date passes, before anything suspends it.
            </p>
            <div className="mt-3 flex gap-2">
              <input type="number" min="1" max="365" value={days} onChange={(event) => setDays(event.target.value)} className={`${inputClass} w-24`} />
              <button disabled={saving === 'subscription_extended'} onClick={extend} className="flex-1 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700 disabled:opacity-60">
                {saving === 'subscription_extended' ? 'Saving…' : 'Extend'}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Change plan</h3>
            <p className="mt-1 text-xs text-slate-500">Pricing follows the plan and the subscription currency.</p>
            {/* Only plans that can actually bill this restaurant in its own
                currency are worth choosing, so the rest are marked. */}
            <select
              disabled={!plans.length || !!saving}
              value={subscription.plan_id || ''}
              onChange={(event) => changePlan(event.target.value)}
              className={`${inputClass} mt-3 w-full`}
            >
              <option value="">Custom plan (no catalogue plan)</option>
              {plans.map((plan) => {
                const billable = Boolean(resolvePlanPrice(plan, subscription.currency || 'USD'))
                return <option key={plan.id} value={plan.id}>{plan.name} — {intervalLabel(plan)}{billable ? '' : ` (no ${(subscription.currency || 'USD').toUpperCase()} price)`}</option>
              })}
            </select>
            {!plans.length && <p className="mt-2 text-xs text-amber-700">No plans exist yet. Create one under Plans & pricing.</p>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Record an offline payment</h3>
            <p className="mt-1 text-xs text-slate-500">
              Writes a real transaction and starts a fresh {subscription.subscription_plans
                ? intervalLabel(subscription.subscription_plans).toLowerCase()
                : '30 day'} period from today. Marking it paid alone would record money that appears in no ledger.
            </p>
            <button disabled={saving === 'mark_paid'} onClick={markPaid} className="mt-3 w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm font-semibold text-emerald-700 disabled:opacity-60">
              {saving === 'mark_paid' ? 'Recording…' : 'Mark as paid'}
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-100 pt-5">
          <button
            disabled={!!saving}
            onClick={() => write({ cancel_at_period_end: true, status: 'canceled', canceled_at: new Date().toISOString() }, 'subscription_canceled')}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-4 py-2.5 text-sm font-semibold text-red-600 disabled:opacity-60"
          >
            <XCircle size={16} />Cancel subscription
          </button>
          <button
            disabled={!!saving || subscription.status !== 'canceled'}
            onClick={() => write({ cancel_at_period_end: false, status: 'active', canceled_at: null }, 'subscription_resumed')}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-40"
          >
            <Play size={16} />Resume subscription
          </button>
          <button
            disabled={!!saving || subscription.status === 'suspended'}
            onClick={() => setSuspended(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-40"
          >
            <Pause size={16} />Suspend restaurant
          </button>
          <button
            disabled={!!saving || subscription.status !== 'suspended'}
            onClick={() => setSuspended(false)}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 px-4 py-2.5 text-sm font-semibold text-emerald-700 disabled:opacity-40"
          >
            <Play size={16} />Reactivate restaurant
          </button>
        </div>
      </Card>

      <Card className="mt-6 overflow-hidden p-0">
        <div className="border-b border-slate-100 p-5">
          <h2 className="font-semibold text-slate-900">Payment history</h2>
          <p className="mt-1 text-sm text-slate-500">Payments recorded against this subscription.</p>
        </div>
        {payments.length
          ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="p-4 font-semibold">Date</th>
                  <th className="p-4 font-semibold">Amount</th>
                  <th className="p-4 font-semibold">Status</th>
                  <th className="p-4 font-semibold">Method</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className="border-t border-slate-100">
                    <td className="p-4 text-slate-500">{dateTime(payment.created_at)}</td>
                    <td className="p-4 text-slate-700">{money(payment.amount, payment.currency)}</td>
                    <td className="p-4"><StatusBadge status={payment.status === 'succeeded' ? 'active' : payment.status === 'failed' ? 'suspended' : payment.status} /></td>
                    <td className="p-4 text-slate-600">{payment.card_brand ? `${payment.card_brand} •••• ${payment.card_last4}` : payment.payment_method || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <EmptyState icon={Receipt} title="No payments recorded" description="Nothing has been charged to this subscription yet." />}
      </Card>
    </>
  )
}
