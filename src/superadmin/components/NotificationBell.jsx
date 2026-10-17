import { useEffect, useRef, useState, useCallback } from 'react'
import { Bell, CheckCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { relativeTime } from '../lib/format'
import { armNotificationSound, isNotificationSoundEnabled, playNotificationSound, setNotificationSoundEnabled } from '../../lib/notification-sound'

// The header bell used to be decoration: a button with a hardcoded red dot and
// no handler, so it always looked like something needed attention and never
// said what. This replaces it with the alerts the billing sweep and the Safepay
// webhook actually raise — a failed payment, a trial about to end, a
// suspension — each of which lands here the moment it is written.
//
// Only `audience = 'platform'` rows are read. Restaurant-facing messages are
// for the restaurant, and showing the operator its own outbound mail as if it
// were an alert is exactly the confusion the audience column was added to end.

const POLL_MS = 60000
const PREVIEW = 6

export default function NotificationBell({ navigate }) {
  const [rows, setRows] = useState([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [soundOn, setSoundOn] = useState(isNotificationSoundEnabled)
  const container = useRef(null)
  const chimedUnread = useRef(0)

  // Reads are silent: a bell that flashes a spinner every minute is worse than
  // no bell. The count is simply whatever the last read returned.
  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase
      .from('system_notifications')
      .select('id, type, title, message, background_color, action_url, action_label, is_read, created_at, restaurants(name)')
      .eq('audience', 'platform')
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data, error: readError }) => {
        // A failed read used to be dropped on the floor, and the panel then said
        // "nothing needs attention" — which is precisely what a broken bell looks
        // like, so the failure has to be visible instead.
        if (readError) setError(readError.message)
        else { setRows(data || []); setError('') }
      })
  }, [])

  useEffect(() => {
    // Armed once, before anything is known to be waiting: the operator's first
    // click anywhere in the panel is the gesture that lets a chime through, so an
    // alert that was already sitting here when the page opened is audible.
    armNotificationSound()
  }, [])

  useEffect(() => {
    load()
    const timer = window.setInterval(load, POLL_MS)
    // Coming back to the tab is the moment an operator wants to know what
    // happened while they were away, so it is worth a read even mid-interval.
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [load])

  // Live delivery: the sweep suspends a restaurant or Safepay reports a failed
  // charge, and the badge appears while the operator is looking at the panel.
  // The socket is only a signal — the query above is re-run rather than its
  // payload being trusted, so the audience rule lives in exactly one place.
  useEffect(() => {
    if (!supabase) return undefined
    const channel = supabase
      .channel('platform-alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_notifications', filter: 'audience=eq.platform' }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => { if (!container.current?.contains(event.target)) setOpen(false) }
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const unread = rows.filter((row) => !row.is_read)

  // One chime per new alert, not one per read: the counter starts at zero, so a
  // backlog that was already waiting when the panel opened speaks once, and the
  // minute poll then only makes a sound when the number actually grew.
  useEffect(() => {
    if (!unread.length) { chimedUnread.current = 0; return }
    if (unread.length > chimedUnread.current) playNotificationSound()
    chimedUnread.current = unread.length
  }, [unread.length])

  const toggleSound = () => setSoundOn(setNotificationSoundEnabled(!soundOn))

  const markAllRead = async () => {
    // Optimistic: the badge is the point, and a failed write is corrected by the
    // next poll rather than leaving the list stuck behind a spinner.
    setRows((current) => current.map((row) => ({ ...row, is_read: true })))
    await supabase.from('system_notifications').update({ is_read: true }).eq('audience', 'platform').eq('is_read', false)
    load()
  }

  const openRow = async (row) => {
    setOpen(false)
    setRows((current) => current.map((item) => (item.id === row.id ? { ...item, is_read: true } : item)))
    // Within the platform's own alerts one shared flag is the right model: there
    // is exactly one audience, so this cannot mark it read for anybody else.
    if (!row.is_read) await supabase.from('system_notifications').update({ is_read: true }).eq('id', row.id)
    if (row.action_url) navigate(row.action_url.replace(/^\/admin/, ''))
    else load()
  }

  const tone = (row) => row.type === 'critical' ? 'critical' : row.type === 'warning' ? 'warning' : row.type === 'success' ? 'success' : 'info'

  return (
    <div className="sa-bell" ref={container}>
      <button
        onClick={() => { setOpen(!open); if (!open) load() }}
        className="sa-bell-button"
        aria-label={unread.length ? `Notifications, ${unread.length} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell size={19} />
        {unread.length > 0 && <span className="sa-bell-badge">{unread.length > 99 ? '99+' : unread.length}</span>}
      </button>

      {open && (
        <section className="sa-bell-panel">
          <header>
            <div>
              <strong>Alerts</strong>
              <small>{unread.length ? `${unread.length} need attention` : 'Nothing needs attention'}</small>
            </div>
            <div className="sa-bell-controls">
              <button
                onClick={toggleSound}
                className={`sa-bell-sound${soundOn ? '' : ' is-muted'}`}
                aria-pressed={soundOn}
                title={soundOn ? 'Mute the alert chime' : 'Unmute the alert chime'}
              >
                {soundOn ? 'Sound on' : 'Sound off'}
              </button>
              {unread.length > 0 && (
                <button onClick={markAllRead} className="sa-bell-mark"><CheckCheck size={15} />Mark all read</button>
              )}
            </div>
          </header>

          {/* A read that failed has to say so: an empty list and a broken query
              look identical from here, and only one of them needs fixing. */}
          {error
            ? <p className="sa-bell-empty">Could not read alerts: {error} <button onClick={load} className="sa-bell-retry">Retry</button></p>
            : rows.length === 0
              ? <p className="sa-bell-empty">No platform alerts yet. Trial endings, failed payments, and suspensions appear here automatically.</p>
              : (
                <ul>
                  {rows.slice(0, PREVIEW).map((row) => (
                    <li key={row.id}>
                      <button onClick={() => openRow(row)} className={row.is_read ? 'sa-bell-row' : 'sa-bell-row unread'}>
                        <span className={`sa-bell-dot ${tone(row)}`} />
                        <span className="sa-bell-body">
                          <b>{row.title}</b>
                          <span>{row.message}</span>
                          <small>
                            {row.restaurants?.name ? `${row.restaurants.name} · ` : ''}{relativeTime(row.created_at)}
                            {row.action_label ? ` · ${row.action_label}` : ''}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

          <footer>
            <button onClick={() => { setOpen(false); navigate('/notifications') }}>View all notifications</button>
          </footer>
        </section>
      )}
    </div>
  )
}
