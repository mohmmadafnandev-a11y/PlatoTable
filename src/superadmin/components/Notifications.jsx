import { useCallback, useEffect, useState } from 'react'
import { Bell, ExternalLink } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { dateTime, plainNumber, shortDate } from '../lib/format'
import { notificationTarget } from '../../lib/notification-links'
import { Card, EmptyState, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

// Delivery history for everything the platform has told restaurants, plus the
// alerts it raised about them.
//
// The distinction between those two is the reason `audience` exists. A billing
// alert ("khanR's payment failed") refers to the same restaurant a message *to*
// that restaurant does, so without the split this list read as if the platform
// had sent its own internal notes to the customer.

const AUDIENCES = [
  { value: 'all', label: 'Everything' },
  { value: 'platform', label: 'Platform alerts' },
  { value: 'restaurant', label: 'Sent to restaurants' },
]

const TYPES = ['all', 'info', 'success', 'warning', 'critical']

const audienceLabel = (row) => {
  if (row.audience === 'platform') return 'Platform alert'
  return row.restaurant_id ? 'One restaurant' : 'Broadcast'
}

export default function Notifications({ navigate }) {
  const [rows, setRows] = useState([])
  const [recipients, setRecipients] = useState([])
  const [restaurantCount, setRestaurantCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [audience, setAudience] = useState('all')
  const [type, setType] = useState('all')

  // One read per load rather than a count per row: the recipient table is small
  // and the arithmetic below is trivial, while N round trips for a table of 50
  // notifications would not be.
  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return Promise.all([
      supabase.from('system_notifications').select('*, restaurants(name, subdomain)').order('created_at', { ascending: false }).limit(200),
      supabase.from('notification_recipients').select('notification_id, is_read'),
      supabase.from('restaurants').select('id', { count: 'exact', head: true }),
    ]).then(([notificationResult, recipientResult, countResult]) => {
      if (notificationResult.error) setError(notificationResult.error.message)
      else { setRows(notificationResult.data || []); setError('') }
      setRecipients(recipientResult.data || [])
      setRestaurantCount(countResult.count || 0)
      setLoading(false)
    })
  }, [])

  useEffect(() => { load() }, [load])

  const visible = rows
    .filter((row) => audience === 'all' || row.audience === audience)
    .filter((row) => type === 'all' || row.type === type)

  // How many recipients have opened it. A broadcast is delivered to every
  // restaurant, so its denominator is the restaurant count; a targeted message
  // has exactly one recipient. Nothing counts a platform alert — the operator
  // reading this list *is* its audience.
  const readRate = (row) => {
    if (row.audience === 'platform') return null
    const delivered = row.restaurant_id ? 1 : restaurantCount
    if (!delivered) return null
    const read = recipients.filter((item) => item.notification_id === row.id && item.is_read).length
    return { read, delivered, percent: Math.round((read / delivered) * 100) }
  }

  const platformAlerts = rows.filter((row) => row.audience === 'platform').length

  return (
    <>
      <SectionHead
        eyebrow="RESTAURANT COMMUNICATION"
        title="Notifications"
        description="Every message sent to restaurants and every billing alert raised about them."
        action={
          <button onClick={() => navigate('/notifications/send')} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">
            + Send notification
          </button>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Messages recorded</p>
          <strong className="mt-1 block text-2xl text-slate-900">{plainNumber(rows.length)}</strong>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Platform alerts</p>
          <strong className="mt-1 block text-2xl text-slate-900">{plainNumber(platformAlerts)}</strong>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-medium text-slate-500">Unread by restaurants</p>
          <strong className="mt-1 block text-2xl text-slate-900">
            {plainNumber(rows.filter((row) => row.audience === 'restaurant' && !recipients.some((item) => item.notification_id === row.id && item.is_read)).length)}
          </strong>
        </Card>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select value={audience} onChange={(event) => setAudience(event.target.value)} className={inputClass}>
          {AUDIENCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <div className="flex gap-2 overflow-x-auto">
          {TYPES.map((item) => (
            <button key={item} onClick={() => setType(item)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold capitalize ${type === item ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>{item}</button>
          ))}
        </div>
      </div>

      {error && <div className="mb-4"><Notice tone="danger" action={<button onClick={load} className="font-semibold underline">Retry</button>}>{error}</Notice></div>}

      <Card className="overflow-hidden p-0">
        {loading && !rows.length
          ? <Spinner label="Loading notifications" />
          : visible.length
            ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-4 font-semibold">Date</th>
                      <th className="p-4 font-semibold">Notification</th>
                      <th className="p-4 font-semibold">Type</th>
                      <th className="p-4 font-semibold">Audience</th>
                      <th className="p-4 font-semibold">Read</th>
                      <th className="p-4 font-semibold">Call to action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => {
                      const rate = readRate(row)
                      return (
                        <tr key={row.id} className="border-t border-slate-100 align-top transition hover:bg-indigo-50/40">
                          <td className="p-4 text-slate-500">{shortDate(row.created_at)}</td>
                          <td className="p-4">
                            <strong className="block text-slate-800">{row.title}</strong>
                            <span className="mt-1 block max-w-md text-xs leading-5 text-slate-500">{row.message}</span>
                          </td>
                          <td className="p-4">
                            <StatusBadge status={row.type === 'success' ? 'active' : row.type === 'critical' ? 'suspended' : row.type} />
                          </td>
                          <td className="p-4">
                            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${row.audience === 'platform' ? 'bg-slate-100 text-slate-700' : 'bg-indigo-50 text-indigo-700'}`}>
                              {audienceLabel(row)}
                            </span>
                            <small className="mt-1 block text-xs text-slate-400">
                              {row.audience === 'platform'
                                ? 'Visible to platform staff only'
                                : row.restaurants?.name || 'All restaurants'}
                            </small>
                          </td>
                          <td className="p-4 text-slate-600">
                            {rate
                              ? <span className={rate.percent >= 50 ? 'text-emerald-700' : rate.percent > 0 ? 'text-amber-700' : 'text-slate-500'}>
                                  {rate.read} of {rate.delivered} · {rate.percent}%
                                </span>
                              : <span className="text-slate-400">—</span>}
                          </td>
                          <td className="p-4 text-slate-600">
                            {row.action_url
                              ? <a href={notificationTarget(row.action_url, row.restaurants?.subdomain)} className="inline-flex items-center gap-1 font-semibold text-indigo-600">{row.action_label || 'Open'}<ExternalLink size={13} /></a>
                              : <span className="text-slate-400">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
            : <EmptyState icon={Bell} title={rows.length ? 'Nothing matches these filters' : 'No notifications yet'} description={rows.length ? 'Choose a different audience or type.' : 'Billing alerts appear here automatically as trials end and payments fail.'} />}
      </Card>
      <p className="mt-4 text-xs text-slate-500">
        {(() => {
          const newest = rows.find((row) => row.audience === 'platform')
          return newest
            ? `Trial warnings, grace notices, and payment results are written by the billing sweep rather than by hand. The newest of them was raised ${dateTime(newest.created_at)}.`
            : 'Trial warnings, grace notices, and payment results appear here automatically as the billing sweep runs.'
        })()}
      </p>
    </>
  )
}
