import { useState } from 'react'
import { Copy, KeyRound, Link2, MailCheck, RefreshCw, ShieldAlert } from 'lucide-react'
import { postAuthorized } from '../lib/api'
import { PASSWORD_MIN, passwordError, suggestPassword } from '../../../shared/slug.js'
import { Card, Field, Notice, inputClass } from './ui'

// The restaurant owner's way in.
//
// Three jobs, all of them support calls that used to end in "ask them to use the
// forgot-password link" — which this platform could not deliver, because email
// depends on SMTP being configured for the Supabase project:
//
//   * change the sign-in email when the owner's address has changed
//   * set a password outright, for the call where the owner is on the phone and
//     cannot receive mail at all
//   * mint a single-use reset link to hand over, which needs no mail server
//
// Every action runs through /api/restaurants/owner with the service role, so the
// password never exists in the browser longer than it takes to POST it, and it is
// never stored, logged, or echoed back by the platform.

const action = (restaurantId, body) => postAuthorized('/api/restaurants/owner', { restaurantId, ...body })

export default function RestaurantOwnerCard({ restaurant, onChanged }) {
  const [email, setEmail] = useState(restaurant.owner_email || '')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(true)
  const [busy, setBusy] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [resetLink, setResetLink] = useState('')
  const [copied, setCopied] = useState('')

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      setFeedback({ tone: 'warning', text: 'The browser blocked clipboard access. Select the text and copy it by hand.' })
    }
  }

  const saveEmail = async (event) => {
    event.preventDefault()
    setBusy('email')
    setFeedback(null)
    setResetLink('')
    try {
      const result = await action(restaurant.id, { action: 'setEmail', email: email.trim() })
      setFeedback({ tone: 'success', text: `Sign-in email changed from ${result.previous} to ${result.email}. Tell the owner before they next sign in.` })
      onChanged?.()
    } catch (failure) {
      setFeedback({ tone: 'danger', text: failure.message })
    }
    setBusy('')
  }

  const savePassword = async (event) => {
    event.preventDefault()
    const problem = passwordError(password)
    if (problem) return setFeedback({ tone: 'danger', text: problem })
    setBusy('password')
    setFeedback(null)
    setResetLink('')
    try {
      const result = await action(restaurant.id, { action: 'setPassword', password })
      // The password stays in the field on purpose: the operator has to read it
      // out or copy it, and nothing here can show it to them a second time.
      setFeedback({ tone: 'success', text: `A new password is set for ${result.email}. Copy it now — the platform does not store it, and it cannot be shown again.` })
    } catch (failure) {
      setFeedback({ tone: 'danger', text: failure.message })
    }
    setBusy('')
  }

  const createResetLink = async () => {
    setBusy('link')
    setFeedback(null)
    try {
      const result = await action(restaurant.id, { action: 'resetLink' })
      setResetLink(result.link)
      setFeedback({ tone: 'success', text: `A single-use reset link is ready for ${result.email}. It expires in about ${result.expiresInMinutes} minutes and can only be used once.` })
    } catch (failure) {
      setFeedback({ tone: 'danger', text: failure.message })
    }
    setBusy('')
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-900">Owner account</h2>
          <p className="mt-1 text-sm text-slate-500">The sign-in the restaurant uses. Changes take effect immediately.</p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{restaurant.owner_email || 'No owner email on file'}</span>
      </div>

      {feedback && <div className="mt-5"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <form onSubmit={saveEmail} className="grid content-start gap-3">
          <Field label="Sign-in email" hint="The owner signs in with this address. It is changed in Auth and on the restaurant record together.">
            <input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="owner@restaurant.com" className={inputClass} />
          </Field>
          <button disabled={busy === 'email' || !email.trim() || email.trim() === restaurant.owner_email} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">
            <MailCheck size={16} />{busy === 'email' ? 'Changing…' : 'Change email'}
          </button>
        </form>

        <form onSubmit={savePassword} className="grid content-start gap-3">
          <Field label="Set a new password" hint={`At least ${PASSWORD_MIN} characters. Read it to the owner, or copy it before you leave this screen.`}>
            <div className="flex gap-2">
              <input
                required
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Type or generate one"
                autoComplete="new-password"
                className={inputClass}
              />
              <button type="button" title="Generate a strong password" onClick={() => setPassword(suggestPassword())} className="grid h-11 w-11 flex-none place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">
                <RefreshCw size={16} />
              </button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy === 'password' || !password} className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              <KeyRound size={16} />{busy === 'password' ? 'Setting…' : 'Set password'}
            </button>
            <button type="button" onClick={() => setShow(!show)} className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-600">{show ? 'Hide' : 'Show'}</button>
            {password && <button type="button" onClick={() => copy(password)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-600"><Copy size={15} />{copied === password ? 'Copied' : 'Copy'}</button>}
          </div>
        </form>

        <div className="grid content-start gap-3">
          <div>
            <p className="text-sm font-medium text-slate-700">Send a reset link</p>
            <p className="mt-1 text-xs text-slate-500">
              A single-use link to set their own password. Use this when the owner's email works but no reset mail arrives — it needs no mail server on this project.
            </p>
          </div>
          <button type="button" disabled={busy === 'link'} onClick={createResetLink} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">
            <Link2 size={16} />{busy === 'link' ? 'Creating…' : 'Create reset link'}
          </button>
          {resetLink && (
            <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <code className="break-all text-xs text-slate-600">{resetLink}</code>
              <div className="flex gap-2">
                <button type="button" onClick={() => copy(resetLink)} className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600"><Copy size={13} />{copied === resetLink ? 'Copied' : 'Copy link'}</button>
                <a href={resetLink} target="_blank" rel="noreferrer" className="rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600">Open</a>
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="mt-6 flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
        <ShieldAlert size={15} className="mt-0.5 flex-none" />
        Setting a password signs the owner's other sessions out. The mail-based reset only works when Supabase has an SMTP provider configured; the link above works either way.
      </p>
    </Card>
  )
}
