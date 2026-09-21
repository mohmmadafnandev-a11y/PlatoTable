import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import NotFound from './NotFound'

// Visiting /<slug> carries no QR token, so there is no table and no session to
// open. Show branded confirmation and ask the guest to scan their table code.
export default function TenantWelcome() {
  const { slug } = useParams()
  const [tenant, setTenant] = useState(null)
  // Derived up front rather than set from inside the effect, which would cause
  // a cascading render on mount.
  const [state, setState] = useState(() => (!supabase || !slug ? 'missing' : 'loading'))

  useEffect(() => {
    let active = true
    if (!supabase || !slug) return undefined
    supabase.rpc('public_tenant_by_slug', { p_slug: slug }).then(({ data, error }) => {
      if (!active) return
      const record = Array.isArray(data) ? data[0] : data
      if (error) { setState(error.code === 'PGRST202' ? 'unavailable' : 'missing'); return }
      if (!record) { setState('missing'); return }
      setTenant(record)
      setState('ready')
    })
    return () => { active = false }
  }, [slug])

  if (state === 'loading') return <main className="scan-error"><div className="brand-mark">P</div><span className="scan-spinner" /><h1>Loading menu</h1><p>Please wait a moment.</p></main>
  if (state === 'missing') return <NotFound />
  if (state === 'unavailable') return <main className="scan-error"><div className="brand-mark">P</div><span>⌁</span><h1>Menu unavailable</h1><p>This restaurant menu cannot be loaded right now. Please ask a member of staff for help.</p></main>

  return <main className="scan-error">
    <div className="brand-mark">P</div>
    <span>▣</span>
    <h1>{tenant.name}</h1>
    <p>Scan the QR code on your table to see our menu.</p>
  </main>
}
