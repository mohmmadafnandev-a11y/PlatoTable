import { useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudOff, CreditCard, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { CURRENCY, INTERVALS, featureList, intervalLabel, intervalUnit, planDurationDays, planError } from '../../../shared/plans.js'
import { usePlans } from '../lib/data'
import { deletePlan, savePlan } from '../lib/billing-api'
import { money, relativeTime, shortDate } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

// Plans are the catalog the whole billing side of the platform depends on, so
// this screen is where money is defined. Three rules shape it:
//
//  1. A plan is mirrored into Safepay as a reusable plan, and the row records
//     the tokens that were minted. Prices are in rupees, which is the only
//     currency the platform sells in. Safepay cannot change the amount on an
//     existing plan, so a changed price mints a new
//     token — and the token whose price no longer matches is never used for a
//     checkout, so nobody is charged last month's figure.
//
//  2. A plan with a trial gets TWO Safepay plans: the trial itself lives on the
//     Safepay plan, and a restaurant that has already used its trial must not be
//     sent to it again. The second plan is the renewal one, with no trial.
//
//  3. Saving is never rolled back because Safepay was unavailable. Safepay's
//     refusal is reported next to the plan it applies to, and Re-sync retries it.

const emptyPlan = () => ({
  id: null,
  name: '',
  interval: 'month',
  interval_count: 1,
  trial_days: 7,
  is_active: true,
  features: '',
  price_pkr: '',
})

/** A row becomes a form. The price is a string so a half-typed number stays valid. */
function toForm(plan) {
  return {
    id: plan.id,
    name: plan.name || '',
    interval: plan.interval || 'month',
    interval_count: plan.interval_count || 1,
    trial_days: plan.trial_days ?? 0,
    is_active: plan.is_active !== false,
    features: featureList(plan.features).join('\n'),
    price_pkr: plan.price_pkr === null || plan.price_pkr === undefined ? '' : String(plan.price_pkr),
  }
}

/** The form becomes the payload the endpoint expects. */
function toPayload(form) {
  const raw = String(form.price_pkr ?? '').trim()
  return {
    id: form.id,
    name: form.name,
    interval: form.interval,
    interval_count: Number(form.interval_count),
    trial_days: Number(form.trial_days),
    is_active: form.is_active,
    features: featureList(form.features),
    price_pkr: raw === '' ? null : Number(raw),
  }
}

/** A plan is linked when Safepay holds the token(s) this plan's shape needs. */
const planLinked = (plan) => Boolean(plan.safepay_plan_id) && !plan.safepay_sync_error

export default function Plans() {
  const { plans, loading, error, reload } = usePlans()
  const [editing, setEditing] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState('')

  const linked = plans.filter(planLinked).length
  const unsynced = plans.filter((plan) => !planLinked(plan)).length

  // Re-sync is a push, not a pull: Safepay has no endpoint that lists a
  // merchant's plans, so the catalogue cannot be read back. Saving a plan is
  // what creates or refreshes its tokens, so this saves the ones that are not
  // linked yet and re-saves any that Safepay refused last time.
  const resync = async () => {
    setSyncing(true); setFeedback(null)
    const pending = plans.filter((plan) => !planLinked(plan))
    if (!pending.length) {
      setFeedback({ tone: 'success', text: 'Every plan is already linked in Safepay.' })
      setSyncing(false)
      return
    }
    const failures = []
    let done = 0
    for (const plan of pending) {
      try {
        const result = await savePlan(toPayload(toForm(plan)))
        if (result.safepay?.errors?.length) failures.push(`${plan.name}: ${result.safepay.errors.join(' ')}`)
        else done += 1
      } catch (requestError) {
        failures.push(`${plan.name}: ${requestError.message}`)
      }
    }
    setFeedback(failures.length
      ? { tone: 'warning', text: `Linked ${done} of ${pending.length}. ${failures.join(' · ')}` }
      : { tone: 'success', text: `Linked ${done} plan${done === 1 ? '' : 's'} in Safepay.` })
    await reload()
    setSyncing(false)
  }

  const remove = async (plan) => {
    if (!window.confirm(`Delete “${plan.name}”? Its Safepay plan is closed to new checkouts, but past payments are kept.`)) return
    setBusy(plan.id); setFeedback(null)
    try {
      await deletePlan(plan.id)
      setFeedback({ tone: 'success', text: `${plan.name} deleted. Its Safepay plan was closed.` })
      if (editing?.id === plan.id) setEditing(null)
      await reload()
    } catch (requestError) {
      setFeedback({ tone: requestError.status === 409 ? 'warning' : 'danger', text: requestError.message })
    }
    setBusy('')
  }

  const toggleActive = async (plan) => {
    setBusy(plan.id); setFeedback(null)
    try {
      const result = await savePlan({ ...toPayload(toForm(plan)), is_active: !plan.is_active })
      setFeedback(plan.is_active
        ? { tone: 'success', text: `${plan.name} deactivated. Existing subscriptions keep running; it can no longer be chosen for new restaurants.` }
        : { tone: 'success', text: `${plan.name} is available again.` })
      if (result.safepay?.errors?.length) {
        setFeedback({ tone: 'warning', text: `Saved, but Safepay reported: ${result.safepay.errors.join(' · ')}` })
      }
      await reload()
    } catch (requestError) {
      setFeedback({ tone: 'danger', text: requestError.message })
    }
    setBusy('')
  }

  return <>
    <SectionHead
      eyebrow="PRODUCT CATALOG"
      title="Plans & pricing"
      description={`Each plan is a reusable Safepay plan, charged in ${CURRENCY}.`}
      action={<div className="flex flex-wrap gap-2">
        <button onClick={resync} disabled={syncing} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Linking…' : 'Re-sync with Safepay'}
        </button>
        <button onClick={() => { setEditing(emptyPlan()); setFeedback(null) }} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500">
          <Plus size={16} />New plan
        </button>
      </div>}
    />

    <div className="mb-5 grid gap-3">
      {feedback && <Notice tone={feedback.tone} action={<button onClick={() => setFeedback(null)} aria-label="Dismiss" className="text-current opacity-70 hover:opacity-100"><X size={16} /></button>}>{feedback.text}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!loading && Boolean(plans.length) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-500">
          <span className="inline-flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-600" />{linked} of {plans.length} linked in Safepay</span>
          {unsynced > 0 && <span className="inline-flex items-center gap-2 text-amber-700"><AlertTriangle size={14} />{unsynced} not linked yet</span>}
        </div>
      )}
    </div>

    {editing && <PlanEditor
      key={editing.id || 'new'}
      initial={editing}
      onCancel={() => setEditing(null)}
      onSaved={async (result, wasNew) => {
        const failures = result.safepay?.errors || []
        setFeedback(failures.length
          ? { tone: 'warning', text: `${result.plan.name} saved. Safepay could not create it — ${failures.join(' ')}` }
          : wasNew
            ? { tone: 'success', text: `${result.plan.name} created in this database and linked in Safepay.` }
            : { tone: 'success', text: `${result.plan.name} updated and re-linked in Safepay.` })
        setEditing(null)
        await reload()
      }}
    />}

    {loading ? <Spinner label="Loading plans" /> : !plans.length ? (
      <Card className="p-0">
        <EmptyState
          icon={CreditCard}
          title="No plans yet"
          description="Create your first plan — it is written to this database and mirrored into Safepay as a reusable plan."
          action={<button onClick={() => setEditing(emptyPlan())} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">Create a plan</button>}
        />
      </Card>
    ) : (
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            busy={busy === plan.id}
            onEdit={() => { setEditing(toForm(plan)); setFeedback(null); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
            onToggle={() => toggleActive(plan)}
            onDelete={() => remove(plan)}
          />
        ))}
      </div>
    )}
  </>
}

function PlanCard({ plan, busy, onEdit, onToggle, onDelete }) {
  const amount = plan.price_pkr === null || plan.price_pkr === undefined || plan.price_pkr === '' ? null : Number(plan.price_pkr)
  const inSafepay = Boolean(plan.safepay_plan_id)
  // A plan with a trial is mirrored twice, and both tokens are what a checkout
  // needs: the trial one for a first subscription, the other for every one after.
  const wantsTrialPlan = Number(plan.trial_days) > 0
  const fullyLinked = inSafepay && (!wantsTrialPlan || Boolean(plan.safepay_plan_id_trial))

  return (
    <Card className={`flex flex-col ${plan.is_active ? '' : 'opacity-80'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">{plan.name}</h2>
          <p className="mt-1 text-xs font-medium text-slate-500">{intervalLabel(plan)} · {plan.trial_days} day trial</p>
        </div>
        <StatusBadge status={plan.is_active ? 'active' : 'canceled'} />
      </div>

      <div className="mt-5 grid gap-1.5">
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-semibold text-slate-900">
            {amount === null ? <span className="font-medium text-amber-700">No price set</span> : <>{money(amount, CURRENCY)}<span className="ml-1 text-xs font-normal text-slate-400">/{intervalUnit(plan)}</span></>}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs">
            {fullyLinked
              ? <><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="text-slate-400">Linked in Safepay</span></>
              : <><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /><span className="text-amber-700">{inSafepay ? 'Trial plan missing' : 'Not linked'}</span></>}
          </span>
        </p>
      </div>

      {featureList(plan.features).length > 0 && (
        <ul className="mt-5 grid gap-1.5 border-t border-slate-100 pt-4 text-sm text-slate-600">
          {featureList(plan.features).map((feature) => <li key={feature} className="flex gap-2"><span className="text-indigo-500">•</span>{feature}</li>)}
        </ul>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">
        {plan.safepay_sync_error ? (
          <p className="flex gap-2 text-amber-700"><CloudOff size={14} className="mt-0.5 flex-none" /><span>Not linked — {plan.safepay_sync_error}</span></p>
        ) : fullyLinked ? (
          <p className="flex gap-2 text-emerald-700">
            <CheckCircle2 size={14} className="mt-0.5 flex-none" />
            <span>
              Linked as <code className="text-[11px]">{plan.safepay_plan_id}</code>
              {wantsTrialPlan ? <> and <code className="text-[11px]">{plan.safepay_plan_id_trial}</code> (trial)</> : null}
              {plan.safepay_synced_at ? ` · ${relativeTime(plan.safepay_synced_at)}` : ''}
            </span>
          </p>
        ) : (
          <p className="flex gap-2"><CloudOff size={14} className="mt-0.5 flex-none" /><span>Not in Safepay yet — edit and save, or use Re-sync.</span></p>
        )}
        <p className="mt-2">{plan.duration_days} day billing cycle · updated {shortDate(plan.updated_at)}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Pencil size={14} />Edit</button>
        <button onClick={onToggle} disabled={busy} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">{busy ? 'Saving…' : plan.is_active ? 'Deactivate' : 'Activate'}</button>
        <button onClick={onDelete} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"><Trash2 size={14} />Delete</button>
      </div>
    </Card>
  )
}

function PlanEditor({ initial, onCancel, onSaved }) {
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('')

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))
  const payload = toPayload(form)
  // Same validator the endpoint runs, so a rejection here is never a surprise later.
  const invalid = planError(payload)
  const isNew = !form.id

  const submit = async (event) => {
    event.preventDefault()
    setProblem('')
    if (invalid) return setProblem(invalid)
    setSaving(true)
    try {
      const result = await savePlan(payload)
      onSaved(result, isNew)
    } catch (error) {
      setProblem(error.message)
    }
    setSaving(false)
  }

  const priceTyped = String(form.price_pkr ?? '').trim()
  const amountHint = priceTyped === '' ? 'Required — a plan with no price cannot be sold.' : `${money(Number(priceTyped), CURRENCY)} per ${intervalUnit(form)}`
  const yearly = form.interval === 'year' || planDurationDays(form.interval, form.interval_count) === 365 * Number(form.interval_count || 1)

  return (
    <Card as="form" onSubmit={submit} className="mb-6 grid gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[.16em] text-indigo-600">{isNew ? 'NEW PLAN' : 'EDIT PLAN'}</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">{form.name || 'Untitled plan'}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Saving writes this record and creates or refreshes its Safepay plan
            {Number(form.trial_days) > 0 ? 's (one with the trial, one without)' : ''}.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close editor"><X size={18} /></button>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Plan</legend>

        <Field label="Plan name" hint="Unique — this is what an operator sees when choosing a plan.">
          <input required value={form.name} onChange={set('name')} placeholder="Basic" className={inputClass} />
        </Field>

        <Field label="Trial days" hint="Offered once per restaurant. Safepay keeps the trial on the plan, so a second, trial-free plan is created for renewals.">
          <input type="number" min="0" max="365" value={form.trial_days} onChange={set('trial_days')} className={inputClass} />
        </Field>

        <Field label="Billing period" hint={`Billing cycle: ${planDurationDays(form.interval, form.interval_count)} days.`}>
          <select value={form.interval} onChange={set('interval')} className={`${inputClass} bg-white`}>
            {INTERVALS.map((interval) => <option key={interval.value} value={interval.value}>{interval.label}</option>)}
          </select>
        </Field>

        <Field label="Charge every" hint={`${intervalLabel(form.interval, Number(form.interval_count))}. Safepay collects once per period.`}>
          <input type="number" min="1" max="36" value={form.interval_count} onChange={set('interval_count')} className={inputClass} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Price</legend>
        <p className="-mt-1 text-sm text-slate-500">
          What a restaurant pays each billing period, in {CURRENCY}. Every plan is sold in rupees —
          there is no second price to keep in step.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Price per period (${CURRENCY})`} hint={amountHint}>
            <input
              type="number"
              min="0"
              step="any"
              inputMode="decimal"
              value={form.price_pkr}
              onChange={set('price_pkr')}
              placeholder="Required"
              className={inputClass}
            />
          </Field>
        </div>
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
          Safepay will be told: <strong className="font-semibold">{yearly ? 'yearly' : 'monthly'}</strong> recurring
          {yearly ? ` (every ${form.interval_count} year${Number(form.interval_count) === 1 ? '' : 's'})` : ` (every ${form.interval_count} month${Number(form.interval_count) === 1 ? '' : 's'})`}
          {' '}charge, in {CURRENCY}. Changing the amount creates a new Safepay plan and retires the old one — existing subscribers
          keep their current price until it renews.
        </p>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Detail</legend>
        <Field label="Features" hint="One per line. Also written to the Safepay plan description.">
          <textarea value={form.features} onChange={set('features')} rows={4} placeholder={'Unlimited menu items\nQR codes for every table\nDaily sales summary'} className="rounded-lg border border-slate-300 p-3 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" />
        </Field>
        <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={form.is_active} onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))} className="h-4 w-4 accent-indigo-600" />
          Available for new restaurants
          <span className="text-xs font-normal text-slate-500">Deactivating takes it off the list new restaurants can choose from.</span>
        </label>
      </fieldset>

      {problem && <Notice tone="danger">{problem}</Notice>}
      {/* Shown before the click rather than after: the endpoint enforces the same rule. */}
      {!problem && invalid && <Notice tone="warning">{invalid}</Notice>}

      <div className="flex flex-wrap gap-3">
        <button disabled={saving || Boolean(invalid)} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {saving ? 'Saving to Safepay…' : isNew ? 'Create plan' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
      </div>
    </Card>
  )
}
