import { useState } from 'react'
import { Copy, ExternalLink, Link2, Plus, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logActivity, useRestaurants } from '../lib/data'
import { shortDate } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, inputClass } from './ui'

// The platform serves restaurants by path, so these are the canonical links.
// A custom domain is recorded for the day a restaurant points its own domain
// at the platform; nothing in the app depends on it being set.
function defaultUrls(slug) {
  const base = import.meta.env.VITE_CANONICAL_BASE_URL || window.location.origin
  return {
    admin_url: slug ? `${base}/admin/${slug}` : '',
    user_url: slug ? `${base}/${slug}` : '',
  }
}

function UrlForm({ restaurant, onSaved, onCancel, superAdminId }) {
  const [form, setForm] = useState(() => ({
    admin_url: restaurant.urls?.[0]?.admin_url || defaultUrls(restaurant.subdomain).admin_url,
    user_url: restaurant.urls?.[0]?.user_url || defaultUrls(restaurant.subdomain).user_url,
    custom_domain: restaurant.urls?.[0]?.custom_domain || '',
    is_primary: restaurant.urls?.[0]?.is_primary ?? true,
  }))
  const [state, setState] = useState({ saving: false, message: '', tone: 'info' })
  const update = (patch) => setForm((current) => ({ ...current, ...patch }))

  const submit = async (event) => {
    event.preventDefault()
    setState({ saving: true, message: '', tone: 'info' })
    const payload = {
      restaurant_id: restaurant.id,
      admin_url: form.admin_url.trim() || null,
      user_url: form.user_url.trim() || null,
      custom_domain: form.custom_domain.trim() || null,
      is_primary: !!form.is_primary,
    }
    const existingId = restaurant.urls?.[0]?.id
    const request = existingId
      ? supabase.from('restaurant_urls').update(payload).eq('id', existingId)
      : supabase.from('restaurant_urls').insert(payload)
    const { error } = await request
    if (error) return setState({ saving: false, message: error.message, tone: 'danger' })
    await logActivity({
      superAdminId,
      restaurantId: restaurant.id,
      action: existingId ? 'restaurant_urls_updated' : 'restaurant_urls_created',
      details: { admin_url: payload.admin_url, user_url: payload.user_url },
    })
    setState({ saving: false, message: 'Links saved.', tone: 'success' })
    onSaved()
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
      <Field label="Admin URL">
        <input className={inputClass} value={form.admin_url} onChange={(event) => update({ admin_url: event.target.value })} />
      </Field>
      <Field label="Public page URL">
        <input className={inputClass} value={form.user_url} onChange={(event) => update({ user_url: event.target.value })} />
      </Field>
      <Field label="Custom domain" hint="Optional. Recorded for future domain support.">
        <input className={inputClass} value={form.custom_domain} onChange={(event) => update({ custom_domain: event.target.value })} placeholder="restaurant.example.pk" />
      </Field>
      <label className="flex items-end gap-3 pb-3 text-sm text-slate-600">
        <input type="checkbox" className="h-4 w-4 accent-indigo-600" checked={form.is_primary} onChange={(event) => update({ is_primary: event.target.checked })} />
        Primary link for this restaurant
      </label>
      {state.message && <div className="sm:col-span-2"><Notice tone={state.tone}>{state.message}</Notice></div>}
      <div className="flex gap-3 sm:col-span-2">
        <button disabled={state.saving} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
          {state.saving ? 'Saving…' : 'Save links'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
      </div>
    </form>
  )
}

export default function CustomUrls({ profile }) {
  const { restaurants, loading, error, reload } = useRestaurants()
  const [editing, setEditing] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [copied, setCopied] = useState('')

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(value)
      window.setTimeout(() => setCopied(''), 1600)
    } catch {
      setFeedback({ tone: 'warning', text: 'The browser blocked clipboard access. Copy the link manually.' })
    }
  }

  const remove = async (restaurant) => {
    const row = restaurant.urls?.[0]
    if (!row) return
    if (!window.confirm(`Remove the saved links for ${restaurant.name}?`)) return
    const { error: failure } = await supabase.from('restaurant_urls').delete().eq('id', row.id)
    if (failure) return setFeedback({ tone: 'danger', text: failure.message })
    await logActivity({ superAdminId: profile?.id, restaurantId: restaurant.id, action: 'restaurant_urls_removed' })
    setFeedback({ tone: 'success', text: `Saved links removed for ${restaurant.name}.` })
    setEditing(null)
    reload()
  }

  return (
    <>
      <SectionHead
        eyebrow="LINK MANAGEMENT"
        title="Custom URLs"
        description="The exact admin and public links for each restaurant, plus an optional custom domain."
      />

      {feedback && <div className="mb-4"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}
      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}

      {loading && !restaurants.length
        ? <Spinner label="Loading restaurants" />
        : restaurants.length
          ? (
            <div className="grid gap-4">
              {restaurants.map((restaurant) => {
                const urls = restaurant.urls?.[0]
                const fallback = defaultUrls(restaurant.subdomain)
                const adminUrl = urls?.admin_url || fallback.admin_url
                const publicUrl = urls?.user_url || fallback.user_url
                return (
                  <Card key={restaurant.id} className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="font-semibold text-slate-900">{restaurant.name}</h2>
                        <p className="mt-1 text-xs text-slate-500">
                          /{restaurant.subdomain}
                          {urls ? ` · saved ${shortDate(restaurant.created_at)}` : ' · using default links'}
                          {urls && !urls.is_primary ? ' · not primary' : ''}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setEditing(editing === restaurant.id ? null : restaurant.id)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50">
                          {editing === restaurant.id ? 'Close' : urls ? 'Edit links' : 'Add links'}
                        </button>
                        {urls && (
                          <button onClick={() => remove(restaurant)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-50">
                            <Trash2 size={14} />Remove
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {[['Admin', adminUrl], ['Public page', publicUrl]].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                          <p className="mt-1.5 truncate text-sm text-slate-700">{value || 'Not set'}</p>
                          <div className="mt-2 flex gap-2">
                            <button onClick={() => copy(value)} disabled={!value} className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">
                              <Copy size={13} />{copied === value ? 'Copied' : 'Copy'}
                            </button>
                            {value && (
                              <a href={value} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                                <ExternalLink size={13} />Open
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {urls?.custom_domain && (
                      <p className="mt-3 text-sm text-slate-600">Custom domain: <strong className="font-semibold">{urls.custom_domain}</strong></p>
                    )}

                    {editing === restaurant.id && (
                      <UrlForm
                        restaurant={restaurant}
                        superAdminId={profile?.id}
                        onCancel={() => setEditing(null)}
                        onSaved={() => { setEditing(null); setFeedback({ tone: 'success', text: `Links saved for ${restaurant.name}.` }); reload() }}
                      />
                    )}
                  </Card>
                )
              })}
            </div>
          )
          : <Card><EmptyState icon={Link2} title="No restaurants yet" description="Links are managed per restaurant." action={<span className="inline-flex items-center gap-2 text-sm text-slate-500"><Plus size={15} />Add a restaurant first</span>} /></Card>}
    </>
  )
}
