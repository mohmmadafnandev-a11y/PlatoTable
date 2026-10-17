import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, Download, Plus, QrCode, RotateCcw, Trash2 } from 'lucide-react'
import { logActivity, useTenantRows } from '../lib/data'
import { scanLink } from '../../lib/restaurant-config'
import { dateTime, shortDate } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

// Table codes, from the platform side.
//
// The same actions the restaurant's own admin has — create a code for a table,
// switch one off, replace a token that has leaked onto a poster someone else
// printed, delete a table that no longer exists — because "the QR code stopped
// working" is a support call, and the person taking it should not have to talk
// somebody through a screen they cannot see.
//
// The link is built from the deployment's canonical base (see scanLink), never
// from whatever host this panel is being viewed on: a printed code must keep
// working after the panel moves to another domain.

const newToken = () => {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function QrCard({ token, onChanged, log }) {
  const [image, setImage] = useState('')
  const [busy, setBusy] = useState('')
  const [copied, setCopied] = useState(false)
  // A code can expire while the panel is open, so "expired" is re-read on a
  // slow timer rather than computed while rendering from the clock.
  const [now, setNow] = useState(() => Date.now())
  const link = scanLink(token.token)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let active = true
    QRCode.toDataURL(link, { width: 360, margin: 2 }).then((url) => { if (active) setImage(url) }).catch(() => setImage(''))
    return () => { active = false }
  }, [link])

  const expired = token.expires_at && new Date(token.expires_at).getTime() <= now

  const download = () => {
    if (!image) return
    const anchor = document.createElement('a')
    anchor.href = image
    anchor.download = `table-${(token.table_number || 'code').replace(/\s+/g, '-').toLowerCase()}-qr.png`
    anchor.click()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const setActive = async (active) => {
    setBusy('state')
    await onChanged.update(token.id, { is_active: active })
    log('qr_code_state_changed', { table: token.table_number, is_active: active })
    setBusy('')
  }

  const replaceToken = async () => {
    if (!window.confirm(`Replace the code for ${token.table_number || 'this table'}? The old link stops working immediately — reprint the code before the next service.`)) return
    setBusy('token')
    const adoption = newToken()
    await onChanged.update(token.id, { token: adoption })
    log('qr_code_token_replaced', { table: token.table_number })
    setBusy('')
  }

  const remove = async () => {
    if (!window.confirm(`Delete the QR code for ${token.table_number || 'this table'}?`)) return
    setBusy('delete')
    await onChanged.remove(token.id)
    log('qr_code_deleted', { table: token.table_number })
    setBusy('')
  }

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{token.table_number || 'Unassigned table'}</h3>
          <p className="mt-1 text-xs text-slate-500">Created {shortDate(token.created_at)}</p>
        </div>
        <StatusBadge status={!token.is_active ? 'canceled' : expired ? 'past_due' : 'active'} />
      </div>

      <div className="grid min-h-44 place-items-center rounded-xl bg-slate-50">
        {image ? <img src={image} alt={`QR code for ${token.table_number || 'table'}`} className="w-40" /> : <Spinner label="Drawing code" />}
      </div>

      {token.expires_at && (
        <p className={`text-xs ${expired ? 'font-semibold text-red-600' : 'text-slate-500'}`}>
          {expired ? 'Expired' : 'Expires'} {dateTime(token.expires_at)}
        </p>
      )}

      <div className="grid gap-2">
        <button onClick={download} disabled={!image} className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-50">
          <Download size={14} />Download PNG
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button onClick={copy} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600">
            <Copy size={13} />{copied ? 'Copied' : 'Copy link'}
          </button>
          <button onClick={() => setActive(!token.is_active)} disabled={busy === 'state'} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-50">
            {token.is_active ? 'Switch off' : 'Switch on'}
          </button>
          <button onClick={replaceToken} disabled={busy === 'token'} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 disabled:opacity-50">
            <RotateCcw size={13} />New token
          </button>
          <button onClick={remove} disabled={busy === 'delete'} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 disabled:opacity-50">
            <Trash2 size={13} />Delete
          </button>
        </div>
      </div>
    </Card>
  )
}

export default function RestaurantQrManager({ restaurant, profile }) {
  const tokens = useTenantRows(restaurant.id, 'qr_tokens', { order: 'created_at', ascending: false })
  const [table, setTable] = useState('')
  const [expiry, setExpiry] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [creating, setCreating] = useState(false)

  const log = (entry, details) => logActivity({ superAdminId: profile?.id, restaurantId: restaurant.id, action: entry, details })

  const create = async (event) => {
    event.preventDefault()
    const label = table.trim()
    if (!label) return
    setCreating(true)
    const { error } = await tokens.insert({
      table_number: label,
      token: newToken(),
      is_active: true,
      expires_at: expiry ? new Date(expiry).toISOString() : null,
    })
    setCreating(false)
    setFeedback(error ? { tone: 'danger', text: error.message } : { tone: 'success', text: `A QR code for ${label} is ready.` })
    if (!error) {
      log('qr_code_created', { table: label, expires_at: expiry || null })
      setTable('')
      setExpiry('')
    }
  }

  const active = tokens.rows.filter((row) => row.is_active).length

  return (
    <div className="grid gap-5">
      <SectionHead
        eyebrow="TABLE CODES"
        title="Tables & QR codes"
        description="One code per table. Codes are printed from here and scanned by guests."
      />

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
      {tokens.error && <Notice tone="danger">{tokens.error}</Notice>}

      <div className="rounded-xl bg-slate-900 p-5 text-white">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <strong className="block text-3xl font-semibold">{tokens.rows.length}</strong>
            <span className="text-xs text-slate-300">tables</span>
          </div>
          <div>
            <strong className="block text-3xl font-semibold">{active}</strong>
            <span className="text-xs text-slate-300">codes live</span>
          </div>
          <p className="max-w-md text-xs leading-5 text-slate-300">
            A code points at this deployment's public address, so reprints keep working if the panel moves domain. Replacing a token invalidates the old printed code immediately.
          </p>
        </div>
      </div>

      <Card as="form" onSubmit={create} className="grid gap-4 p-6 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Table name or number">
          <input value={table} onChange={(event) => setTable(event.target.value)} placeholder="Table 7 / Rooftop 2" className={inputClass} />
        </Field>
        <Field label="Expires (optional)" hint="Used for a short-lived event code.">
          <input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} className={inputClass} />
        </Field>
        <div className="flex items-end">
          <button disabled={creating || !table.trim()} className="inline-flex h-11 items-center gap-2 rounded-lg bg-indigo-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
            <Plus size={16} />{creating ? 'Creating…' : 'Create code'}
          </button>
        </div>
      </Card>

      {tokens.loading && !tokens.rows.length
        ? <Spinner label="Loading tables" />
        : tokens.rows.length
          ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tokens.rows.map((token) => (
              <QrCard key={token.id} token={token} onChanged={tokens} log={log} />
            ))}
          </div>
          : <Card><EmptyState icon={QrCode} title="No table codes yet" description="Create one per table so guests can scan straight into the menu." /></Card>}
    </div>
  )
}
