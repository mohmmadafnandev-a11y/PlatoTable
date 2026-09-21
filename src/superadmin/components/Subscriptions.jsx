import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, CreditCard, Play, Pause, Receipt, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logActivity } from '../lib/data'
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
        .select('*, restaurants(id, name, subdomain, is_active, currency), subscription_plans(id, name)')
        .order('created_at', { ascending: false }),
      supabase.from('subscription_plans').select('id, name, price_usd, price_aed, price_pkr, price_gbp, price_sar').order('created_at'),
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
    const price = plan[`price_${currency.toLowerCase()}`] ?? plan.price_usd
    return write({ plan_id: plan.id, amount: price, currency }, 'subscription_plan_changed', { plan: plan.name, amount: price, currency })
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
    if (!window.confirm(`Record an offline payment of ${money(subscription.amount, subscription.currency)} and extend one month?`)) return
    setSaving('mark_paid')
    const periodStart = new Date()
    const periodEnd = new Date(periodStart)
    periodEnd.setMonth(periodEnd.getMonth() + 1)

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
        last_payment_status: 'succeeded',
        current_period_start: periodStart.toISOString(),
        current_period_end: periodEnd.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscription.id)
    setSaving('')
    if (updateError) return setFeedback({ tone: 'danger', text: updateError.message })
    await logActivity({ superAdminId: profile?.id, restaurantId, action: 'subscription_paid_manually', details: { amount: subscription.amount } })
    setFeedback({ tone: 'success', text: 'Offline payment recorded and the period extended by one month.' })
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
        <StatCard label="Recurring amount" value={money(subscription.amount, subscription.currency)} hint={subscription.subscription_plans?.name || 'Custom plan'} icon={CreditCard} tone="text-indigo-600 bg-indigo-50" />
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

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Extend access</h3>
            <p className="mt-1 text-xs text-slate-500">Adds days to the {subscription.status === 'trialing' ? 'trial' : 'billing period'}.</p>
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
            <select
              disabled={!plans.length || !!saving}
              value={subscription.plan_id || ''}
              onChange={(event) => changePlan(event.target.value)}
              className={`${inputClass} mt-3 w-full`}
            >
              <option value="">Custom plan (no catalogue plan)</option>
              {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
            </select>
            {!plans.length && <p className="mt-2 text-xs text-amber-700">No plans exist yet. Create one under Plans & pricing.</p>}
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="text-sm font-semibold text-slate-800">Record an offline payment</h3>
            <p className="mt-1 text-xs text-slate-500">Writes a real transaction and extends the period by one month.</p>
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
