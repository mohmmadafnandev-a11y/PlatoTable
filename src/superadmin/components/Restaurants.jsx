import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  Download,
  ExternalLink,
  Eye,
  Pause,
  Play,
  QrCode,
  Settings2,
  UtensilsCrossed,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logActivity, useRestaurants } from '../lib/data'
import StripeSubscriptionLink from './StripeSubscriptionLink'
import { STATUSES, dateTime, downloadCsv, money, plainNumber, shortDate } from '../lib/format'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatusBadge } from './ui'

const PAGE_SIZE = 10
const SORTS = {
  joined: (a, b) => new Date(b.created_at) - new Date(a.created_at),
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
  qr: (a, b) => (b.qr_count || 0) - (a.qr_count || 0),
  menu: (a, b) => (b.menu_item_count || 0) - (a.menu_item_count || 0),
  revenue: (a, b) => Number(b.paid_total || 0) - Number(a.paid_total || 0),
}

/**
 * Suspension is recorded in two places on purpose: `is_active` is what the
 * public tenant lookup and the QR menu honour, while the subscription status is
 * what the billing screens report. Writing one without the other leaves the two
 * views disagreeing about the same restaurant.
 */
async function setSuspended(restaurant, suspended, superAdminId) {
  const { error: restaurantError } = await supabase
    .from('restaurants')
    .update({ is_active: !suspended, updated_at: new Date().toISOString() })
    .eq('id', restaurant.id)
  if (restaurantError) return { error: restaurantError }

  if (restaurant.subscription?.id) {
    const { error: subscriptionError } = await supabase
      .from('subscriptions')
      .update({ status: suspended ? 'suspended' : 'active', updated_at: new Date().toISOString() })
      .eq('id', restaurant.subscription.id)
    if (subscriptionError) return { error: subscriptionError }
  }

  await logActivity({
    superAdminId,
    restaurantId: restaurant.id,
    action: suspended ? 'restaurant_suspended' : 'restaurant_reactivated',
    details: { name: restaurant.name, subdomain: restaurant.subdomain },
  })
  return {}
}

function RestaurantRow({ restaurant, selected, onToggle, onOpen }) {
  return (
    <tr className="border-t border-slate-100 transition hover:bg-indigo-50/40">
      <td className="p-4">
        <input
          type="checkbox"
          className="h-4 w-4 accent-indigo-600"
          checked={selected}
          onChange={() => onToggle(restaurant.id)}
          aria-label={`Select ${restaurant.name}`}
        />
      </td>
      <td className="p-4">
        <button onClick={onOpen} className="flex items-center gap-3 text-left">
          {restaurant.logo_url
            ? <img src={restaurant.logo_url} alt="" className="h-9 w-9 rounded-lg border border-slate-200 object-cover" />
            : <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500">{(restaurant.name || 'R').slice(0, 2).toUpperCase()}</span>}
          <span>
            <strong className="block font-semibold text-slate-900 hover:text-indigo-600">{restaurant.name}</strong>
            <small className="mt-0.5 block text-xs text-slate-500">/{restaurant.subdomain || '—'}</small>
          </span>
        </button>
      </td>
      <td className="p-4 text-slate-600">
        {restaurant.owner_email || restaurant.contact_email || '—'}
        <small className="mt-1 block text-xs text-slate-400">{restaurant.phone || 'No phone'}</small>
      </td>
      <td className="p-4"><StatusBadge status={restaurant.subscription?.status} /></td>
      <td className="p-4 text-slate-600">
        {restaurant.subscription?.plan_name || 'Custom'}
        <small className="mt-1 block text-xs text-slate-400">
          {restaurant.subscription ? money(restaurant.subscription.amount, restaurant.subscription.currency) : 'Not configured'}
        </small>
      </td>
      <td className="p-4 text-slate-600">{plainNumber(restaurant.qr_count)}</td>
      <td className="p-4 text-slate-600">{plainNumber(restaurant.menu_item_count)}</td>
      <td className="p-4 text-slate-600">{money(restaurant.paid_total, restaurant.currency)}</td>
      <td className="p-4 text-slate-500">{shortDate(restaurant.created_at)}</td>
      <td className="p-4 text-right">
        <button onClick={onOpen} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-white">View</button>
      </td>
    </tr>
  )
}

export function Restaurants({ navigate, profile }) {
  const { restaurants, loading, error, reload } = useRestaurants()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [country, setCountry] = useState('all')
  const [sort, setSort] = useState('joined')
  const [selected, setSelected] = useState([])
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState(null)

  const countries = useMemo(
    () => [...new Set(restaurants.map((item) => item.country).filter(Boolean))].sort(),
    [restaurants],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return restaurants
      .filter((restaurant) => {
        if (status !== 'all' && (restaurant.subscription?.status || 'unconfigured') !== status) return false
        if (country !== 'all' && restaurant.country !== country) return false
        if (!needle) return true
        return `${restaurant.name} ${restaurant.owner_email || ''} ${restaurant.contact_email || ''} ${restaurant.phone || ''} ${restaurant.subdomain || ''}`
          .toLowerCase()
          .includes(needle)
      })
      .sort(SORTS[sort] || SORTS.joined)
  }, [restaurants, query, status, country, sort])

  // The page is derived from the active filter set rather than reset by an
  // effect: changing a filter makes `pageState.key` stale, which reads as page
  // one again without an extra render pass.
  const filterKey = `${query}\u0000${status}\u0000${country}\u0000${sort}`
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 })
  const page = pageState.key === filterKey ? pageState.page : 1
  const setPage = (next) => setPageState({ key: filterKey, page: next })

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const paged = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const allOnPageSelected = paged.length > 0 && paged.every((item) => selected.includes(item.id))

  const toggle = (id) => setSelected((ids) => (ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]))
  const togglePage = () => setSelected(allOnPageSelected
    ? selected.filter((id) => !paged.some((item) => item.id === id))
    : [...new Set([...selected, ...paged.map((item) => item.id)])])

  const applyBulk = async (suspended) => {
    const targets = restaurants.filter((item) => selected.includes(item.id))
    if (!targets.length) return
    const verb = suspended ? 'suspend' : 'reactivate'
    if (!window.confirm(`${verb === 'suspend' ? 'Suspend' : 'Reactivate'} ${targets.length} restaurant${targets.length === 1 ? '' : 's'}?`)) return
    setBusy(verb)
    setFeedback(null)
    for (const target of targets) {
      const { error: failure } = await setSuspended(target, suspended, profile?.id)
      if (failure) { setFeedback({ tone: 'danger', text: `${target.name}: ${failure.message}` }); break }
    }
    setBusy('')
    setSelected([])
    setFeedback({ tone: 'success', text: `${targets.length} restaurant${targets.length === 1 ? '' : 's'} ${verb === 'suspend' ? 'suspended' : 'reactivated'}.` })
    reload()
  }

  const exportCsv = () => {
    downloadCsv(`restaurants-${new Date().toISOString().slice(0, 10)}.csv`, visible, [
      { label: 'Name', value: (row) => row.name },
      { label: 'Slug', value: (row) => row.subdomain },
      { label: 'Owner email', value: (row) => row.owner_email },
      { label: 'Phone', value: (row) => row.phone },
      { label: 'Country', value: (row) => row.country },
      { label: 'Status', value: (row) => row.subscription?.status || 'unconfigured' },
      { label: 'Plan', value: (row) => row.subscription?.plan_name || 'Custom' },
      { label: 'QR codes', value: (row) => row.qr_count },
      { label: 'Menu items', value: (row) => row.menu_item_count },
      { label: 'Collected', value: (row) => row.paid_total },
      { label: 'Joined', value: (row) => shortDate(row.created_at) },
    ])
  }

  return (
    <>
      <SectionHead
        eyebrow="RESTAURANT DIRECTORY"
        title="Restaurants"
        description="Every restaurant, its subscription, and what it is actually using."
        action={
          <button onClick={() => navigate('/restaurants/new')} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700">
            + Add restaurant
          </button>
        }
      />

      {feedback && <div className="mb-4"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}

      <div className="mb-4 flex flex-wrap gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, email, phone, or slug"
          className="h-10 min-w-60 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-500"
        />
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <option value="all">All statuses</option>
          {STATUSES.map((value) => <option key={value} value={value}>{value.replace(/_/g, ' ')}</option>)}
          <option value="unconfigured">Not configured</option>
        </select>
        <select value={country} onChange={(event) => setCountry(event.target.value)} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <option value="all">All countries</option>
          {countries.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700">
          <option value="joined">Newest first</option>
          <option value="name">Name (A–Z)</option>
          <option value="qr">Most QR codes</option>
          <option value="menu">Most menu items</option>
          <option value="revenue">Highest revenue</option>
        </select>
        <button onClick={exportCsv} disabled={!visible.length} className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
          <Download size={16} />Export CSV
        </button>
      </div>

      {selected.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
          <strong>{selected.length} selected</strong>
          <button disabled={busy === 'suspend'} onClick={() => applyBulk(true)} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 font-semibold text-indigo-700 disabled:opacity-60">
            <Pause size={15} />Suspend
          </button>
          <button disabled={busy === 'reactivate'} onClick={() => applyBulk(false)} className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 font-semibold text-indigo-700 disabled:opacity-60">
            <Play size={15} />Reactivate
          </button>
          <button onClick={() => setSelected([])} className="ml-auto font-semibold">Clear</button>
        </div>
      )}

      {error && <div className="mb-4"><Notice tone="danger" action={<button onClick={reload} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <Card className="overflow-hidden p-0">
        {loading && !restaurants.length
          ? <Spinner label="Loading restaurants" />
          : visible.length
            ? (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="p-4">
                          <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={allOnPageSelected} onChange={togglePage} aria-label="Select all on this page" />
                        </th>
                        <th className="p-4 font-semibold">Restaurant</th>
                        <th className="p-4 font-semibold">Owner</th>
                        <th className="p-4 font-semibold">Status</th>
                        <th className="p-4 font-semibold">Plan</th>
                        <th className="p-4 font-semibold">QR</th>
                        <th className="p-4 font-semibold">Items</th>
                        <th className="p-4 font-semibold">Collected</th>
                        <th className="p-4 font-semibold">Joined</th>
                        <th className="p-4" />
                      </tr>
                    </thead>
                    <tbody>
                      {paged.map((restaurant) => (
                        <RestaurantRow
                          key={restaurant.id}
                          restaurant={restaurant}
                          selected={selected.includes(restaurant.id)}
                          onToggle={toggle}
                          onOpen={() => navigate(`/restaurants/${restaurant.id}`)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {pageCount > 1 && (
                  <div className="flex items-center justify-between gap-3 border-t border-slate-100 p-4 text-sm text-slate-600">
                    <span>Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, visible.length)} of {visible.length}</span>
                    <div className="flex gap-2">
                      <button disabled={safePage === 1} onClick={() => setPage(safePage - 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold disabled:opacity-40">Previous</button>
                      <button disabled={safePage === pageCount} onClick={() => setPage(safePage + 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold disabled:opacity-40">Next</button>
                    </div>
                  </div>
                )}
              </>
            )
            : <EmptyState
              icon={Building2}
              title={restaurants.length ? 'No restaurants match these filters' : 'No restaurants yet'}
              description={restaurants.length ? 'Try a different status, country, or search term.' : 'Onboard your first restaurant to get started.'}
              action={<button onClick={() => navigate('/restaurants/new')} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">+ Add restaurant</button>}
            />}
      </Card>
    </>
  )
}

function DetailRow({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 break-words text-sm text-slate-700">{children}</dd>
    </div>
  )
}

function useRestaurantChildren(restaurantId, table, columns, order) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    if (!supabase || !restaurantId) return undefined
    supabase.from(table).select(columns).eq('restaurant_id', restaurantId).order(order.column, { ascending: order.ascending })
      .then(({ data }) => { if (active) { setRows(data || []); setLoading(false) } })
    return () => { active = false }
  }, [restaurantId, table, columns, order.column, order.ascending])
  return { rows, loading }
}

export function RestaurantDetail({ navigate, id, profile }) {
  const { restaurants, loading, reload } = useRestaurants()
  const restaurant = restaurants.find((item) => item.id === id)
  const [tab, setTab] = useState('overview')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState(null)

  const menu = useRestaurantChildren(id, 'menu_items', 'id, name, price, is_available, category_id', { column: 'name', ascending: true })
  const tokens = useRestaurantChildren(id, 'qr_tokens', 'id, table_number, is_active, created_at', { column: 'table_number', ascending: true })
  const logs = useRestaurantChildren(id, 'activity_logs', 'id, action, details, created_at', { column: 'created_at', ascending: false })

  if (loading && !restaurant) return <Spinner label="Loading restaurant" />
  if (!restaurant) {
    return (
      <section>
        <button onClick={() => navigate('/restaurants')} className="mb-5 text-sm font-semibold text-indigo-600">← All restaurants</button>
        <Notice tone="warning">No restaurant matches that id. It may have been removed.</Notice>
      </section>
    )
  }

  const toggleActive = async () => {
    const suspended = restaurant.is_active !== false
    if (!window.confirm(`${suspended ? 'Suspend' : 'Reactivate'} ${restaurant.name}?`)) return
    setBusy(true)
    const { error } = await setSuspended(restaurant, suspended, profile?.id)
    setBusy(false)
    setFeedback(error ? { tone: 'danger', text: error.message } : { tone: 'success', text: `${restaurant.name} ${suspended ? 'suspended' : 'reactivated'}.` })
    reload()
  }

  const tabs = [
    ['overview', 'Overview'],
    ['subscription', 'Subscription'],
    ['menu', `Menu (${plainNumber(restaurant.menu_item_count)})`],
    ['qr', `QR codes (${plainNumber(restaurant.qr_count)})`],
    ['activity', 'Activity'],
  ]

  return (
    <>
      <button onClick={() => navigate('/restaurants')} className="mb-5 text-sm font-semibold text-indigo-600">← All restaurants</button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          {restaurant.logo_url
            ? <img src={restaurant.logo_url} alt="" className="h-14 w-14 rounded-xl border border-slate-200 object-cover" />
            : <span className="grid h-14 w-14 place-items-center rounded-xl bg-slate-900 text-lg font-bold text-white">{restaurant.name.slice(0, 2).toUpperCase()}</span>}
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{restaurant.name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-slate-500">
              <StatusBadge status={restaurant.subscription?.status} />
              <span>/{restaurant.subdomain}</span>
              {restaurant.is_active === false && <span className="font-semibold text-red-600">Switched off</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate('/restaurants')} className="hidden" aria-hidden="true" />
          <a href={`/admin/${restaurant.subdomain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            <Settings2 size={16} />Restaurant admin
          </a>
          <a href={`/${restaurant.subdomain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
            <ExternalLink size={16} />Public page
          </a>
          <button disabled={busy} onClick={toggleActive} className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-semibold text-white transition disabled:opacity-60 ${restaurant.is_active === false ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}`}>
            {restaurant.is_active === false ? <><Play size={16} />Reactivate</> : <><Pause size={16} />Suspend</>}
          </button>
        </div>
      </div>

      {feedback && <div className="mt-5"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}

      <div className="mt-6 flex gap-2 overflow-x-auto">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-semibold transition ${tab === value ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:border-indigo-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'overview' && (
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="p-6 lg:col-span-2">
              <h2 className="font-semibold text-slate-900">Restaurant overview</h2>
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <DetailRow label="Owner email">{restaurant.owner_email || 'Not supplied'}</DetailRow>
                <DetailRow label="Contact email">{restaurant.contact_email || 'Not supplied'}</DetailRow>
                <DetailRow label="Phone">{restaurant.phone || 'Not supplied'}</DetailRow>
                <DetailRow label="Country">{restaurant.country || 'Not supplied'}</DetailRow>
                <DetailRow label="Currency">{restaurant.currency || 'PKR'}</DetailRow>
                <DetailRow label="Joined">{shortDate(restaurant.created_at)}</DetailRow>
                <DetailRow label="Address">{restaurant.address || 'Not supplied'}</DetailRow>
                <DetailRow label="Internal notes">{restaurant.notes || 'None'}</DetailRow>
              </dl>
            </Card>
            <Card className="p-6">
              <h2 className="font-semibold text-slate-900">Usage</h2>
              <dl className="mt-5 grid gap-5">
                <DetailRow label="QR codes">{plainNumber(restaurant.qr_count)}</DetailRow>
                <DetailRow label="Menu items">{plainNumber(restaurant.menu_item_count)}</DetailRow>
                <DetailRow label="Categories">{plainNumber(restaurant.category_count)}</DetailRow>
                <DetailRow label="Collected">{money(restaurant.paid_total, restaurant.currency)}</DetailRow>
              </dl>
            </Card>
          </div>
        )}

        {tab === 'subscription' && (
          <Card className="p-6">
            <h2 className="font-semibold text-slate-900">Subscription</h2>
            {restaurant.subscription ? (
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <DetailRow label="Status"><StatusBadge status={restaurant.subscription.status} /></DetailRow>
                <DetailRow label="Plan">{restaurant.subscription.plan_name || 'Custom plan'}</DetailRow>
                <DetailRow label="Recurring amount">{money(restaurant.subscription.amount, restaurant.subscription.currency)}</DetailRow>
                <DetailRow label="Last payment">{restaurant.subscription.last_payment_status || '—'}</DetailRow>
                <DetailRow label="Trial ends">{restaurant.subscription.trial_end ? dateTime(restaurant.subscription.trial_end) : '—'}</DetailRow>
                <DetailRow label="Period ends">{restaurant.subscription.current_period_end ? dateTime(restaurant.subscription.current_period_end) : '—'}</DetailRow>
                <DetailRow label="Cancels at period end">{restaurant.subscription.cancel_at_period_end ? 'Yes' : 'No'}</DetailRow>
              </dl>
            ) : <p className="mt-4 text-sm text-slate-500">This restaurant has no subscription row yet.</p>}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button onClick={() => navigate(`/subscriptions/${restaurant.subscription?.id}`)} className="text-sm font-semibold text-indigo-600">Manage subscription →</button>
              <StripeSubscriptionLink restaurantId={restaurant.id} onLinked={reload} />
            </div>
          </Card>
        )}

        {tab === 'menu' && (
          <Card className="overflow-hidden p-0">
            {menu.loading
              ? <Spinner label="Loading menu" />
              : menu.rows.length
                ? (
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr><th className="p-4 font-semibold">Item</th><th className="p-4 font-semibold">Price</th><th className="p-4 font-semibold">Available</th></tr>
                    </thead>
                    <tbody>
                      {menu.rows.map((item) => (
                        <tr key={item.id} className="border-t border-slate-100">
                          <td className="p-4 font-medium text-slate-800">{item.name}</td>
                          <td className="p-4 text-slate-600">{money(item.price, restaurant.currency)}</td>
                          <td className="p-4">{item.is_available ? <span className="text-emerald-600">Yes</span> : <span className="text-red-600">Sold out</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
                : <EmptyState icon={UtensilsCrossed} title="No menu items yet" description="This restaurant has not added anything to its menu." />}
          </Card>
        )}

        {tab === 'qr' && (
          <Card className="overflow-hidden p-0">
            {tokens.loading
              ? <Spinner label="Loading QR codes" />
              : tokens.rows.length
                ? (
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr><th className="p-4 font-semibold">Table</th><th className="p-4 font-semibold">Active</th><th className="p-4 font-semibold">Created</th></tr>
                    </thead>
                    <tbody>
                      {tokens.rows.map((token) => (
                        <tr key={token.id} className="border-t border-slate-100">
                          <td className="p-4 font-medium text-slate-800">{token.table_number || 'Unassigned'}</td>
                          <td className="p-4">{token.is_active ? <span className="text-emerald-600">Active</span> : <span className="text-slate-500">Inactive</span>}</td>
                          <td className="p-4 text-slate-500">{shortDate(token.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
                : <EmptyState icon={QrCode} title="No QR codes yet" description="This restaurant has not generated any table codes." />}
          </Card>
        )}

        {tab === 'activity' && (
          <Card className="overflow-hidden p-0">
            {logs.loading
              ? <Spinner label="Loading activity" />
              : logs.rows.length
                ? (
                  <ul className="divide-y divide-slate-100">
                    {logs.rows.map((entry) => (
                      <li key={entry.id} className="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
                        <strong className="font-semibold capitalize text-slate-800">{String(entry.action).replace(/_/g, ' ')}</strong>
                        <span className="ml-auto text-xs text-slate-400">{dateTime(entry.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )
                : <EmptyState icon={Eye} title="No activity recorded" description="Actions taken on this restaurant will appear here." />}
          </Card>
        )}
      </div>
    </>
  )
}
