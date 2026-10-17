import { useEffect, useMemo, useState } from 'react'
import { COUNTRIES, CURRENCY, PASSWORD_MIN, passwordError, slugError, slugify, suggestPassword } from '../../../shared/slug.js'
import { customPlanError, intervalLabel, intervalUnit, resolvePlanPrice } from '../../../shared/plans.js'
import { money } from '../lib/format'
import { supabase } from '../lib/supabase'

const initialForm = {
  name: '',
  subdomain: '',
  ownerName: '',
  ownerEmail: '',
  ownerPassword: '',
  phone: '',
  country: 'PK',
  planId: '',
  // One trial decision, asked once, whichever kind of plan is chosen. The days
  // are only a number once the trial is actually on, which is why `trialOn`
  // exists rather than treating 0 days as "no trial".
  trialOn: true,
  trialDays: '7',
  customDomain: '',
  notes: '',
}

const inputClass = 'h-11 rounded-lg border border-slate-300 px-3 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100'
const labelClass = 'grid gap-2 text-sm font-medium text-slate-700'

export default function RestaurantOnboarding({ navigate }) {
  const [form, setForm] = useState(initialForm)
  const [plans, setPlans] = useState([])
  // A restaurant can be put on a catalogue plan, on a bespoke plan sized here, or
  // on nothing yet. `custom` holds the bespoke values so switching back and forth
  // between the two modes does not lose what was typed. The trial is not in here:
  // it belongs to the restaurant, not to the plan, so it is answered once.
  const [planMode, setPlanMode] = useState('catalogue')
  const [custom, setCustom] = useState({ days: '30', price: '' })
  const setCustomField = (field) => (event) => setCustom((current) => ({ ...current, [field]: event.target.value }))
  const setField = (field, value) => setForm((current) => ({ ...current, [field]: value }))
  // What the server will be told about the trial. 0 means "no trial", and the
  // account is then created suspended until a paid subscription is attached.
  const trialDays = form.trialOn ? Number(form.trialDays) : 0
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState('')

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))

  useEffect(() => {
    if (!supabase) return
    // Only active plans can be chosen, and the interval matters here: a yearly
    // plan must not be shown as if it billed monthly. A plan is priced in one
    // currency, so there is one price column to read.
    supabase.from('subscription_plans')
      .select('id, name, trial_days, duration_days, interval, interval_count, price_pkr')
      .eq('is_active', true).eq('is_public', true).order('interval').order('name')
      .then(({ data }) => setPlans(data || []))
  }, [])

  // The platform's default trial length seeds the field, so an operator who has
  // set a house default does not retype it on every restaurant. Seeded only while
  // the field still holds the initial value: a number already typed here wins.
  useEffect(() => {
    if (!supabase) return
    supabase.from('platform_settings').select('default_trial_days').maybeSingle().then(({ data }) => {
      if (data?.default_trial_days === null || data?.default_trial_days === undefined) return
      setForm((current) => (current.trialDays === initialForm.trialDays
        ? { ...current, trialDays: String(data.default_trial_days) }
        : current))
    })
  }, [])

  // The suggestion stops following the name once the subdomain is typed by
  // hand, so a deliberate choice is never overwritten mid-edit.
  const setName = (event) => {
    const name = event.target.value
    setForm((current) => ({ ...current, name, subdomain: slugEdited ? current.subdomain : slugify(name) }))
  }

  const subdomain = form.subdomain.trim().toLowerCase()
  const slugProblem = subdomain ? slugError(subdomain) : ''
  const passwordProblem = form.ownerPassword ? passwordError(form.ownerPassword) : ''
  const selectedPlan = plans.find((plan) => plan.id === form.planId)
  // Validated with the same function the server uses, so a bespoke plan the form
  // accepts can never be refused after the owner's account already exists.
  const customProblem = planMode === 'custom'
    ? customPlanError({ days: Number(custom.days), price: Number(custom.price), trialDays, currency: CURRENCY })
    : ''
  const customTotal = Number(custom.price) > 0 && Number(custom.days) > 0
    ? `Charges ${money(Number(custom.price), CURRENCY)} every ${custom.days} day${Number(custom.days) === 1 ? '' : 's'}${form.trialOn ? `, after a ${form.trialDays} day free trial` : ', with no free trial'}.`
    : ''
  // One resolver shared with the checkout endpoint, so the price shown here is
  // the price that will be charged rather than a second guess at it.
  const priced = selectedPlan ? resolvePlanPrice(selectedPlan, CURRENCY) : null

  // A plan with no rupee price is refused by the database, so it is surfaced
  // here instead of failing after the owner account is created.
  const pricingProblem = selectedPlan && !priced
    ? `The ${selectedPlan.name} plan has no ${CURRENCY} price yet. Add one in Plans & pricing, or onboard with no plan.`
    : ''

  const canSubmit = useMemo(() => Boolean(
    form.name.trim() && subdomain && !slugProblem && form.ownerName.trim() && form.ownerEmail.trim()
    && form.ownerPassword && !passwordProblem && !pricingProblem && !customProblem && !saving
  ), [form, subdomain, slugProblem, passwordProblem, pricingProblem, customProblem, saving])

  const submit = async (event) => {
    event.preventDefault()
    setFeedback('')
    if (!supabase) return setFeedback('Supabase is not configured.')
    if (slugProblem) return setFeedback(slugProblem)
    if (passwordProblem) return setFeedback(passwordProblem)
    if (pricingProblem) return setFeedback(pricingProblem)
    if (customProblem) return setFeedback(customProblem)
    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(false); return setFeedback('Your session expired. Please sign in again.') }
    const payload = {
      ...form,
      subdomain,
      currency: CURRENCY,
      customDomain: form.customDomain.trim().toLowerCase(),
      planId: planMode === 'catalogue' ? (form.planId || null) : null,
      trialDays,
      // Sent instead of a catalogue plan id. The server creates the plan in
      // Safepay and hands its id to the onboarding transaction, so a restaurant
      // can be billed for it immediately. The trial is the same decision
      // either way, so it is carried on both.
      customPlan: planMode === 'custom' ? {
        days: Number(custom.days),
        price: Number(custom.price),
        trialDays,
        currency: CURRENCY,
      } : null,
    }
    try {
      const response = await fetch('/api/restaurants/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Restaurant onboarding failed.')
      setResult(body)
    } catch (error) {
      setFeedback(error.message || 'Restaurant onboarding failed.')
    }
    setSaving(false)
  }

  const copy = async (key, value) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); window.setTimeout(() => setCopied(''), 1800) } catch { setFeedback('Copying failed — select the text and copy it manually.') }
  }

  if (result) return <Handover result={result} navigate={navigate} onReset={() => { setResult(null); setForm(initialForm); setSlugEdited(false) }} copy={copy} copied={copied} />

  return <section className="mx-auto max-w-3xl">
    <button onClick={() => navigate('/restaurants')} className="mb-5 text-sm font-semibold text-indigo-600">← Restaurants</button>
    <div className="mb-7">
      <p className="text-xs font-semibold tracking-[.16em] text-indigo-600">SECURE ONBOARDING</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Add restaurant</h1>
      <p className="mt-2 text-sm text-slate-500">Creates the owner account, restaurant workspace, subscription record, and tenant URLs in one step.</p>
    </div>

    <form onSubmit={submit} className="grid gap-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-semibold">Restaurant and owner</legend>

        <label className={labelClass}>Restaurant name
          <input required value={form.name} onChange={setName} placeholder="Spice Garden" className={inputClass} />
        </label>

        <label className={labelClass}>Subdomain
          <input
            required
            value={form.subdomain}
            onChange={(event) => { setSlugEdited(true); setForm((current) => ({ ...current, subdomain: slugify(event.target.value) || event.target.value.toLowerCase() })) }}
            placeholder="spice-garden"
            aria-invalid={Boolean(slugProblem)}
            aria-describedby="slug-help"
            className={`${inputClass} ${slugProblem ? 'border-red-300 focus:border-red-500 focus:ring-red-100' : ''}`}
          />
          <small id="slug-help" className={slugProblem ? 'text-red-600' : 'text-slate-500'}>
            {slugProblem || `Customer menu: /${subdomain || 'your-restaurant'} · Admin: /admin/${subdomain || 'your-restaurant'}`}
          </small>
        </label>

        <label className={labelClass}>Owner name
          <input required value={form.ownerName} onChange={set('ownerName')} placeholder="Ahmed Khan" className={inputClass} />
        </label>

        <label className={labelClass}>Owner email
          <input required type="email" value={form.ownerEmail} onChange={set('ownerEmail')} placeholder="owner@restaurant.com" className={inputClass} />
        </label>

        <label className={`${labelClass} sm:col-span-2`}>Owner password
          <span className="flex gap-2">
            <input
              required
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.ownerPassword}
              onChange={set('ownerPassword')}
              aria-describedby="password-help"
              className={`${inputClass} flex-1 ${passwordProblem ? 'border-red-300' : ''}`}
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700">{showPassword ? 'Hide' : 'Show'}</button>
            <button type="button" onClick={() => { setShowPassword(true); setForm((current) => ({ ...current, ownerPassword: suggestPassword() })) }} className="rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700">Generate</button>
          </span>
          <small id="password-help" className={passwordProblem ? 'text-red-600' : 'text-slate-500'}>
            {passwordProblem || `At least ${PASSWORD_MIN} characters. The owner can change it after signing in.`}
          </small>
        </label>

        <label className={labelClass}>Phone (optional)
          <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+92 300 1234567" className={inputClass} />
        </label>

        <label className={labelClass}>Country
          <select
            value={form.country}
            onChange={set('country')}
            className={`${inputClass} bg-white`}
          >
            {COUNTRIES.map((country) => <option key={country.code} value={country.code}>{country.name}</option>)}
          </select>
        </label>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-semibold">Subscription</legend>

        <label className={labelClass}>Billing currency
          <input value={CURRENCY} readOnly disabled className={`${inputClass} bg-slate-100 text-slate-500`} />
          <small className="text-slate-500">Every plan, invoice, and report is in dollars.</small>
        </label>

        <div className="sm:col-span-2">
          <p className="mb-2 text-sm font-medium text-slate-700">Billing plan</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setPlanMode('catalogue')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${planMode === 'catalogue' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>Choose from catalogue</button>
            <button type="button" onClick={() => setPlanMode('custom')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${planMode === 'custom' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>Custom plan</button>
          </div>
        </div>

        <label className={labelClass}>{planMode === 'custom' ? 'Catalogue plan (not used)' : 'Plan'}
          <select value={form.planId} onChange={set('planId')} disabled={planMode === 'custom'} className={`${inputClass} bg-white disabled:bg-slate-100 disabled:text-slate-400`}>
            <option value="">{planMode === 'custom' ? 'A custom plan is being created instead' : 'No plan selected'}</option>
            {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} — {intervalLabel(plan)}</option>)}
          </select>
          {planMode === 'custom' && <span className="mt-2 grid gap-4 rounded-lg border border-indigo-100 bg-indigo-50/40 p-4 sm:grid-cols-2">
            <span className="grid gap-2 text-sm font-medium text-slate-700">Billing period (days)
              <input required type="number" min="1" max="365" value={custom.days} onChange={setCustomField('days')} className={inputClass} />
              <small className="font-normal text-slate-500">What one payment covers — 30 for a month, 365 for a year.</small>
            </span>
            <span className="grid gap-2 text-sm font-medium text-slate-700">Price per period ({CURRENCY})
              <input required type="number" min="1" step="0.01" value={custom.price} onChange={setCustomField('price')} placeholder="2000" className={inputClass} />
              <small className="font-normal text-slate-500">Saved as a hidden plan and mirrored into Safepay at this price.</small>
            </span>
            <p className={`sm:col-span-2 text-sm ${customProblem ? 'text-red-600' : 'text-slate-600'}`}>{customProblem || customTotal || 'Enter a billing period and a price.'}</p>
          </span>}
          {planMode === 'catalogue' && selectedPlan && <small className={pricingProblem ? 'text-amber-700' : 'text-slate-500'}>
            {pricingProblem || `${money(priced.amount, CURRENCY)} per ${intervalUnit(selectedPlan)} · ${selectedPlan.trial_days} day trial in the plan · ${selectedPlan.duration_days} day cycle`}
          </small>}
        </label>

        {/* One trial decision, asked once, for either kind of plan. Turning it on
            reveals the length; turning it off hides the field, because a trial
            that is not being given has no length to enter. */}
        <div className="rounded-xl border border-slate-200 p-4 sm:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">Free trial</p>
              <p className="mt-1 text-xs text-slate-500">
                {form.trialOn
                  ? 'Full access before the first payment. Safepay is told the length when the restaurant adds a card.'
                  : 'No trial. The account is created suspended and stays that way until a paid subscription is attached.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Free trial">
              <button type="button" aria-pressed={form.trialOn} onClick={() => setField('trialOn', true)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${form.trialOn ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>Trial on</button>
              <button type="button" aria-pressed={!form.trialOn} onClick={() => setField('trialOn', false)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${form.trialOn ? 'border border-slate-200 bg-white text-slate-600' : 'bg-indigo-600 text-white'}`}>Trial off</button>
            </div>
          </div>
          {form.trialOn && (
            <label className="mt-4 grid max-w-xs gap-2 text-sm font-medium text-slate-700">Trial length (days)
              <input required type="number" min="1" max="365" value={form.trialDays} onChange={set('trialDays')} className={inputClass} />
              <small className="font-normal text-slate-500">Counted from the moment this restaurant is created.</small>
            </label>
          )}
        </div>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 font-semibold">Optional</legend>

        <label className={labelClass}>Custom domain
          <input value={form.customDomain} onChange={set('customDomain')} placeholder="menu.example.com" className={inputClass} />
          <small className="text-slate-500">Without http:// and without a path. Point its DNS here afterwards.</small>
        </label>

        <label className={labelClass}>Internal notes
          <input value={form.notes} onChange={set('notes')} placeholder="Only visible to the platform team" className={inputClass} />
        </label>
      </fieldset>

      {feedback && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{feedback}</p>}

      <button disabled={!canSubmit} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">
        {saving ? 'Creating workspace…' : 'Create restaurant'}
      </button>
    </form>
  </section>
}

// The owner's password is never stored by the platform, so this is the only
// moment it can be read. It is shown once, with everything needed to hand over.
function Handover({ result, navigate, onReset, copy, copied }) {
  const { restaurant, credentials, links } = result
  return <section className="mx-auto max-w-3xl">
    <div className="mb-7">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-100 text-lg text-emerald-700">✓</span>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight">Restaurant created</h1>
      <p className="mt-2 text-sm text-slate-500">Copy these details now — the password is not stored and cannot be shown again. The owner can change it from Settings after signing in.</p>
    </div>

    <article className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="font-semibold">Owner credentials</h2>
      <dl className="mt-5 grid gap-4">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Sign-in email</dt>
          <dd className="mt-1 flex items-center gap-3"><code className="flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-sm">{credentials.email}</code><button onClick={() => copy('email', credentials.email)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">{copied === 'email' ? 'Copied' : 'Copy'}</button></dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Temporary password</dt>
          <dd className="mt-1 flex items-center gap-3"><code className="flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-sm">{credentials.password}</code><button onClick={() => copy('password', credentials.password)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">{copied === 'password' ? 'Copied' : 'Copy'}</button></dd>
        </div>
      </dl>

      <h2 className="mt-8 font-semibold">Tenant links</h2>
      <div className="mt-4 grid gap-3">
        {links.admin && <LinkRow label="Restaurant admin" value={links.admin} copyKey="admin" copy={copy} copied={copied} />}
        {links.menu && <LinkRow label="Customer menu" value={links.menu} copyKey="menu" copy={copy} copied={copied} />}
        {links.customDomain && <p className="text-sm text-slate-600">Custom domain: <strong className="font-semibold">{links.customDomain}</strong> — add its DNS record before sharing it.</p>}
        {!links.admin && !links.menu && <p className="text-sm text-amber-700">This request carried no host, so tenant links could not be generated. Open the restaurant’s detail page to create its URLs.</p>}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <button onClick={() => navigate(`/restaurants/${restaurant.restaurant_id}`)} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">Open restaurant</button>
        <button onClick={onReset} className="rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Add another</button>
      </div>
    </article>
  </section>
}

function LinkRow({ label, value, copyKey, copy, copied }) {
  return <div>
    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
    <div className="mt-1 flex items-center gap-3">
      <a href={value} target="_blank" rel="noreferrer" className="flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-sm text-indigo-700 underline">{value}</a>
      <button onClick={() => copy(copyKey, value)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">{copied === copyKey ? 'Copied' : 'Copy'}</button>
    </div>
  </div>
}
