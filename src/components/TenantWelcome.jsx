import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Mail, Phone } from 'lucide-react'
import { supabase } from '../lib/supabase'
import NotFound from './NotFound'
import './Landing.css'

// /<slug> carries no QR token, so there is no table and no session to open. It
// is not a menu: it is the restaurant's public card, so someone who has the
// link can see who they are and how to reach them. Unknown slugs stay a 404.
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

  if (state === 'loading') {
    return (
      <div className="lp-root lp-tenant">
        <div className="lp-tenant-card">
          <div className="lp-tenant-logo lp-qr-skeleton" aria-hidden="true" />
          <h1>Loading</h1>
          <p>Please wait a moment.</p>
        </div>
      </div>
    )
  }
  if (state === 'missing') return <NotFound />
  if (state === 'unavailable') {
    return (
      <div className="lp-root lp-tenant">
        <div className="lp-tenant-card">
          <div className="lp-tenant-initial">P</div>
          <h1>Not available</h1>
          <p>This restaurant page cannot be loaded right now. Please try again shortly.</p>
        </div>
      </div>
    )
  }

  const name = tenant.name || 'Restaurant'
  return (
    <div className="lp-root lp-tenant">
      <div className="lp-tenant-card lp-pop">
        {tenant.logo_url
          ? <img className="lp-tenant-logo" src={tenant.logo_url} alt={`${name} logo`} />
          : <div className="lp-tenant-initial">{(name.trim()[0] || 'R').toUpperCase()}</div>}

        <h1>{name}</h1>
        <p className="lp-tenant-role">Restaurant on Plato Table</p>
        <p>
          {name} uses Plato Table for its digital menu. If you would like to visit, order, or ask
          about anything at all, their contact details are below.
        </p>

        {(tenant.phone || tenant.contact_email) && (
          <div className="lp-tenant-links">
            {tenant.phone && (
              <a className="lp-contact-item" href={`tel:${String(tenant.phone).replace(/[^\d+]/g, '')}`}>
                <span className="lp-contact-icon"><Phone size={19} /></span>
                <span>
                  <small>Phone</small>
                  <strong>{tenant.phone}</strong>
                </span>
              </a>
            )}
            {tenant.contact_email && (
              <a className="lp-contact-item" href={`mailto:${tenant.contact_email}`}>
                <span className="lp-contact-icon"><Mail size={19} /></span>
                <span>
                  <small>Email</small>
                  <strong>{tenant.contact_email}</strong>
                </span>
              </a>
            )}
          </div>
        )}

        {tenant.address && <p className="lp-tenant-role" style={{ color: 'inherit', letterSpacing: 0, textTransform: 'none', fontWeight: 500 }}>{tenant.address}</p>}

        <p className="lp-tenant-scan">
          Sitting at a table? Scan the QR code on your table to open the live menu.
        </p>
        <p className="lp-tenant-foot">
          Powered by <Link to="/">Plato Table</Link> · digital menus for restaurants
        </p>
      </div>
    </div>
  )
}
