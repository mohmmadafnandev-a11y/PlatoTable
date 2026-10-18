import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  Download,
  ExternalLink,
  Eye,
  Pause,
  Play,
  Settings2,
  Trash2,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { deleteRestaurant } from '../lib/api'
import { logActivity, useRestaurants } from '../lib/data'
import RestaurantMenuManager from './RestaurantMenuManager'
import RestaurantOwnerCard from './RestaurantOwnerCard'
import RestaurantQrManager from './RestaurantQrManager'
import SubscriptionProgress from './SubscriptionProgress'
import { STATUSES, dateTime, downloadCsv, money, plainNumber, shortDate } from '../lib/format'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatusBadge } from './ui'
import BackupDaysEditor from './BackupDaysEditor'

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
            : <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-slate-100 text-xs font-bold text-slate-600">{(restaurant.name || 'R').slice(0, 2).toUpperCase()}</span>}
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
          {restaurant.subscription ? money(restaurant.subscription.amount) : 'Not configured'}
        </small>
      </td>
      <td className="p-4 text-slate-600">{plainNumber(restaurant.qr_count)}</td>
      <td className="p-4 text-slate-600">{plainNumber(restaurant.menu_item_count)}</td>
      <td className="p-4 text-slate-600">{money(restaurant.paid_total)}</td>
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

// Removing a restaurant.
//
// Two different intentions get one word in most panels — "delete" — and they
// are not the same thing. Either the tenant should never have existed, in which
// case the payment history is theirs too and goes with them; or the tenant is
// finished while the money it paid is a fact about the platform, and scrapping
// the revenue reports to remove a menu would be plainly wrong. The dialog asks
// which, in those terms, and refuses to proceed until the operator has named the
// restaurant by typing its subdomain.
const DELETE_MODES = [
  {
    value: 'erase',
    title: 'Delete everything',
    detail: 'The restaurant and every row that belongs to it: menu, QR codes, uploaded images, its payment history, and the owner’s sign-in account. Nothing is kept.',
  },
  {
    value: 'detach',
    title: 'Delete the restaurant, keep its payment history',
    detail: 'The restaurant and its own data are removed. The payments it made stay in the ledger, so revenue and the transactions list stay complete. The owner’s account is left alone.',
  },
]

function DeleteRestaurant({ restaurant, onClose, onDeleted }) {
  const [mode, setMode] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const confirmed = typed.trim().toLowerCase() === restaurant.subdomain

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const payload = await deleteRestaurant(restaurant.id, mode, typed)
      setResult(payload)
    } catch (failure) {
      setError(failure.message)
    }
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-900/50 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="delete-restaurant-title" className="w-full max-w-xl rounded-xl bg-white p-6 shadow-2xl">
        {result ? (
          <>
            <h2 id="delete-restaurant-title" className="text-xl font-semibold text-slate-900">Deleted {restaurant.name}</h2>
            <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Menu items removed</dt><dd className="mt-1 text-slate-700">{plainNumber(result.removed?.menu_items)}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">QR codes removed</dt><dd className="mt-1 text-slate-700">{plainNumber(result.removed?.qr_codes)}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Images removed</dt><dd className="mt-1 text-slate-700">{plainNumber(result.removed?.menu_images)}</dd></div>
              <div><dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Payments kept</dt><dd className="mt-1 text-slate-700">{plainNumber(result.kept?.payments)}</dd></div>
            </dl>
            {result.warnings?.length > 0 && (
              <div className="mt-5"><Notice tone="warning">{result.warnings.join(' ')}</Notice></div>
            )}
            <button onClick={() => onDeleted(restaurant)} className="mt-6 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white">Back to restaurants</button>
          </>
        ) : (
          <>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-lg bg-red-50 text-red-600"><AlertTriangle size={20} /></span>
              <div>
                <h2 id="delete-restaurant-title" className="text-xl font-semibold text-slate-900">Delete {restaurant.name}?</h2>
                <p className="mt-1 text-sm text-slate-500">The Safepay subscription is cancelled first, so a deleted restaurant is never left being billed.</p>
              </div>
            </div>

            <fieldset className="mt-5 grid gap-3">
              <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">What should be removed</legend>
              {DELETE_MODES.map((option) => (
                <label key={option.value} className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${mode === option.value ? 'border-red-300 bg-red-50/60' : 'border-slate-200 hover:border-slate-300'}`}>
                  <input type="radio" name="delete-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} className="mt-1 h-4 w-4 accent-red-600" />
                  <span>
                    <strong className="block text-sm font-semibold text-slate-900">{option.title}</strong>
                    <small className="mt-1 block text-sm text-slate-500">{option.detail}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="mt-5 grid gap-2 text-sm font-medium text-slate-700">
              Type <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{restaurant.subdomain}</code> to confirm
              <input autoFocus value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={restaurant.subdomain} className="h-11 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-red-400 focus:ring-4 focus:ring-red-100" />
            </label>

            {error && <div className="mt-4"><Notice tone="danger">{error}</Notice></div>}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                disabled={!mode || !confirmed || busy}
                onClick={submit}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 size={16} />{busy ? 'Deleting…' : 'Delete restaurant'}
              </button>
              <button onClick={onClose} disabled={busy} className="rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// The restaurant's own details, editable from the platform side.
//
// Name, phone, contact address and notes were read-only here, which meant a
// restaurant that had moved premises, changed its phone number, or was recorded
// under a typo could only be corrected by the restaurant itself — or by hand in
// the database. These fields are the record the panel reasons about, so they are
// edited where they are read.
//
// Deliberately not here: the subdomain. It is baked into the stored admin/user
// URLs, the printed QR codes and the login path, so renaming it is a migration
// rather than a form field.
function RestaurantProfileCard({ restaurant, profile, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: restaurant.name || '',
    phone: restaurant.phone || '',
    contact_email: restaurant.contact_email || '',
    address: restaurant.address || '',
    notes: restaurant.notes || '',
  }))
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const update = (patch) => setForm((current) => ({ ...current, ...patch }))

  const dirty = form.name !== (restaurant.name || '')
    || form.phone !== (restaurant.phone || '')
    || form.contact_email !== (restaurant.contact_email || '')
    || form.address !== (restaurant.address || '')
    || form.notes !== (restaurant.notes || '')

  const save = async (event) => {
    event.preventDefault()
    if (!form.name.trim()) return setFeedback({ tone: 'danger', text: 'A restaurant needs a name.' })
    if (form.contact_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email.trim())) {
      return setFeedback({ tone: 'danger', text: 'That contact email does not look like an address.' })
    }

    setSaving(true)
    setFeedback(null)
    const { error } = await supabase
      .from('restaurants')
      .update({
        name: form.name.trim(),
        phone: form.phone.trim() || null,
        contact_email: form.contact_email.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', restaurant.id)
    setSaving(false)
    if (error) return setFeedback({ tone: 'danger', text: error.message })

    await logActivity({
      superAdminId: profile?.id,
      restaurantId: restaurant.id,
      action: 'restaurant_updated',
      details: { name: form.name.trim() },
    })
    setFeedback({ tone: 'success', text: 'Restaurant details saved.' })
    onSaved?.()
  }

  const field = 'h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-indigo-500'

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Restaurant details</h2>
          <p className="mt-1 text-sm text-slate-500">What the panel knows about this restaurant. The subdomain is fixed — QR codes and sign-in links are built from it.</p>
        </div>
        <code className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs text-slate-600">/{restaurant.subdomain}</code>
      </div>

      {feedback && <div className="mt-5"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}

      <form onSubmit={save} className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Restaurant name
          <input required value={form.name} onChange={(event) => update({ name: event.target.value })} className={field} />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Phone
          <input value={form.phone} onChange={(event) => update({ phone: event.target.value })} placeholder="Not supplied" className={field} />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Customer contact email
          <input type="email" value={form.contact_email} onChange={(event) => update({ contact_email: event.target.value })} placeholder="Show guests who need help" className={field} />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Address
          <input value={form.address} onChange={(event) => update({ address: event.target.value })} placeholder="Not supplied" className={field} />
        </label>
        <label className="grid gap-2 text-sm font-medium text-slate-700 sm:col-span-2">
          Internal notes
          <textarea rows="2" value={form.notes} onChange={(event) => update({ notes: event.target.value })} placeholder="Anything the next operator should know" className={`${field} h-auto py-2`} />
        </label>
        <p className="text-xs text-slate-400 sm:col-span-2">The owner signs in with <strong className="font-semibold text-slate-600">{restaurant.owner_email || 'no address on file'}</strong> — that lives on the Owner sign-in tab.</p>
        <div className="flex gap-3 sm:col-span-2">
          <button disabled={saving || !dirty} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save details'}
          </button>
          {dirty && <button type="button" onClick={() => setForm({ name: restaurant.name || '', phone: restaurant.phone || '', contact_email: restaurant.contact_email || '', address: restaurant.address || '', notes: restaurant.notes || '' })} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">Reset</button>}
        </div>
      </form>
    </Card>
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
  const [deleting, setDeleting] = useState(false)
  const [feedback, setFeedback] = useState(null)

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

  // The detail page is about a restaurant that no longer exists by the time the
  // dialog closes, so the list is where the operator has to end up. The list
  // loads its own data on mount, which reads the delete back out of the database
  // rather than trusting the in-memory copy.
  const leaveAfterDelete = () => { setDeleting(false); navigate('/restaurants') }

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
    ['qr', `Tables & QR (${plainNumber(restaurant.qr_count)})`],
    ['owner', 'Owner sign-in'],
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
          {/* Deletion is deliberately behind suspension. Deleting something that
              is still serving menus to customers is a mistake made in one
              click; requiring the suspend first means the operator has already
              seen the restaurant go dark before it goes for good. */}
          <button
            disabled={restaurant.is_active !== false}
            onClick={() => setDeleting(true)}
            title={restaurant.is_active !== false ? 'Suspend the restaurant before deleting it' : `Delete ${restaurant.name}`}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            <Trash2 size={16} />Delete
          </button>
        </div>
      </div>

      {deleting && (
        <DeleteRestaurant restaurant={restaurant} onClose={() => setDeleting(false)} onDeleted={leaveAfterDelete} />
      )}

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
          <div className="grid gap-5">
          <RestaurantProfileCard restaurant={restaurant} profile={profile} onSaved={reload} />
          <BackupDaysEditor
            restaurantId={restaurant.id}
            restaurantName={restaurant.name}
            profile={profile}
            onSaved={reload}
          />
          <div className="grid gap-5 lg:grid-cols-3">
            {/* Only what the details form above does not already show: the
                owner address lives on the Owner sign-in tab, and everything
                else is editable in the card above. */}
            <Card className="p-6 lg:col-span-2">
              <h2 className="font-semibold text-slate-900">Record</h2>
              <dl className="mt-5 grid gap-5 sm:grid-cols-3">
                <DetailRow label="Owner email">{restaurant.owner_email || 'Not supplied'}</DetailRow>
                <DetailRow label="Country">{restaurant.country || 'Not supplied'}</DetailRow>
                <DetailRow label="Joined">{shortDate(restaurant.created_at)}</DetailRow>
                <DetailRow label="Billing currency">{restaurant.currency || 'USD'}</DetailRow>
                <DetailRow label="Onboarding">{restaurant.onboarding_completed ? 'Complete' : 'Incomplete'}</DetailRow>
              </dl>
            </Card>
            <Card className="p-6">
              <h2 className="font-semibold text-slate-900">Usage</h2>
              <dl className="mt-5 grid gap-5">
                <DetailRow label="QR codes">{plainNumber(restaurant.qr_count)}</DetailRow>
                <DetailRow label="Menu items">{plainNumber(restaurant.menu_item_count)}</DetailRow>
                <DetailRow label="Categories">{plainNumber(restaurant.category_count)}</DetailRow>
                <DetailRow label="Collected">{money(restaurant.paid_total)}</DetailRow>
              </dl>
            </Card>
          </div>
          </div>
        )}

        {tab === 'subscription' && (
          <>
            {/* Which part of the billing cycle this restaurant is in, and what
                it is charged next — the question this tab is opened to answer. */}
            {restaurant.subscription && <SubscriptionProgress subscription={restaurant.subscription} className="mb-5" />}
          <Card className="p-6">
            <h2 className="font-semibold text-slate-900">Subscription</h2>
            {restaurant.subscription ? (
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <DetailRow label="Status"><StatusBadge status={restaurant.subscription.status} /></DetailRow>
                <DetailRow label="Plan">{restaurant.subscription.plan_name || 'Custom plan'}</DetailRow>
                <DetailRow label="Recurring amount">{money(restaurant.subscription.amount)}</DetailRow>
                <DetailRow label="Last payment">{restaurant.subscription.last_payment_status || '—'}</DetailRow>
                <DetailRow label="Trial ends">{restaurant.subscription.trial_end ? dateTime(restaurant.subscription.trial_end) : '—'}</DetailRow>
                <DetailRow label="Period ends">{restaurant.subscription.current_period_end ? dateTime(restaurant.subscription.current_period_end) : '—'}</DetailRow>
                <DetailRow label="Cancels at period end">{restaurant.subscription.cancel_at_period_end ? 'Yes' : 'No'}</DetailRow>
              </dl>
            ) : <p className="mt-4 text-sm text-slate-500">This restaurant has no subscription row yet.</p>}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button onClick={() => navigate(`/subscriptions/${restaurant.subscription?.id}`)} className="text-sm font-semibold text-indigo-600">Manage subscription →</button>
            </div>
          </Card>
          </>
        )}

        {tab === 'menu' && <RestaurantMenuManager restaurant={restaurant} profile={profile} />}

        {tab === 'qr' && <RestaurantQrManager restaurant={restaurant} profile={profile} />}

        {/* The owner's way in, editable from the platform side — the support
            call that used to end in "ask them to use forgot password". */}
        {tab === 'owner' && (
          <RestaurantOwnerCard restaurant={restaurant} onChanged={reload} />
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
