import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function StripeSubscriptionLink({ restaurantId, plans = [], onLinked }) {
  const [subscriptionId, setSubscriptionId] = useState('')
  const [planId, setPlanId] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const link = async (event) => {
    event.preventDefault()
    setMessage('')
    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    try {
      const response = await fetch('/api/stripe/attach', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` }, body: JSON.stringify({ restaurantId, subscriptionId: subscriptionId.trim(), planId: planId || null }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Could not link this subscription.')
      setMessage(`Stripe subscription linked as ${body.status}.`)
      setSubscriptionId('')
      onLinked?.()
    } catch (error) { setMessage(error.message || 'Could not link this subscription.') }
    setSaving(false)
  }

  return <form onSubmit={link} className="mt-5 border-t border-slate-100 pt-5"><h3 className="text-sm font-semibold text-slate-800">Link an existing Stripe subscription</h3><p className="mt-1 text-xs leading-5 text-slate-500">Use the Stripe subscription ID beginning with <code>sub_</code>. This securely imports its real status, dates, amount, customer, and card invoice history going forward.</p><label className="mt-3 grid gap-1 text-xs font-medium text-slate-600">Stripe subscription ID<input required pattern="sub_[A-Za-z0-9]+" value={subscriptionId} onChange={(event) => setSubscriptionId(event.target.value)} placeholder="sub_..." className="h-10 rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="mt-3 grid gap-1 text-xs font-medium text-slate-600">Match to a plan (optional)<select value={planId} onChange={(event) => setPlanId(event.target.value)} className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm"><option value="">Keep as custom plan</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><button disabled={saving} className="mt-3 w-full rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5 text-sm font-semibold text-indigo-700 disabled:opacity-60">{saving ? 'Linking securely…' : 'Link Stripe subscription'}</button>{message && <p role="status" className="mt-3 text-xs text-slate-600">{message}</p>}</form>
}
