import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { logActivity } from '../lib/data'
import { Card, Notice, inputClass } from './ui'

// Backup days, editable wherever an operator looks at a restaurant.
//
// The per-restaurant window that replaces the old platform-wide grace: when the
// trial or the paid period ends unpaid, the menu stays online for this many days
// before the billing sweep suspends the restaurant (0 = the platform grace
// applies, exactly as before). Kept as its own component so the restaurant page
// and the subscription page cannot drift apart.
export default function BackupDaysEditor({ restaurantId, restaurantName, profile, onSaved }) {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)

  useEffect(() => {
    if (!supabase || !restaurantId) return undefined
    let active = true
    supabase
      .from('subscriptions')
      .select('id, backup_days')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        if (error) setFeedback({ tone: 'danger', text: error.message })
        else setValue(String(data?.backup_days ?? 0))
        setLoaded(true)
      })
    return () => { active = false }
  }, [restaurantId])

  const save = async () => {
    const days = Number(String(value).trim() === '' ? 0 : value)
    if (!Number.isInteger(days) || days < 0 || days > 365) {
      return setFeedback({ tone: 'warning', text: 'Backup days must be a whole number between 0 and 365.' })
    }
    setSaving(true); setFeedback(null)
    const { error } = await supabase
      .from('subscriptions')
      .update({ backup_days: days, updated_at: new Date().toISOString() })
      .eq('restaurant_id', restaurantId)
    if (error) {
      setFeedback({
        tone: 'danger',
        text: /backup_days/.test(error.message || '')
          ? 'The backup_days column does not exist yet — run migration 024 in the Supabase SQL editor first.'
          : error.message,
      })
    } else {
      await logActivity({
        superAdminId: profile?.id,
        restaurantId,
        action: 'subscription_backup_days_set',
        details: { days, restaurant: restaurantName || null },
      })
      setFeedback({
        tone: 'success',
        text: days > 0
          ? `Backup days set to ${days}. They start when the trial or the paid period ends unpaid.`
          : 'Backup days cleared — the platform-wide grace period applies from now on.',
      })
      onSaved?.()
    }
    setSaving(false)
  }

  return (
    <Card className="p-6">
      <h2 className="font-semibold text-slate-900">Backup days</h2>
      <p className="mt-1 text-sm text-slate-500">
        Free days after the trial or the paid period ends, before the menu goes offline.
        This is the yellow phase on the billing bar. 0 keeps the platform-wide grace.
      </p>
      {feedback && <div className="mt-4"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="grid gap-2 text-sm font-medium text-slate-700">
          Days
          <input
            type="number"
            min="0"
            max="365"
            disabled={!loaded || saving}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className={`${inputClass} w-32`}
          />
        </label>
        <button
          onClick={save}
          disabled={!loaded || saving}
          className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save backup days'}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Adding or deducting days from the subscription page adjusts whichever phase is running —
        trial, paid period, or this backup window.
      </p>
    </Card>
  )
}
