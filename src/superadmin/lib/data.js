import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

// Data hooks only — no components — so React Fast Refresh stays intact.
//
// Each hook exposes two entry points on purpose. `load` is what the mount
// effect calls and it never sets state synchronously — doing so in an effect
// body triggers a cascading render, which the react-hooks rules reject. A
// visible loading state is only wanted for an operator-triggered retry, so
// `reload` sets it and is called from event handlers instead.

// The parameters are serialised for the dependency list. Callers pass an inline
// object (the display currency), which would otherwise be a new identity on every
// render and re-issue the request forever.
export function useRpc(name, args) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const params = args === undefined ? '' : JSON.stringify(args)

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.rpc(name, params ? JSON.parse(params) : undefined).then(({ data: result, error: requestError }) => {
      if (requestError) setError(requestError.message || 'This report could not be loaded.')
      else { setData(result); setError('') }
      setLoading(false)
    })
  }, [name, params])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { load() }, [load])
  return { data, loading, error, reload }
}

// Platform revenue is reported in the operator's chosen currency: the database
// converts each payment before adding it, rather than adding and hoping.
export function useDashboard(currency = 'USD') {
  return useRpc('super_admin_dashboard', { p_currency: currency })
}

export function useAnalytics(currency = 'USD') {
  return useRpc('super_admin_analytics', { p_currency: currency })
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

/**
 * The plan catalog. Read from the table rather than Safepay so the screen still
 * renders when Safepay is unreachable — each row carries its own sync state, and
 * a plan saved while Safepay was down is visible instead of missing.
 */
export function usePlans() {
  const [plans, setPlans] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase.from('subscription_plans').select('*').order('interval').order('name').then(({ data, error: requestError }) => {
      if (requestError) setError(requestError.message || 'The plan catalog could not be loaded.')
      else { setPlans(Array.isArray(data) ? data : []); setError('') }
      setLoading(false)
    })
  }, [])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])

  useEffect(() => { load() }, [load])
  return { plans, loading, error, reload, setPlans }
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
 * Rows of one tenant table — menu items, categories, QR codes — for the
 * restaurant detail screen.
 *
 * The write methods are deliberately thin: they touch one row, then reload, so
 * the screen always shows what the database holds rather than what the caller
 * hoped it wrote. Every one of them returns `{ error }` for the caller to show,
 * because a restaurant's menu is a thing people edit carefully and "Saved" next
 * to a failed write is worse than an error.
 */
export function useTenantRows(restaurantId, table, { columns = '*', order = 'display_order', ascending = true } = {}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!supabase || !restaurantId) return Promise.resolve()
    return supabase
      .from(table)
      .select(columns)
      .eq('restaurant_id', restaurantId)
      .order(order, { ascending })
      .then(({ data, error: requestError }) => {
        if (requestError) setError(requestError.message)
        else { setRows(data || []); setError('') }
        setLoading(false)
      })
  }, [restaurantId, table, columns, order, ascending])

  const reload = useCallback(() => { setLoading(true); return load() }, [load])
  useEffect(() => { load() }, [load])

  const insert = useCallback(async (values) => {
    if (!supabase) return { error: new Error('Supabase is not configured.') }
    const { error: requestError } = await supabase.from(table).insert({ ...values, restaurant_id: restaurantId })
    if (!requestError) await load()
    return { error: requestError }
  }, [restaurantId, table, load])

  const update = useCallback(async (id, values) => {
    if (!supabase) return { error: new Error('Supabase is not configured.') }
    const { error: requestError } = await supabase.from(table).update(values).eq('id', id)
    if (!requestError) await load()
    return { error: requestError }
  }, [table, load])

  const remove = useCallback(async (id) => {
    if (!supabase) return { error: new Error('Supabase is not configured.') }
    const { error: requestError } = await supabase.from(table).delete().eq('id', id)
    if (!requestError) await load()
    return { error: requestError }
  }, [table, load])

  return { rows, loading, error, reload, insert, update, remove }
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
