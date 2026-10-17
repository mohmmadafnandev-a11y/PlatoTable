import { useCallback, useEffect, useState } from 'react'
import { CircleDollarSign, Download, Landmark, Plus, TrendingDown, TrendingUp } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logActivity, useRestaurants } from '../lib/data'
import { downloadCsv, money, plainNumber, relativeTime, revenueTrend, shortDate } from '../lib/format'
import { CURRENCY } from '../../../shared/slug.js'
import { AreaChart } from './Charts'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, StatCard, StatusBadge, inputClass } from './ui'

function AdjustmentForm({ profile, onSaved, onCancel }) {
  const [form, setForm] = useState({ amount: '', type: 'credit', restaurant_id: '', notes: '' })
  const [state, setState] = useState({ saving: false, message: '', tone: 'info' })
  const update = (patch) => setForm((current) => ({ ...current, ...patch }))

  const submit = async (event) => {
    event.preventDefault()
    const amount = Number(form.amount)
    if (!amount || amount <= 0) return setState({ saving: false, message: 'Enter an amount greater than zero.', tone: 'danger' })
    if (!form.notes.trim()) return setState({ saving: false, message: 'A note is required so the adjustment can be explained later.', tone: 'danger' })

    setState({ saving: true, message: '', tone: 'info' })
    const { error } = await supabase.from('wallet_transactions').insert({
      amount,
      currency: CURRENCY,
      type: form.type,
      source: 'manual',
      status: 'completed',
      restaurant_id: form.restaurant_id || null,
      notes: form.notes.trim(),
    })
    if (error) return setState({ saving: false, message: error.message, tone: 'danger' })
    await logActivity({ superAdminId: profile?.id, action: 'wallet_adjusted', details: { amount, currency: CURRENCY, type: form.type } })
    setState({ saving: false, message: 'Adjustment recorded.', tone: 'success' })
    setForm({ amount: '', type: form.type, restaurant_id: '', notes: '' })
    onSaved()
  }

  return (
    <Card className="p-6">
      <h2 className="font-semibold text-slate-900">Manual wallet adjustment</h2>
      <p className="mt-1 text-sm text-slate-500">
        For corrections Safepay is not aware of, such as a bank transfer or a goodwill credit.
        Safepay settles to the bank on its own schedule and does not report that to this platform, so a settlement is recorded here by hand.
      </p>
      <form onSubmit={submit} className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label={`Amount (${CURRENCY})`} hint={`Recorded in ${CURRENCY}, the only currency this platform bills in.`}>
          <input type="number" min="0" step="0.01" className={inputClass} value={form.amount} onChange={(event) => update({ amount: event.target.value })} placeholder="0.00" required />
        </Field>
        <Field label="Direction">
          <select className={inputClass} value={form.type} onChange={(event) => update({ type: event.target.value })}>
            <option value="credit">Credit — money in</option>
            <option value="debit">Debit — money out</option>
          </select>
        </Field>
        <Field label="Note" hint="Required, and says why this adjustment exists.">
          <input className={inputClass} value={form.notes} onChange={(event) => update({ notes: event.target.value })} placeholder="Reason for this adjustment" required />
        </Field>
        {state.message && <div className="sm:col-span-2"><Notice tone={state.tone}>{state.message}</Notice></div>}
        <div className="flex gap-3 sm:col-span-2">
          <button disabled={state.saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
            <Plus size={16} />{state.saving ? 'Recording…' : 'Record adjustment'}
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
        </div>
      </form>
    </Card>
  )
}

export default function Revenue({ profile }) {
  const { restaurants } = useRestaurants()
  const [wallet, setWallet] = useState([])
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adjusting, setAdjusting] = useState(false)

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return Promise.all([
      supabase.from('wallet_transactions').select('*, restaurants(name)').order('created_at', { ascending: false }).limit(200),
      // `restaurant_name` is the copy kept on the row, which is all that is left
      // to show for a payment whose restaurant was removed while its ledger was
      // kept. Reading it here is what keeps those payments in the revenue totals.
      supabase.from('payment_transactions').select('id, amount, currency, status, created_at, restaurant_name, restaurants(name)').eq('status', 'succeeded').order('created_at', { ascending: false }).limit(500),
    ]).then(([walletResult, paymentResult]) => {
      const failure = walletResult.error || paymentResult.error
      if (failure) setError(failure.message)
      else {
        setWallet(walletResult.data || [])
        setPayments(paymentResult.data || [])
        setError('')
      }
      setLoading(false)
    })
  }, [])

  useEffect(() => { load() }, [load])

  // One currency, so both ledgers add up directly. Rows recorded before the
  // platform billed in dollars were converted when they were written, which is
  // what keeps this a sum rather than a conversion with a rate to look up.
  const completed = wallet.filter((row) => row.status === 'completed')
  const balance = completed.reduce((total, row) => total + (row.type === 'credit' ? Number(row.amount) : -Number(row.amount)), 0)
  const pending = wallet.filter((row) => row.status === 'pending')

  const startOfMonth = (offset = 0) => {
    const date = new Date()
    date.setMonth(date.getMonth() - offset, 1)
    date.setHours(0, 0, 0, 0)
    return date
  }
  const currentStart = startOfMonth(0)
  const previousStart = startOfMonth(1)
  const thisMonthPayments = payments.filter((row) => new Date(row.created_at) >= currentStart)
  const lastMonthPayments = payments.filter((row) => {
    const at = new Date(row.created_at)
    return at >= previousStart && at < currentStart
  })
  const total = (rows) => rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const revenue = { this_month: total(thisMonthPayments), last_month: total(lastMonthPayments) }
  const trend = revenueTrend(revenue)
  const currency = CURRENCY

  const monthly = (() => {
    const buckets = []
    for (let index = 11; index >= 0; index -= 1) {
      const start = startOfMonth(index)
      const end = startOfMonth(index - 1)
      buckets.push({
        label: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
        value: total(payments.filter((row) => { const at = new Date(row.created_at); return at >= start && at < end })),
      })
    }
    return buckets
  })()

  // Ranked by what each restaurant actually paid. Every figure is a dollar figure
  // by the time it is stored, so this is a direct comparison rather than a
  // conversion with a rate that might be missing.
  const topRestaurants = [...restaurants]
    .filter((item) => Number(item.paid_total) > 0)
    .sort((a, b) => Number(b.paid_total) - Number(a.paid_total))
    .slice(0, 5)

  const exportCsv = () => downloadCsv(`revenue-${new Date().toISOString().slice(0, 10)}.csv`, payments, [
    { label: 'Date', value: (row) => shortDate(row.created_at) },
    { label: 'Restaurant', value: (row) => row.restaurants?.name || row.restaurant_name || '' },
    { label: 'Amount', value: (row) => row.amount },
    { label: 'Currency', value: () => CURRENCY },
  ])

  if (loading && !payments.length && !wallet.length) return <Spinner label="Loading revenue" />

  return (
    <>
      <SectionHead
        eyebrow="PLATFORM FINANCE"
        title="Revenue & wallet"
        description="What restaurants have paid, and what is sitting in the platform balance."
        action={
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setAdjusting(!adjusting)} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700">
              <Plus size={16} />Manual adjustment
            </button>
            <button onClick={exportCsv} disabled={!payments.length} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
              <Download size={16} />Export CSV
            </button>
          </div>
        }
      />

      {error && <div className="mb-4"><Notice tone="danger" action={<button onClick={load} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Wallet balance" value={money(balance, currency)} hint={`${plainNumber(completed.length)} completed ledger entries`} icon={Landmark} tone="text-indigo-600 bg-indigo-50" />
        <StatCard label="This month" value={money(revenue.this_month, currency)} hint={`Last month ${money(revenue.last_month, currency)}`} icon={CircleDollarSign} tone="text-emerald-600 bg-emerald-50" trend={trend} />
        <StatCard label="Pending payouts" value={plainNumber(pending.length)} hint={pending.length ? 'Awaiting settlement' : 'Nothing outstanding'} icon={TrendingUp} tone="text-amber-600 bg-amber-50" />
        <StatCard label="Successful payments" value={plainNumber(payments.length)} hint="Recorded by verified webhooks only" icon={TrendingDown} tone="text-sky-600 bg-sky-50" />
      </section>

      {adjusting && (
        <div className="mt-6">
          <AdjustmentForm profile={profile} onSaved={load} onCancel={() => setAdjusting(false)} />
        </div>
      )}

      <Card className="mt-6 p-6">
        <h2 className="font-semibold text-slate-900">Collected revenue</h2>
        <p className="mt-1 text-sm text-slate-500">Successful payments per month.</p>
        {monthly.some((point) => point.value > 0)
          ? <div className="mt-6"><AreaChart points={monthly} currency={currency} /></div>
          : <p className="mt-6 text-sm text-slate-500">No successful payments yet.</p>}
      </Card>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-slate-100 p-5">
            <h2 className="font-semibold text-slate-900">Top restaurants by revenue</h2>
          </div>
          {topRestaurants.length
            ? (
              <ul className="divide-y divide-slate-100">
                {topRestaurants.map((item, index) => (
                  <li key={item.id} className="flex items-center gap-4 px-5 py-4 text-sm">
                    <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500">{index + 1}</span>
                    <span className="font-medium text-slate-800">{item.name}</span>
                    <StatusBadge status={item.subscription?.status} />
                    <strong className="ml-auto text-slate-900">{money(item.paid_total, currency)}</strong>
                  </li>
                ))}
              </ul>
            )
            : <EmptyState icon={CircleDollarSign} title="No revenue yet" description="Once restaurants start paying, the leaders appear here." />}
        </Card>

        <Card className="overflow-hidden p-0">
          <div className="border-b border-slate-100 p-5">
            <h2 className="font-semibold text-slate-900">Wallet ledger</h2>
            <p className="mt-1 text-sm text-slate-500">The most recent movements in and out.</p>
          </div>
          {wallet.length
            ? (
              <ul className="divide-y divide-slate-100">
                {wallet.slice(0, 8).map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
                    <span className={`font-semibold ${row.type === 'credit' ? 'text-emerald-600' : 'text-red-600'}`}>
                      {row.type === 'credit' ? '+' : '−'}{money(row.amount, currency)}
                    </span>
                    <span className="text-slate-600">{row.restaurants?.name || row.source || 'Platform'}</span>
                    <span className="ml-auto text-xs text-slate-400">{relativeTime(row.created_at)}</span>
                  </li>
                ))}
              </ul>
            )
            : <EmptyState icon={Landmark} title="Empty ledger" description="Wallet movements will be listed here." />}
        </Card>
      </section>

      <Card className="mt-6 overflow-hidden p-0">
        <div className="border-b border-slate-100 p-5">
          <h2 className="font-semibold text-slate-900">Recent successful payments</h2>
        </div>
        {payments.length
          ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="p-4 font-semibold">Date</th>
                  <th className="p-4 font-semibold">Restaurant</th>
                  <th className="p-4 font-semibold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.slice(0, 10).map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="p-4 text-slate-500">{shortDate(row.created_at)}</td>
                    <td className="p-4 font-medium text-slate-800">{row.restaurants?.name || row.restaurant_name || 'Restaurant'}</td>
                    <td className="p-4 text-slate-700">{money(row.amount, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <EmptyState icon={CircleDollarSign} title="No payments yet" description="Nothing has been collected on this platform so far." />}
      </Card>
    </>
  )
}
