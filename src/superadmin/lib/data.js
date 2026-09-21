import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

// Data hooks only — no components — so React Fast Refresh stays intact.
//
// Each hook exposes two entry points on purpose. `load` is what the mount
// effect calls and it never sets state synchronously — doing so in an effect
// body triggers a cascading render, which the react-hooks rules reject. A
// visible loading state is only wanted for an operator-triggered retry, so
// `reload` sets it and is called from event handlers instead.

export function useRpc(name) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.rpc(name).then(({ data: result, error: requestError }) => {
      if (requestError) setError(requestError.message || 'This report could not be loaded.')
      else { setData(result); setError('') }
      setLoading(false)
    })
  }, [name])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload }
}

export function useDashboard() {
  return useRpc('super_admin_dashboard')
}

export function useRestaurants() {
  const [restaurants, setRestaurants] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.rpc('super_admin_restaurants').then(({ data, error: requestError }) => {
      if (requestError) setError(requestError.message || 'The restaurant directory could not be loaded.')
      else { setRestaurants(Array.isArray(data) ? data : []); setError('') }
      setLoading(false)
    })
  }, [])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { load() }, [load])
  return { restaurants, loading, error, reload }
}

export function usePlatformSettings() {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.from('platform_settings').select('*').maybeSingle().then(({ data, error: requestError }) => {
      if (requestError) setError(requestError.message)
      else { setSettings(data); setError('') }
      setLoading(false)
    })
  }, [])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { load() }, [load])

  // Single-row table: the primary key is the boolean `id`, which is always
  // true. Matching on it prevents an accidental insert of a second row.
  const save = useCallback(async (patch) => {
    if (!supabase) return { error: new Error('Supabase is not configured.') }
    const { data, error: requestError } = await supabase
      .from('platform_settings')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', true)
      .select()
      .maybeSingle()
    if (requestError) return { error: requestError }
    setSettings(data)
    return { data }
  }, [])

  return { settings, loading, error, reload, save }
}

/**
 * Append an entry to the platform audit trail. Never throws: a failed audit
 * write must not fail the action the operator actually asked for.
 */
export async function logActivity({ superAdminId, restaurantId = null, action, details = {} }) {
  if (!supabase) return
  await supabase.from('activity_logs').insert({
    super_admin_id: superAdminId || null,
    restaurant_id: restaurantId,
    action,
    details,
  })
}
