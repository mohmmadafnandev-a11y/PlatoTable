import { useState } from 'react'
import { KeyRound, Mail, Save, Settings2, ShieldCheck, UserRound, Wrench } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { describeAuthError } from '../../lib/auth-errors'
import { usePlatformSettings, logActivity } from '../lib/data'
import { CURRENCIES, PASSWORD_MIN, passwordError } from '../../../shared/slug.js'
import { Card, Field, Notice, SectionHead, Spinner, inputClass } from './ui'

const TABS = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'trial', label: 'Trial & billing', icon: ShieldCheck },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'account', label: 'Your account', icon: UserRound },
]

function Account({ profile, onNameSaved }) {
  const [name, setName] = useState(profile?.name || '')
  const [nameState, setNameState] = useState({ saving: false, message: '', tone: 'info' })

  const [email, setEmail] = useState('')
  const [emailState, setEmailState] = useState({ saving: false, message: '', tone: 'info' })

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passwordState, setPasswordState] = useState({ saving: false, message: '', tone: 'info' })

  const saveName = async (event) => {
    event.preventDefault()
    if (!name.trim()) return setNameState({ saving: false, message: 'Enter a display name.', tone: 'danger' })
    setNameState({ saving: true, message: '', tone: 'info' })
    const { error } = await supabase.from('super_admins').update({ name: name.trim() }).eq('id', profile.id)
    if (error) return setNameState({ saving: false, message: error.message, tone: 'danger' })
    await logActivity({ superAdminId: profile.id, action: 'profile_name_updated', details: { name: name.trim() } })
    setNameState({ saving: false, message: 'Display name updated.', tone: 'success' })
    onNameSaved?.()
  }

  // Supabase emails a confirmation link to both the old and the new address, so
  // the change is not live until the new one is confirmed. Saying that up front
  // avoids the "it did not work" report.
  const changeEmail = async (event) => {
    event.preventDefault()
    if (!email.trim()) return setEmailState({ saving: false, message: 'Enter the new email address.', tone: 'danger' })
    setEmailState({ saving: true, message: '', tone: 'info' })
    const { error } = await supabase.auth.updateUser({ email: email.trim() })
    if (error) return setEmailState({ saving: false, message: describeAuthError(error).message, tone: 'danger' })
    await logActivity({ superAdminId: profile.id, action: 'profile_email_change_requested', details: { to: email.trim() } })
    setEmailState({
      saving: false,
      tone: 'success',
      message: `Confirmation sent to ${email.trim()} and to your current address. The new address takes effect once you open that link.`,
    })
    setEmail('')
  }

  // Verify the current password first: updateUser does not ask for it, so
  // without this step anyone at an unlocked browser could change it.
  const changePassword = async (event) => {
    event.preventDefault()
    const problem = passwordError(next)
    if (problem) return setPasswordState({ saving: false, message: problem, tone: 'danger' })
    if (next !== confirm) return setPasswordState({ saving: false, message: 'The two new passwords do not match.', tone: 'danger' })
    if (next === current) return setPasswordState({ saving: false, message: 'The new password is the same as the current one.', tone: 'danger' })

    setPasswordState({ saving: true, message: '', tone: 'info' })
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: profile.email,
      password: current,
    })
    if (verifyError) {
      const described = describeAuthError(verifyError)
      return setPasswordState({ saving: false, tone: 'danger', message: `Current password could not be verified. ${described.message}` })
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: next })
    if (updateError) return setPasswordState({ saving: false, message: describeAuthError(updateError).message, tone: 'danger' })

    await logActivity({ superAdminId: profile.id, action: 'profile_password_changed' })
    setCurrent(''); setNext(''); setConfirm('')
    setPasswordState({ saving: false, tone: 'success', message: 'Password updated. Use it the next time you sign in.' })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><UserRound size={19} /></span>
          <div>
            <h2 className="font-semibold text-slate-900">Your details</h2>
            <p className="text-sm text-slate-500">Shown on the audit trail for every action you take.</p>
          </div>
        </div>
        <form onSubmit={saveName} className="mt-6 grid gap-4">
          <Field label="Display name">
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" />
          </Field>
          <Field label="Sign-in email" hint="Change it below. Used to sign in, not for support mail.">
            <input className={inputClass} value={profile?.email || ''} readOnly disabled />
          </Field>
          {nameState.message && <Notice tone={nameState.tone}>{nameState.message}</Notice>}
          <button disabled={nameState.saving} className="justify-self-start rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">
            {nameState.saving ? 'Saving…' : 'Save name'}
          </button>
        </form>
      </Card>

      <Card className="p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><Mail size={19} /></span>
          <div>
            <h2 className="font-semibold text-slate-900">Change email</h2>
            <p className="text-sm text-slate-500">A confirmation link is sent to both addresses.</p>
          </div>
        </div>
        <form onSubmit={changeEmail} className="mt-6 grid gap-4">
          <Field label="New email address">
            <input type="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="new@example.com" />
          </Field>
          {emailState.message && <Notice tone={emailState.tone}>{emailState.message}</Notice>}
          <button disabled={emailState.saving} className="justify-self-start rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60">
            {emailState.saving ? 'Sending…' : 'Send confirmation'}
          </button>
        </form>
      </Card>

      <Card className="p-6 lg:col-span-2">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><KeyRound size={19} /></span>
          <div>
            <h2 className="font-semibold text-slate-900">Change password</h2>
            <p className="text-sm text-slate-500">At least {PASSWORD_MIN} characters. Your current password is required.</p>
          </div>
        </div>
        <form onSubmit={changePassword} className="mt-6 grid gap-4 sm:grid-cols-3">
          <Field label="Current password">
            <input type="password" autoComplete="current-password" className={inputClass} value={current} onChange={(event) => setCurrent(event.target.value)} />
          </Field>
          <Field label="New password">
            <input type="password" autoComplete="new-password" className={inputClass} value={next} onChange={(event) => setNext(event.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <input type="password" autoComplete="new-password" className={inputClass} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </Field>
          {passwordState.message && <div className="sm:col-span-3"><Notice tone={passwordState.tone}>{passwordState.message}</Notice></div>}
          <button disabled={passwordState.saving} className="justify-self-start rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">
            {passwordState.saving ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </Card>
    </div>
  )
}

function PlatformForm({ settings, save, superAdminId }) {
  // Seeded once from the loaded row. The parent only mounts this form after
  // the settings have arrived, so there is nothing to synchronise later and no
  // effect is needed to copy props into state.
  const [form, setForm] = useState(() => ({
    platform_name: settings.platform_name || '',
    support_email: settings.support_email || '',
    support_phone: settings.support_phone || '',
    default_currency: settings.default_currency || 'PKR',
    default_trial_days: settings.default_trial_days ?? 7,
    grace_period_days: settings.grace_period_days ?? 3,
    trial_enabled: !!settings.trial_enabled,
    notifications_enabled: !!settings.notifications_enabled,
    maintenance_mode: !!settings.maintenance_mode,
    maintenance_message: settings.maintenance_message || '',
  }))
  const [state, setState] = useState({ saving: false, message: '', tone: 'info' })

  const update = (patch) => setForm((current) => ({ ...current, ...patch }))
  const submit = async (event) => {
    event.preventDefault()
    if (!form.platform_name.trim()) return setState({ saving: false, message: 'The platform name cannot be empty.', tone: 'danger' })
    setState({ saving: true, message: '', tone: 'info' })
    const { error } = await save({
      ...form,
      platform_name: form.platform_name.trim(),
      support_email: form.support_email.trim() || null,
      support_phone: form.support_phone.trim() || null,
      default_trial_days: Number(form.default_trial_days) || 0,
      grace_period_days: Number(form.grace_period_days) || 0,
      maintenance_message: form.maintenance_message.trim() || null,
    })
    if (error) return setState({ saving: false, message: error.message, tone: 'danger' })
    await logActivity({ superAdminId, action: 'platform_settings_updated', details: { platform_name: form.platform_name.trim() } })
    setState({ saving: false, message: 'Platform settings saved.', tone: 'success' })
  }

  const toggles = [
    ['trial_enabled', 'Free trials', 'Allow new restaurants to start on a trial period.'],
    ['notifications_enabled', 'Restaurant notifications', 'Let the notification centre deliver messages to restaurants.'],
    ['maintenance_mode', 'Maintenance mode', 'Show a maintenance notice on the public pages.'],
  ]

  return (
    <form onSubmit={submit} className="grid gap-6">
      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Platform identity</h2>
        <p className="mt-1 text-sm text-slate-500">Published on the public landing page and the restaurant contact cards.</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Platform name">
            <input className={inputClass} value={form.platform_name} onChange={(event) => update({ platform_name: event.target.value })} />
          </Field>
          <Field label="Default currency">
            <select className={inputClass} value={form.default_currency} onChange={(event) => update({ default_currency: event.target.value })}>
              {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </Field>
          <Field label="Support email" hint="Shown publicly for onboarding and invoices.">
            <input type="email" className={inputClass} value={form.support_email} onChange={(event) => update({ support_email: event.target.value })} placeholder="support@example.com" />
          </Field>
          <Field label="Support phone" hint="Shown publicly on the landing page.">
            <input className={inputClass} value={form.support_phone} onChange={(event) => update({ support_phone: event.target.value })} placeholder="+92 300 0000000" />
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Trials & billing</h2>
        <p className="mt-1 text-sm text-slate-500">Defaults applied when a restaurant is onboarded.</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Default trial days">
            <input type="number" min="0" max="90" className={inputClass} value={form.default_trial_days} onChange={(event) => update({ default_trial_days: event.target.value })} />
          </Field>
          <Field label="Grace period (days)" hint="How long a restaurant keeps working after a failed payment.">
            <input type="number" min="0" max="30" className={inputClass} value={form.grace_period_days} onChange={(event) => update({ grace_period_days: event.target.value })} />
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Features & maintenance</h2>
        <div className="mt-5 grid gap-3">
          {toggles.map(([key, label, description]) => (
            <label key={key} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-4 transition hover:border-indigo-200">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-indigo-600" checked={form[key]} onChange={(event) => update({ [key]: event.target.checked })} />
              <span>
                <strong className="block text-sm font-semibold text-slate-800">{label}</strong>
                <small className="text-slate-500">{description}</small>
              </span>
            </label>
          ))}
        </div>
        {form.maintenance_mode && (
          <div className="mt-5">
            <Field label="Maintenance message">
              <textarea rows="3" className={`${inputClass} h-auto py-3`} value={form.maintenance_message} onChange={(event) => update({ maintenance_message: event.target.value })} placeholder="We are doing a short maintenance and will be back shortly." />
            </Field>
          </div>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-4">
        <button disabled={state.saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-60">
          <Save size={16} />{state.saving ? 'Saving…' : 'Save settings'}
        </button>
        {state.message && <div className="flex-1"><Notice tone={state.tone}>{state.message}</Notice></div>}
      </div>
    </form>
  )
}

export default function SystemSettings({ profile }) {
  const { settings, loading, error, save } = usePlatformSettings()
  const [tab, setTab] = useState('general')

  return (
    <>
      <SectionHead
        eyebrow="PLATFORM CONFIGURATION"
        title="System settings"
        description="Platform identity, trial defaults, and your own Super Admin account."
      />

      <div className="mb-6 flex gap-2 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-semibold transition ${tab === id ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:border-indigo-200'}`}
          >
            <Icon size={16} />{label}
          </button>
        ))}
      </div>

      {tab === 'account' && <Account profile={profile} />}

      {tab !== 'account' && (
        <>
          {loading && <Spinner label="Loading platform settings" />}
          {error && <Notice tone="danger">{error}</Notice>}
          {!loading && !settings && !error && (
            <Notice tone="warning">
              No platform settings row exists yet. Apply the platform migration, then reload this page.
            </Notice>
          )}
          {settings && (
            <PlatformForm
              settings={settings}
              save={save}
              superAdminId={profile?.id}
            />
          )}
        </>
      )}
    </>
  )
}
