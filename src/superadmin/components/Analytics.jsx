import { Activity, BarChart3, CircleDollarSign, Gauge, TrendingDown, TrendingUp, Users } from 'lucide-react'
import { CURRENCY } from '../../../shared/slug.js'
import { useRpc } from '../lib/data'
import { money, plainNumber } from '../lib/format'
import { AreaChart, BarChart } from './Charts'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatCard } from './ui'

export default function Analytics() {
  // MRR, ARR and ARPU are totalled in the database, in the one currency the
  // platform bills in — so a subscription recorded in another currency before
  // that was true is converted rather than added at face value.
  const { data, loading, error, reload } = useRpc('super_admin_analytics', { p_currency: CURRENCY })

  if (loading && !data) return <Spinner label="Loading analytics" />

  if (error) {
    return (
      <section>
        <SectionHead eyebrow="BUSINESS INTELLIGENCE" title="Analytics" />
        <Notice tone="danger" action={<button onClick={reload} className="font-semibold underline">Retry</button>}>{error}</Notice>
      </section>
    )
  }

  const currency = CURRENCY
  const planMix = data?.plan_mix || []
  const byCountry = data?.revenue_by_country || []
  const hasSignups = (data?.monthly_signups || []).some((point) => Number(point.value) > 0)
  const hasChurn = (data?.monthly_cancellations || []).some((point) => Number(point.value) > 0)

  return (
    <>
      <SectionHead
        eyebrow="BUSINESS INTELLIGENCE"
        title="Analytics"
        description="Recurring revenue, retention, and where the money comes from — every figure in US dollars."
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MRR" value={money(data?.mrr, currency)} hint={`${plainNumber(data?.paying_count)} paying subscriptions`} icon={CircleDollarSign} tone="text-indigo-600 bg-indigo-50" />
        <StatCard label="ARR" value={money(data?.arr, currency)} hint="Annualised from current MRR" icon={TrendingUp} tone="text-emerald-600 bg-emerald-50" />
        <StatCard label="ARPU" value={money(data?.arpu, currency)} hint="Average revenue per paying restaurant" icon={Users} tone="text-sky-600 bg-sky-50" />
        <StatCard
          label="LTV"
          value={data?.ltv === null || data?.ltv === undefined ? 'Not yet known' : money(data.ltv, currency)}
          hint={data?.ltv === null || data?.ltv === undefined ? 'Needs some recorded churn before lifetime value is measurable' : 'ARPU divided by monthly churn'}
          icon={Gauge}
          tone="text-violet-600 bg-violet-50"
        />
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-amber-50 text-amber-600"><TrendingDown size={19} /></span>
            <h2 className="font-semibold text-slate-900">Churn (30 days)</h2>
          </div>
          <strong className="mt-5 block text-3xl tracking-tight text-slate-900">{plainNumber(data?.churn_rate_30d)}%</strong>
          <p className="mt-2 text-sm text-slate-500">{plainNumber(data?.canceled_30d)} subscription{data?.canceled_30d === 1 ? '' : 's'} cancelled in the last 30 days.</p>
        </Card>
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-50 text-emerald-600"><Activity size={19} /></span>
            <h2 className="font-semibold text-slate-900">Trial conversion</h2>
          </div>
          <strong className="mt-5 block text-3xl tracking-tight text-slate-900">{plainNumber(data?.trial_conversion_rate)}%</strong>
          <p className="mt-2 text-sm text-slate-500">{plainNumber(data?.trials_converted)} of {plainNumber(data?.trials_started)} trials have converted to paid.</p>
        </Card>
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-sky-50 text-sky-600"><BarChart3 size={19} /></span>
            <h2 className="font-semibold text-slate-900">Plan mix</h2>
          </div>
          {planMix.length
            ? (
              <ul className="mt-5 grid gap-2 text-sm">
                {planMix.map((plan) => (
                  <li key={plan.name} className="flex items-center gap-3">
                    <span className="text-slate-600">{plan.name}</span>
                    <strong className="ml-auto text-slate-900">{plainNumber(plan.count)}</strong>
                    <span className="w-20 text-right text-slate-400">{money(plan.mrr, currency)}</span>
                  </li>
                ))}
              </ul>
            )
            : <p className="mt-4 text-sm text-slate-500">No subscriptions yet.</p>}
        </Card>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="font-semibold text-slate-900">Signups</h2>
          <p className="mt-1 text-sm text-slate-500">Restaurants created per month.</p>
          {hasSignups
            ? <div className="mt-6"><AreaChart points={data.monthly_signups} currency={currency} format={(value) => `${value} restaurant${value === 1 ? '' : 's'}`} /></div>
            : <div className="mt-6"><EmptyState icon={BarChart3} title="No signups recorded" description="No restaurants have been created in the last 12 months." /></div>}
        </Card>
        <Card className="p-6">
          <h2 className="font-semibold text-slate-900">Cancellations</h2>
          <p className="mt-1 text-sm text-slate-500">Subscriptions cancelled per month.</p>
          {hasChurn
            ? <div className="mt-8"><BarChart points={data.monthly_cancellations} height={140} ariaLabel="Cancellations per month" /></div>
            : <div className="mt-6"><EmptyState icon={TrendingDown} title="No cancellations" description="Nothing has been cancelled in the last 12 months." /></div>}
        </Card>
      </section>

      <Card className="mt-6 overflow-hidden p-0">
        <div className="border-b border-slate-100 p-5">
          <h2 className="font-semibold text-slate-900">Revenue by country</h2>
          <p className="mt-1 text-sm text-slate-500">Where your restaurants are and what they have paid.</p>
        </div>
        {byCountry.length
          ? (
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="p-4 font-semibold">Country</th>
                  <th className="p-4 font-semibold">Restaurants</th>
                  <th className="p-4 font-semibold">Collected</th>
                </tr>
              </thead>
              <tbody>
                {byCountry.map((row) => (
                  <tr key={row.country} className="border-t border-slate-100">
                    <td className="p-4 font-medium text-slate-800">{row.country}</td>
                    <td className="p-4 text-slate-600">{plainNumber(row.restaurants)}</td>
                    <td className="p-4 text-slate-600">{money(row.collected, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <EmptyState icon={Users} title="No restaurants yet" description="Country breakdown appears once restaurants exist." />}
      </Card>

      <div className="mt-6">
        <Notice tone="info">
          <strong className="font-semibold">Peak usage hours and scan counts are not shown yet.</strong>{' '}
          Those come from logged table scans, and the server-side session tables have not been built.
          Until then there is no honest source for usage timing.
        </Notice>
      </div>
    </>
  )
}
