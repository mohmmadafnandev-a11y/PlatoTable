import { useCallback, useEffect, useState } from 'react'
import { CreditCard, Download, Receipt } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { dateTime, downloadCsv, money, plainNumber } from '../lib/format'
import { COUNTRIES } from '../../../shared/slug.js'
import { UpcomingPayments } from './Subscriptions'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

const PAGE_SIZE = 25
const STATUSES = ['succeeded', 'pending', 'failed', 'refunded']

export default function Transactions() {
  const [rows, setRows] = useState([])
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('all')
  const [restaurant, setRestaurant] = useState('all')
  const [country, setCountry] = useState('all')
  const [plan, setPlan] = useState('all')
  // Which plan each subscription is on. A payment names a subscription, not a
  // plan, so this is what lets the plan filter below be exact on the server
  // rather than a guess made in the browser.
  const [planIndex, setPlanIndex] = useState([])
  const [plans, setPlans] = useState([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [minAmount, setMinAmount] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [limit, setLimit] = useState(PAGE_SIZE)

  const planSubscriptionIds = plan === 'all' ? null : planIndex.filter((item) => item.plan_id === plan).map((item) => item.id)

  const fetchRows = useCallback(() => {
    if (!supabase) return Promise.resolve()
    // A plan with no subscribers can never match, so there is nothing to ask for.
    // Deferred through a promise rather than set inline: state set synchronously
    // inside the effect that calls this would cause a second render on mount.
    if (planSubscriptionIds && !planSubscriptionIds.length) {
      return Promise.resolve().then(() => { setRows([]); setError(''); setLoading(false) })
    }
    let query = supabase
      .from('payment_transactions')
      // `!inner` so the embedded restaurant can be filtered on: a payment always
      // belongs to a restaurant, so this drops nothing but lets the country
      // filter run in the database instead of over a capped page of rows.
      .select('*, restaurants!inner(name, subdomain, country)')
      .order('created_at', { ascending: false })
      .limit(500)

    if (status !== 'all') query = query.eq('status', status)
    if (restaurant !== 'all') query = query.eq('restaurant_id', restaurant)
    if (country !== 'all') query = query.eq('restaurants.country', country)
    if (planSubscriptionIds) query = query.in('subscription_id', planSubscriptionIds)
    if (from) query = query.gte('created_at', new Date(from).toISOString())
    if (to) query = query.lte('created_at', new Date(`${to}T23:59:59`).toISOString())
    if (minAmount) query = query.gte('amount', Number(minAmount))

    return query.then(({ data, error: requestError }) => {
      if (requestError) setError(requestError.message)
      else { setRows(data || []); setError('') }
      setLoading(false)
    })
  }, [status, restaurant, country, from, to, minAmount, planSubscriptionIds])

  useEffect(() => { fetchRows() }, [fetchRows])

  useEffect(() => {
    if (!supabase) return
    supabase.rpc('super_admin_restaurants').then(({ data }) => {
      if (Array.isArray(data)) setRestaurants(data.map((item) => ({ id: item.id, name: item.name })))
    })
  }, [])

  useEffect(() => {
    if (!supabase) return
    Promise.all([
      supabase.from('subscription_plans').select('id, name').order('name'),
      supabase.from('subscriptions').select('id, plan_id'),
    ]).then(([planResult, subscriptionResult]) => {
      setPlans(planResult.data || [])
      setPlanIndex(subscriptionResult.data || [])
    })
  }, [])

  const visible = rows.slice(0, limit)
  const collected = rows
    .filter((row) => row.status === 'succeeded')
    .reduce((total, row) => total + Number(row.amount || 0), 0)
  const currency = rows.find((row) => row.status === 'succeeded')?.currency || 'USD'

  const exportCsv = () => downloadCsv(`transactions-${new Date().toISOString().slice(0, 10)}.csv`, rows, [
    { label: 'Date', value: (row) => dateTime(row.created_at) },
    { label: 'Restaurant', value: (row) => row.restaurants?.name || '' },
    { label: 'Country', value: (row) => row.restaurants?.country || '' },
    { label: 'Amount', value: (row) => row.amount },
    { label: 'Currency', value: (row) => row.currency },
    { label: 'Status', value: (row) => row.status },
    { label: 'Method', value: (row) => row.card_brand ? `${row.card_brand} ****${row.card_last4}` : row.payment_method },
    { label: 'Provider id', value: (row) => row.provider_transaction_id },
  ])

  const filtered = status !== 'all' || restaurant !== 'all' || country !== 'all' || plan !== 'all' || from || to || minAmount

  return (
    <>
      <SectionHead
        eyebrow="PAYMENT RECORDS"
        title="Transactions"
        description="Every payment Stripe has reported. Only verified webhooks write these rows."
        action={
          <button onClick={exportCsv} disabled={!rows.length} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
            <Download size={16} />Export CSV
          </button>
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Records matching filters</p>
          <strong className="mt-1 block text-2xl text-slate-900">{plainNumber(rows.length)}</strong>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Collected</p>
          <strong className="mt-1 block text-2xl text-slate-900">{money(collected, currency)}</strong>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Failed or refunded</p>
          <strong className="mt-1 block text-2xl text-slate-900">
            {plainNumber(rows.filter((row) => row.status === 'failed' || row.status === 'refunded').length)}
          </strong>
        </Card>
      </div>

      <UpcomingPayments />

      <div className="mb-4 mt-6 flex flex-wrap gap-3">
        <select value={status} onChange={(event) => setStatus(event.target.value)} className={inputClass}>
          <option value="all">All statuses</option>
          {STATUSES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={restaurant} onChange={(event) => setRestaurant(event.target.value)} className={inputClass}>
          <option value="all">All restaurants</option>
          {restaurants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select value={country} onChange={(event) => setCountry(event.target.value)} className={inputClass}>
          <option value="all">All countries</option>
          {COUNTRIES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
        </select>
        <select value={plan} onChange={(event) => setPlan(event.target.value)} className={inputClass}>
          <option value="all">All plans</option>
          {plans.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={inputClass} aria-label="From date" />
        <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className={inputClass} aria-label="To date" />
        <input type="number" min="0" step="0.01" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} placeholder="Minimum amount" className={`${inputClass} w-40`} />
        {filtered && (
          <button onClick={() => { setStatus('all'); setRestaurant('all'); setCountry('all'); setPlan('all'); setFrom(''); setTo(''); setMinAmount('') }} className="h-11 rounded-lg px-3 text-sm font-semibold text-indigo-600">Clear filters</button>
        )}
      </div>

      {error && <div className="mb-4"><Notice tone="danger" action={<button onClick={fetchRows} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <Card className="overflow-hidden p-0">
        {loading && !rows.length
          ? <Spinner label="Loading transactions" />
          : visible.length
            ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="p-4 font-semibold">Date</th>
                        <th className="p-4 font-semibold">Restaurant</th>
                        <th className="p-4 font-semibold">Amount</th>
                        <th className="p-4 font-semibold">Status</th>
                        <th className="p-4 font-semibold">Method</th>
                        <th className="p-4" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row) => (
                        <tr key={row.id} className="border-t border-slate-100 align-top transition hover:bg-indigo-50/40">
                          <td className="p-4 text-slate-500">
                            {dateTime(row.created_at)}
                            <small className="mt-1 block text-xs text-slate-400">{row.provider || 'stripe'}</small>
                          </td>
                          <td className="p-4">
                            <strong className="block font-medium text-slate-800">{row.restaurants?.name || 'Unknown restaurant'}</strong>
                            <small className="mt-1 block text-xs text-slate-400">{row.restaurants?.country || ''}</small>
                          </td>
                          <td className="p-4 font-medium text-slate-800">{money(row.amount, row.currency)}</td>
                          <td className="p-4"><StatusBadge status={row.status === 'succeeded' ? 'active' : row.status === 'failed' ? 'suspended' : row.status} /></td>
                          <td className="p-4 text-slate-600">
                            {row.card_brand ? `${row.card_brand} •••• ${row.card_last4}` : row.payment_method || '—'}
                          </td>
                          <td className="p-4 text-right">
                            <button onClick={() => setExpanded(expanded === row.id ? null : row.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
                              {expanded === row.id ? 'Hide' : 'Details'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {expanded && (() => {
                  const row = rows.find((item) => item.id === expanded)
                  if (!row) return null
                  const fields = [
                    ['Transaction id', row.id],
                    ['Stripe transaction', row.provider_transaction_id],
                    ['Subscription', row.subscription_id],
                    ['Provider', row.provider],
                    ['Payment method', row.payment_method],
                    ['Card', row.card_brand ? `${row.card_brand} ending ${row.card_last4}` : '—'],
                    ['Created', dateTime(row.created_at)],
                  ]
                  return (
                    <div className="border-t border-slate-200 bg-slate-50 p-5">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Transaction detail</h3>
                      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {fields.map(([label, value]) => (
                          <div key={label}>
                            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
                            <dd className="mt-1 break-all text-sm text-slate-700">{value || '—'}</dd>
                          </div>
                        ))}
                      </dl>
                      <p className="mt-4 text-xs text-slate-500">
                        Refunds are processed in Stripe. This screen records what Stripe reports back; it never initiates one.
                      </p>
                    </div>
                  )
                })()}

                {rows.length > limit && (
                  <div className="border-t border-slate-100 p-4 text-center">
                    <button onClick={() => setLimit(limit + PAGE_SIZE)} className="text-sm font-semibold text-indigo-600">Load more</button>
                  </div>
                )}
              </>
            )
            : <EmptyState
              icon={filtered ? Receipt : CreditCard}
              title={filtered ? 'No transactions match these filters' : 'No transactions yet'}
              description={filtered ? 'Try a wider date range or clear the filters.' : 'Payments appear here once Stripe reports them through a verified webhook.'}
            />}
      </Card>
    </>
  )
}
