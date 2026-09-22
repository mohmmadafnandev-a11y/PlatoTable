import { useState } from 'react'
import { AlertTriangle, CheckCircle2, CloudOff, CreditCard, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { CURRENCIES, INTERVALS, PRICE_COLUMNS, featureList, intervalLabel, intervalUnit, planDurationDays, planError } from '../../../shared/plans.js'
import { usePlans } from '../lib/data'
import { deletePlan, savePlan, syncFromStripe } from '../lib/stripe-api'
import { money, relativeTime, shortDate } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

// Plans are the catalog the whole billing side of the platform depends on, so
// this screen is where money is defined. Three rules shape it:
//
//  1. A plan is a Stripe Product with one Price per currency. Nothing here
//     invents a second representation of price — the row and Stripe are kept in
//     step, and the row records whether that actually happened.
//
//  2. Saving is never rolled back because Stripe was unavailable. Stripe's
//     refusal is reported per currency, next to the plan it applies to.
//
//  3. Validation comes from shared/plans.js, the same module the endpoint uses,
//     so a plan the form accepts cannot be rejected by the server for a
//     different reason.

const blankPrice = { USD: '', AED: '', PKR: '', GBP: '', SAR: '' }

const emptyPlan = () => ({
  id: null,
  name: '',
  interval: 'month',
  interval_count: 1,
  trial_days: 7,
  is_active: true,
  features: '',
  ...blankPrice,
})

/** A row becomes a form. Prices are strings so a half-typed number stays valid. */
function toForm(plan) {
  const prices = Object.fromEntries(CURRENCIES.map((currency) => [
    currency,
    plan[PRICE_COLUMNS[currency]] === null || plan[PRICE_COLUMNS[currency]] === undefined ? '' : String(plan[PRICE_COLUMNS[currency]]),
  ]))
  return {
    id: plan.id,
    name: plan.name || '',
    interval: plan.interval || 'month',
    interval_count: plan.interval_count || 1,
    trial_days: plan.trial_days ?? 0,
    is_active: plan.is_active !== false,
    features: featureList(plan.features).join('\n'),
    ...prices,
  }
}

/** The form becomes the payload the endpoint expects. */
function toPayload(form) {
  const payload = {
    id: form.id,
    name: form.name,
    interval: form.interval,
    interval_count: Number(form.interval_count),
    trial_days: Number(form.trial_days),
    is_active: form.is_active,
    features: featureList(form.features),
  }
  for (const currency of CURRENCIES) {
    const raw = String(form[currency] ?? '').trim()
    payload[PRICE_COLUMNS[currency]] = raw === '' ? null : Number(raw)
  }
  return payload
}

export default function Plans() {
  const { plans, loading, error, reload } = usePlans()
  const [editing, setEditing] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [busy, setBusy] = useState('')

  const stripeLinked = plans.filter((plan) => plan.stripe_product_id && !plan.stripe_sync_error).length
  const unsynced = plans.filter((plan) => !plan.stripe_product_id || plan.stripe_sync_error).length

  const sync = async () => {
    setSyncing(true); setFeedback(null)
    try {
      const result = await syncFromStripe('plans')
      const report = result.plans || {}
      const parts = [`Read ${report.checked ?? 0} plan${report.checked === 1 ? '' : 's'} back from Stripe`]
      if (report.linked) parts.push(`${report.linked} linked`)
      if (report.missing?.length) parts.push(`not found in Stripe: ${report.missing.join(', ')}`)
      if (report.repriced?.length) {
        parts.push(report.repriced.map((item) => `${item.plan} ${item.currency} changed ${item.from} → ${item.to} to match Stripe`).join('; '))
      }
      setFeedback({ tone: report.missing?.length || report.repriced?.length ? 'warning' : 'success', text: `${parts.join(' · ')}.` })
      await reload()
    } catch (requestError) {
      setFeedback({ tone: 'danger', text: requestError.message })
    }
    setSyncing(false)
  }

  const remove = async (plan) => {
    if (!window.confirm(`Delete “${plan.name}”? Its Stripe product is closed to new checkouts, but past payments are kept.`)) return
    setBusy(plan.id); setFeedback(null)
    try {
      await deletePlan(plan.id)
      setFeedback({ tone: 'success', text: `${plan.name} deleted. Its Stripe product was deactivated.` })
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
      if (result.stripe?.errors?.length) {
        setFeedback({ tone: 'warning', text: `Saved, but Stripe reported: ${result.stripe.errors.map((item) => `${item.currency} ${item.message}`).join(' · ')}` })
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
      description="Each plan is a Stripe product with one price per currency. A restaurant is billed in its own currency."
      action={<div className="flex flex-wrap gap-2">
        <button onClick={sync} disabled={syncing} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />{syncing ? 'Syncing…' : 'Sync from Stripe'}
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
          <span className="inline-flex items-center gap-2"><CheckCircle2 size={14} className="text-emerald-600" />{stripeLinked} of {plans.length} in Stripe</span>
          {unsynced > 0 && <span className="inline-flex items-center gap-2 text-amber-700"><AlertTriangle size={14} />{unsynced} not fully synced</span>}
          <span className="inline-flex items-center gap-2"><CreditCard size={14} />Test mode</span>
        </div>
      )}
    </div>

    {editing && <PlanEditor
      key={editing.id || 'new'}
      initial={editing}
      onCancel={() => setEditing(null)}
      onSaved={async (result, wasNew) => {
        const failures = result.stripe?.errors || []
        setFeedback(failures.length
          ? { tone: 'warning', text: `${result.plan.name} saved. Stripe could not create every price — ${failures.map((item) => `${item.currency}: ${item.message}`).join(' · ')}` }
          : wasNew
            ? { tone: 'success', text: `${result.plan.name} created in this database and in Stripe test mode.` }
            : { tone: 'success', text: `${result.plan.name} updated. Stripe prices were reconciled.` })
        setEditing(null)
        await reload()
      }}
    />}

    {loading ? <Spinner label="Loading plans" /> : !plans.length ? (
      <Card className="p-0">
        <EmptyState
          icon={CreditCard}
          title="No plans yet"
          description="Create your first plan — it is written to this database and mirrored into Stripe test mode as a product with one price per currency."
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
  const prices = CURRENCIES.map((currency) => ({
    currency,
    amount: plan[PRICE_COLUMNS[currency]] === null || plan[PRICE_COLUMNS[currency]] === undefined ? null : Number(plan[PRICE_COLUMNS[currency]]),
    priceId: plan[`stripe_price_${currency.toLowerCase()}`] || null,
  })).filter((entry) => entry.amount !== null)

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
        {prices.map((entry) => (
          <p key={entry.currency} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="font-semibold text-slate-900">
              {money(entry.amount, entry.currency)}<span className="ml-1 text-xs font-normal text-slate-400">/{intervalUnit(plan)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              {entry.priceId
                ? <><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="text-slate-400">{entry.currency} in Stripe</span></>
                : <><span className="h-1.5 w-1.5 rounded-full bg-amber-500" /><span className="text-amber-700">No {entry.currency} Stripe price</span></>}
            </span>
          </p>
        ))}
      </div>

      {featureList(plan.features).length > 0 && (
        <ul className="mt-5 grid gap-1.5 border-t border-slate-100 pt-4 text-sm text-slate-600">
          {featureList(plan.features).map((feature) => <li key={feature} className="flex gap-2"><span className="text-indigo-500">•</span>{feature}</li>)}
        </ul>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">
        {plan.stripe_sync_error ? (
          <p className="flex gap-2 text-amber-700"><CloudOff size={14} className="mt-0.5 flex-none" /><span>Not fully in Stripe — {plan.stripe_sync_error}</span></p>
        ) : plan.stripe_product_id ? (
          <p className="flex gap-2 text-emerald-700"><CheckCircle2 size={14} className="mt-0.5 flex-none" /><span>In Stripe as <code className="text-[11px]">{plan.stripe_product_id}</code>{plan.stripe_synced_at ? ` · ${relativeTime(plan.stripe_synced_at)}` : ''}</span></p>
        ) : (
          <p className="flex gap-2"><CloudOff size={14} className="mt-0.5 flex-none" /><span>Not in Stripe yet — edit and save to create it.</span></p>
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

  const examplePrice = CURRENCIES.find((currency) => String(form[currency] ?? '').trim() !== '')

  return (
    <Card as="form" onSubmit={submit} className="mb-6 grid gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[.16em] text-indigo-600">{isNew ? 'NEW PLAN' : 'EDIT PLAN'}</p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">{form.name || 'Untitled plan'}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Saving writes this record and creates or updates its Stripe product and prices in test mode.
          </p>
        </div>
        <button type="button" onClick={onCancel} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Close editor"><X size={18} /></button>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Plan</legend>

        <Field label="Plan name" hint="Unique — this is what an operator sees when choosing a plan.">
          <input required value={form.name} onChange={set('name')} placeholder="Basic" className={inputClass} />
        </Field>

        <Field label="Trial days" hint="Offered once per restaurant. Saved on the Stripe subscription when checkout opens.">
          <input type="number" min="0" max="365" value={form.trial_days} onChange={set('trial_days')} className={inputClass} />
        </Field>

        <Field label="Billing period" hint={`Billing cycle: ${planDurationDays(form.interval, form.interval_count)} days.`}>
          <select value={form.interval} onChange={set('interval')} className={`${inputClass} bg-white`}>
            {INTERVALS.map((interval) => <option key={interval.value} value={interval.value}>{interval.label}</option>)}
          </select>
        </Field>

        <Field label="Charge every" hint={`${intervalLabel(form.interval, Number(form.interval_count))}. Stripe collects once per period.`}>
          <input type="number" min="1" max="36" value={form.interval_count} onChange={set('interval_count')} className={inputClass} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Price per currency</legend>
        <p className="-mt-1 text-sm text-slate-500">
          A restaurant is billed in its own currency, so the price that applies is the one matching its account.
          USD, AED and PKR are required; GBP and SAR may be left blank.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {CURRENCIES.map((currency) => {
            const amount = String(form[currency] ?? '').trim()
            return (
              <Field key={currency} label={currency} hint={amount === '' ? 'Not sold in this currency' : `${money(Number(amount), currency)} per ${intervalUnit(form)}`}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={form[currency]}
                  onChange={set(currency)}
                  placeholder={['USD', 'AED', 'PKR'].includes(currency) ? 'Required' : 'Optional'}
                  className={inputClass}
                />
              </Field>
            )
          })}
        </div>
        {examplePrice && (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Stripe will be told: <strong className="font-semibold">{planDurationDays(form.interval, form.interval_count) === 365 * Number(form.interval_count || 1) ? 'yearly' : 'monthly'}</strong> recurring
            {planDurationDays(form.interval, form.interval_count) === 365 * Number(form.interval_count || 1) ? ` (every ${form.interval_count} year${Number(form.interval_count) === 1 ? '' : 's'})` : ` (every ${form.interval_count} month${Number(form.interval_count) === 1 ? '' : 's'})`}
            {' '}prices, one per filled currency. Changing an amount creates a new Stripe price and retires the old one — existing subscribers keep their current price until it renews.
          </p>
        )}
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="mb-3 text-sm font-semibold text-slate-800">Detail</legend>
        <Field label="Features" hint="One per line. Also written to the Stripe product description.">
          <textarea value={form.features} onChange={set('features')} rows={4} placeholder={'Unlimited menu items\nQR codes for every table\nDaily sales summary'} className="rounded-lg border border-slate-300 p-3 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" />
        </Field>
        <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={form.is_active} onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.checked }))} className="h-4 w-4 accent-indigo-600" />
          Available for new restaurants
          <span className="text-xs font-normal text-slate-500">Deactivating also closes the Stripe product to new checkouts.</span>
        </label>
      </fieldset>

      {problem && <Notice tone="danger">{problem}</Notice>}
      {/* Shown before the click rather than after: the endpoint enforces the same rule. */}
      {!problem && invalid && <Notice tone="warning">{invalid}</Notice>}

      <div className="flex flex-wrap gap-3">
        <button disabled={saving || Boolean(invalid)} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60">
          {saving ? 'Saving to Stripe…' : isNew ? 'Create plan' : 'Save changes'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancel</button>
      </div>
    </Card>
  )
}
