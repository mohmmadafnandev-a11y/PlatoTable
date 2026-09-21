import { useCallback, useEffect, useState } from 'react'
import { Download, FileClock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { dateTime, downloadCsv, relativeTime } from '../lib/format'
import { Card, EmptyState, Notice, SectionHead, Spinner, inputClass } from './ui'

const PAGE_SIZE = 25

export default function ActivityLogs() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [action, setAction] = useState('')
  const [actor, setActor] = useState('all')
  const [restaurant, setRestaurant] = useState('all')
  const [from, setFrom] = useState('')
  const [expanded, setExpanded] = useState(null)
  const [limit, setLimit] = useState(PAGE_SIZE)

  // Actor and restaurant lists come from the log rows themselves, so the
  // filters can only ever offer values that actually appear in the trail.
  const [actors, setActors] = useState([])
  const [restaurants, setRestaurants] = useState([])

  const fetchLogs = useCallback(() => {
    if (!supabase) return Promise.resolve()
    let query = supabase
      .from('activity_logs')
      .select('id, action, details, created_at, ip_address, super_admin_id, restaurant_id, super_admins(name), restaurants(name)')
      .order('created_at', { ascending: false })
      .limit(limit * 4)

    if (action.trim()) query = query.ilike('action', `%${action.trim()}%`)
    if (actor !== 'all') query = query.eq('super_admin_id', actor)
    if (restaurant !== 'all') query = query.eq('restaurant_id', restaurant)
    if (from) query = query.gte('created_at', new Date(from).toISOString())

    return query.then(({ data, error: requestError }) => {
      if (requestError) setError(requestError.message)
      else { setRows(data || []); setError('') }
      setLoading(false)
    })
  }, [action, actor, restaurant, from, limit])

  useEffect(() => { fetchLogs() }, [fetchLogs])

  // A separate unfiltered pass populates the filter menus once.
  useEffect(() => {
    if (!supabase) return
    supabase
      .from('activity_logs')
      .select('super_admin_id, restaurant_id, super_admins(name), restaurants(name)')
      .order('created_at', { ascending: false })
      .limit(300)
      .then(({ data }) => {
        if (!data) return
        const unique = (pairs) => [...new Map(pairs.filter(([id, label]) => id && label)).entries()]
        setActors(unique(data.map((row) => [row.super_admin_id, row.super_admins?.name])).map(([id, label]) => ({ id, label })))
        setRestaurants(unique(data.map((row) => [row.restaurant_id, row.restaurants?.name])).map(([id, label]) => ({ id, label })))
      })
  }, [])

  const visible = rows.slice(0, limit)

  const exportCsv = () => downloadCsv(`activity-${new Date().toISOString().slice(0, 10)}.csv`, rows, [
    { label: 'Time', value: (row) => dateTime(row.created_at) },
    { label: 'Action', value: (row) => row.action },
    { label: 'Admin', value: (row) => row.super_admins?.name || 'System' },
    { label: 'Restaurant', value: (row) => row.restaurants?.name || 'Platform' },
    { label: 'IP address', value: (row) => row.ip_address },
    { label: 'Details', value: (row) => JSON.stringify(row.details || {}) },
  ])

  return (
    <>
      <SectionHead
        eyebrow="AUDIT TRAIL"
        title="Activity logs"
        description="Every platform action, who took it, and when."
        action={
          <button onClick={exportCsv} disabled={!rows.length} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
            <Download size={16} />Export CSV
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="Filter by action, e.g. suspended" className={`${inputClass} min-w-56 flex-1`} />
        <select value={actor} onChange={(event) => setActor(event.target.value)} className={inputClass}>
          <option value="all">All admins</option>
          {actors.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select value={restaurant} onChange={(event) => setRestaurant(event.target.value)} className={inputClass}>
          <option value="all">All restaurants</option>
          {restaurants.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={inputClass} aria-label="Only show entries on or after this date" />
        {(action || actor !== 'all' || restaurant !== 'all' || from) && (
          <button onClick={() => { setAction(''); setActor('all'); setRestaurant('all'); setFrom('') }} className="h-11 rounded-lg px-3 text-sm font-semibold text-indigo-600">Clear filters</button>
        )}
      </div>

      {error && <div className="mb-4"><Notice tone="danger" action={<button onClick={fetchLogs} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <Card className="overflow-hidden p-0">
        {loading && !rows.length
          ? <Spinner label="Loading activity" />
          : visible.length
            ? (
              <>
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-4 font-semibold">When</th>
                      <th className="p-4 font-semibold">Admin</th>
                      <th className="p-4 font-semibold">Action</th>
                      <th className="p-4 font-semibold">Restaurant</th>
                      <th className="p-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100 align-top transition hover:bg-indigo-50/40">
                        <td className="p-4 text-slate-500">
                          {relativeTime(row.created_at)}
                          <small className="mt-1 block text-xs text-slate-400">{dateTime(row.created_at)}</small>
                        </td>
                        <td className="p-4 text-slate-700">{row.super_admins?.name || 'System'}</td>
                        <td className="p-4 font-medium capitalize text-slate-800">{String(row.action).replace(/_/g, ' ')}</td>
                        <td className="p-4 text-slate-600">{row.restaurants?.name || 'Platform'}</td>
                        <td className="p-4 text-right">
                          <button onClick={() => setExpanded(expanded === row.id ? null : row.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">
                            {expanded === row.id ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {expanded && (
                  <div className="border-t border-slate-200 bg-slate-50 p-5">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recorded details</p>
                    <pre className="mt-3 overflow-x-auto rounded-lg bg-white p-4 text-xs text-slate-700">
                      {JSON.stringify(rows.find((row) => row.id === expanded)?.details || {}, null, 2)}
                    </pre>
                  </div>
                )}
                {rows.length > limit && (
                  <div className="border-t border-slate-100 p-4 text-center">
                    <button onClick={() => setLimit(limit + PAGE_SIZE)} className="text-sm font-semibold text-indigo-600">Load more</button>
                  </div>
                )}
              </>
            )
            : <EmptyState icon={FileClock} title="No activity found" description="Platform actions will appear here as they happen." />}
      </Card>
    </>
  )
}
