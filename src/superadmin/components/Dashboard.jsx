import {
  Bell,
  Building2,
  CircleDollarSign,
  CreditCard,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useDashboard } from '../lib/data'
import { money, plainNumber, relativeTime, revenueTrend } from '../lib/format'
import { AreaChart, BarChart, PlanDistribution } from './Charts'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatCard } from './ui'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function buildAlerts(data) {
  const alerts = []
  const { subscriptions = {}, restaurant_inactive: inactive = 0, trials_ending_soon: ending = 0 } = data

  if (subscriptions.suspended) {
    alerts.push({
      tone: 'danger',
      text: `${subscriptions.suspended} restaurant${subscriptions.suspended === 1 ? ' is' : 's are'} suspended and cannot show a menu to guests.`,
    })
  }
  if (subscriptions.past_due) {
    alerts.push({
      tone: 'warning',
      text: `${subscriptions.past_due} subscription${subscriptions.past_due === 1 ? ' is' : 's are'} past due and need a payment retry.`,
    })
  }
  if (ending) {
    alerts.push({
      tone: 'warning',
      text: `${ending} trial${ending === 1 ? '' : 's'} end${ending === 1 ? 's' : ''} in the next three days.`,
    })
  }
  if (inactive) {
    alerts.push({ tone: 'info', text: `${inactive} restaurant${inactive === 1 ? ' is' : 's are'} switched off.` })
  }
  return alerts
}

export default function Dashboard({ navigate }) {
  const { data, loading, error, reload } = useDashboard()

  if (loading && !data) return <Spinner label="Loading platform overview" />

  if (error) {
    return (
      <section>
        <SectionHead eyebrow="PLATFORM OVERVIEW" title="Dashboard" />
        <Notice tone="danger" action={<button onClick={reload} className="font-semibold underline">Retry</button>}>
          {error}
        </Notice>
      </section>
    )
  }
  if (!data) {
    return (
      <section>
        <SectionHead eyebrow="PLATFORM OVERVIEW" title="Dashboard" />
        <Notice tone="danger">This account is not a platform staff member, so platform figures are not available.</Notice>
      </section>
    )
  }

  const revenue = data.revenue || {}
  const currency = revenue.currency || 'USD'
  const subscriptions = data.subscriptions || {}
  const needAttention = (subscriptions.past_due || 0) + (subscriptions.suspended || 0)
  const alerts = buildAlerts(data)
  const trend = revenueTrend(revenue)
  const hasRevenue = Number(revenue.total || 0) > 0
  const statusRows = ['trialing', 'active', 'past_due', 'suspended', 'canceled']
    .map((label) => ({ label, count: subscriptions[label] || 0 }))

  return (
    <>
      <SectionHead
        eyebrow="PLATFORM OVERVIEW"
        title={greeting()}
        description="Live figures across every restaurant on the platform."
        action={
          <button
            onClick={() => navigate('/restaurants/new')}
            className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 active:scale-[.99]"
          >
            + Add restaurant
          </button>
        }
      />

      {alerts.length > 0 && (
        <div className="mb-6 grid gap-3">
          {alerts.map((alert) => (
            <Notice key={alert.text} tone={alert.tone}>{alert.text}</Notice>
          ))}
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Total revenue"
          value={money(revenue.total, currency)}
          hint={`${money(revenue.this_month, currency)} this month`}
          icon={CircleDollarSign}
          tone="text-indigo-600 bg-indigo-50"
        />
        <StatCard
          label="This month"
          value={money(revenue.this_month, currency)}
          hint={`Previous month ${money(revenue.last_month, currency)}`}
          icon={CreditCard}
          tone="text-emerald-600 bg-emerald-50"
          trend={trend}
        />
        <StatCard
          label="Restaurants"
          value={plainNumber(data.restaurant_total)}
          hint={`${plainNumber(data.restaurant_active)} active`}
          icon={Building2}
          tone="text-sky-600 bg-sky-50"
        />
        <StatCard
          label="Active subscriptions"
          value={plainNumber(subscriptions.active)}
          hint={`${plainNumber(subscriptions.canceled)} canceled`}
          icon={ShieldCheck}
          tone="text-violet-600 bg-violet-50"
        />
        <StatCard
          label="Trial users"
          value={plainNumber(subscriptions.trialing)}
          hint={data.trials_ending_soon ? `${data.trials_ending_soon} ending within 3 days` : 'None ending soon'}
          icon={Users}
          tone="text-amber-600 bg-amber-50"
        />
        <StatCard
          label="Needs attention"
          value={plainNumber(needAttention)}
          hint={`${plainNumber(subscriptions.past_due)} past due · ${plainNumber(subscriptions.suspended)} suspended`}
          icon={Bell}
          tone="text-red-600 bg-red-50"
        />
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_.85fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Revenue trend</h2>
              <p className="mt-1 text-sm text-slate-500">
                {hasRevenue ? 'Collected payments over the last 12 months.' : 'Revenue will appear as payments arrive.'}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">Last 12 months</span>
          </div>
          {hasRevenue
            ? <div className="mt-6"><AreaChart points={data.monthly_revenue || []} currency={currency} /></div>
            : (
              <div className="mt-6 grid h-44 place-items-center rounded-lg border border-dashed border-slate-200 bg-slate-50 text-center">
                <div>
                  <CircleDollarSign className="mx-auto text-slate-300" size={26} />
                  <p className="mt-3 text-sm font-medium text-slate-600">No revenue yet</p>
                  <p className="mt-1 text-xs text-slate-500">Verified Stripe payments will populate this chart.</p>
                </div>
              </div>
            )}
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-slate-900">Subscription mix</h2>
          <p className="mt-1 text-sm text-slate-500">Where every restaurant currently sits.</p>
          <div className="mt-6">
            {statusRows.some((row) => row.count > 0)
              ? <PlanDistribution rows={statusRows} />
              : <p className="text-sm text-slate-500">No subscriptions yet.</p>}
          </div>
        </Card>
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_.85fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">New signups</h2>
              <p className="mt-1 text-sm text-slate-500">Restaurants created in the last 30 days.</p>
            </div>
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">30 days</span>
          </div>
          {(data.daily_signups || []).some((point) => Number(point.value) > 0)
            ? <div className="mt-8"><BarChart points={data.daily_signups} ariaLabel="New restaurants per day over 30 days" /></div>
            : <p className="mt-6 text-sm text-slate-500">No signups in the last 30 days.</p>}
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold text-slate-900">Quick actions</h2>
          <p className="mt-1 text-sm text-slate-500">Start managing your platform.</p>
          <div className="mt-5 grid gap-2">
            <button onClick={() => navigate('/restaurants/new')} className="rounded-lg bg-indigo-600 px-4 py-3 text-left text-sm font-semibold text-white transition hover:bg-indigo-700">Add a restaurant</button>
            <button onClick={() => navigate('/restaurants')} className="rounded-lg border border-slate-200 px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Browse all restaurants</button>
            <button onClick={() => navigate('/subscriptions')} className="rounded-lg border border-slate-200 px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Review subscriptions</button>
            <button onClick={() => navigate('/settings')} className="rounded-lg border border-slate-200 px-4 py-3 text-left text-sm font-semibold text-slate-700 transition hover:bg-slate-50">Configure platform</button>
          </div>
        </Card>
      </section>

      <Card className="mt-6 overflow-hidden p-0">
        <div className="border-b border-slate-100 p-5">
          <h2 className="font-semibold text-slate-900">Recent activity</h2>
          <p className="mt-1 text-sm text-slate-500">The latest platform actions recorded in the audit trail.</p>
        </div>
        {(data.recent_activity || []).length
          ? (
            <ul className="divide-y divide-slate-100">
              {data.recent_activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 text-sm">
                  <strong className="font-semibold capitalize text-slate-800">{String(entry.action).replace(/_/g, ' ')}</strong>
                  <span className="text-slate-500">{entry.restaurant || 'Platform'}</span>
                  <span className="ml-auto text-xs text-slate-400">
                    {entry.actor ? `${entry.actor} · ` : ''}{relativeTime(entry.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )
          : <EmptyState icon={Building2} title="No activity yet" description="Onboarding your first restaurant will start the audit trail." />}
      </Card>
    </>
  )
}
