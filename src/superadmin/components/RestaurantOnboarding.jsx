import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const initialForm = { name: '', ownerName: '', ownerEmail: '', ownerPassword: '', phone: '', subdomain: '', currency: 'USD', planId: '', trialDays: '7', adminUrl: '', userUrl: '', customDomain: '' }

export default function RestaurantOnboarding({ navigate }) {
  const [form, setForm] = useState(initialForm)
  const [plans, setPlans] = useState([])
  const [mode, setMode] = useState('trial')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))

  useEffect(() => {
    if (!supabase) return
    supabase.from('subscription_plans').select('id, name, trial_days').eq('is_active', true).order('created_at').then(({ data }) => setPlans(data || []))
  }, [])

  const submit = async (event) => {
    event.preventDefault()
    setFeedback('')
    if (!supabase) return setFeedback('Supabase is not configured.')
    setSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) { setSaving(false); return setFeedback('Your session expired. Please sign in again.') }
    const payload = { ...form, planId: form.planId || null, trialDays: mode === 'trial' ? Number(form.trialDays) : 0 }
    try {
      const response = await fetch('/api/restaurants/onboard', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(payload) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Restaurant onboarding failed.')
      navigate(`/restaurants/${body.restaurant.restaurant_id}`)
    } catch (error) { setFeedback(error.message || 'Restaurant onboarding failed.') }
    setSaving(false)
  }

  return <section className="mx-auto max-w-3xl"><button onClick={() => navigate('/restaurants')} className="mb-5 text-sm font-semibold text-indigo-600">← Restaurants</button><div className="mb-7"><p className="text-xs font-semibold tracking-[.16em] text-indigo-600">SECURE ONBOARDING</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Add restaurant</h1><p className="mt-2 text-sm text-slate-500">Create the owner account, restaurant workspace, subscription record, and optional URLs in one step.</p></div><form onSubmit={submit} className="grid gap-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 font-semibold">Restaurant and owner</legend><label className="grid gap-2 text-sm font-medium text-slate-700">Restaurant name<input required value={form.name} onChange={set('name')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Subdomain<input required value={form.subdomain} onChange={set('subdomain')} placeholder="my-restaurant" className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Owner name<input required value={form.ownerName} onChange={set('ownerName')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Owner email<input required type="email" value={form.ownerEmail} onChange={set('ownerEmail')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Temporary password<input required type="password" minLength="12" autoComplete="new-password" value={form.ownerPassword} onChange={set('ownerPassword')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Phone (optional)<input value={form.phone} onChange={set('phone')} className="h-11 rounded-lg border border-slate-300 px-3" /></label></fieldset><fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 font-semibold">Subscription</legend><label className="grid gap-2 text-sm font-medium text-slate-700">Currency<select value={form.currency} onChange={set('currency')} className="h-11 rounded-lg border border-slate-300 bg-white px-3"><option>USD</option><option>AED</option><option>PKR</option></select></label><label className="grid gap-2 text-sm font-medium text-slate-700">Plan<select value={form.planId} onChange={set('planId')} className="h-11 rounded-lg border border-slate-300 bg-white px-3"><option value="">No plan selected</option>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label><div className="sm:col-span-2"><p className="mb-2 text-sm font-medium text-slate-700">Starting access</p><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setMode('trial')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${mode === 'trial' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>Start free trial</button><button type="button" onClick={() => setMode('payment')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${mode === 'payment' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>Payment pending</button></div>{mode === 'trial' ? <label className="mt-3 grid max-w-xs gap-2 text-sm font-medium text-slate-700">Free trial days<input required type="number" min="1" max="365" value={form.trialDays} onChange={set('trialDays')} className="h-11 rounded-lg border border-slate-300 px-3" /></label> : <p className="mt-3 text-sm text-amber-700">This account will remain suspended until you attach a paid Stripe subscription from its restaurant page. A free trial is permanently unavailable after this choice.</p>}</div></fieldset><fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 font-semibold">URLs (optional)</legend><label className="grid gap-2 text-sm font-medium text-slate-700">Admin URL<input type="url" value={form.adminUrl} onChange={set('adminUrl')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Customer URL<input type="url" value={form.userUrl} onChange={set('userUrl')} className="h-11 rounded-lg border border-slate-300 px-3" /></label><label className="grid gap-2 text-sm font-medium text-slate-700 sm:col-span-2">Custom domain<input value={form.customDomain} onChange={set('customDomain')} placeholder="menu.example.com" className="h-11 rounded-lg border border-slate-300 px-3" /></label></fieldset>{feedback && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{feedback}</p>}<button disabled={saving} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{saving ? 'Creating workspace…' : 'Create restaurant'}</button></form></section>
}
