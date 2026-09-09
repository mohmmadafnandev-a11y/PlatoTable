import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import CustomerApp from './components/CustomerApp'
import AdminApp from './components/AdminApp'
import { supabase } from './lib/supabase'
import { restaurantName } from './lib/restaurant-config'
import './App.css'

function ScanError({ reason = 'invalid' }) {
  const content = {
    expired: ['Session expired', 'Your 15-minute table session has ended. Please scan the QR code on your table again.'],
    inactive: ['QR not available', 'This QR code has been deactivated. Please ask a member of staff for help.'],
    invalid: ['Please scan again', 'This link is not a valid table QR code. Scan the QR code displayed on your table.'],
  }[reason] || ['Please scan again', 'This QR code could not be verified.']
  return <main className="scan-error"><div className="brand-mark">P</div><span>{reason === 'expired' ? '⏱' : '⌁'}</span><h1>{content[0]}</h1><p>{content[1]}</p></main>
}

const localSessionKey = (token) => `palatotabale-session:${token}`
const readLocalSession = (token, sessionToken) => {
  try {
    const session = JSON.parse(sessionStorage.getItem(localSessionKey(token)) || 'null')
    return session?.session_token === sessionToken ? session : null
  } catch { return null }
}

function MobileOnly() {
  return <main className="mobile-only"><div className="brand-mark">P</div><span>▣</span><h1>Open this menu on your phone</h1><p>Please scan the QR code with a mobile device to view the table menu.</p></main>
}

function ScanRoute() {
  const { token } = useParams(); const [params, setParams] = useSearchParams(); const sessionToken = params.get('session'); const [result, setResult] = useState(null); const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => { const media = window.matchMedia('(max-width: 768px)'); const update = () => setIsMobile(media.matches); media.addEventListener('change', update); return () => media.removeEventListener('change', update) }, [])
  useEffect(() => {
    let active = true
    const finish = (value) => { if (active) setResult(value) }
    const getMenuData = async () => {
      const { data, error } = await supabase.rpc('get_scan_menu', { scan_token: token })
      return !error && data?.valid ? data : null
    }
    const openLocalSession = async () => {
      const menuData = await getMenuData()
      if (!active) return
      if (!menuData) { finish({ valid: false, reason: 'invalid' }); return }
      if (sessionToken) {
        const saved = readLocalSession(token, sessionToken)
        if (!saved) { finish({ valid: false, reason: 'invalid' }); return }
        if (new Date(saved.expires_at).getTime() <= Date.now()) { sessionStorage.removeItem(localSessionKey(token)); finish({ valid: false, reason: 'expired' }); return }
        finish({ valid: true, ...saved, session_token: sessionToken }); return
      }
      const session = { session_token: crypto.randomUUID(), table_number: menuData.table_number || 'Table session', restaurant_name: menuData.restaurant_name || restaurantName, currency: menuData.currency || 'PKR', contact_phone: menuData.contact_phone || null, contact_email: menuData.contact_email || null, expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }
      sessionStorage.setItem(localSessionKey(token), JSON.stringify(session))
      finish({ valid: true, ...session })
      setParams({ session: session.session_token }, { replace: true })
    }
    const openSession = async () => {
      if (!isMobile || !token) { if (!isMobile) return; finish({ valid: false, reason: 'invalid' }); return }
      // Customer access lasts 15 minutes in this browser tab only. It survives
      // refreshes but does not create a Supabase customer-session record.
      openLocalSession()
    }
    openSession(); return () => { active = false }
  }, [token, sessionToken, setParams, isMobile])
  if (!isMobile) return <MobileOnly />
  if (!result) return <main className="scan-error"><div className="brand-mark">P</div><span className="scan-spinner" /><h1>Opening your table menu</h1><p>Please wait a moment.</p></main>
  if (!result.valid) return <ScanError reason={result.reason} />
  return <CustomerApp session={result} />
}

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Navigate to="/scan" replace />} />
    <Route path="/scan" element={<ScanError />} />
    <Route path="/scan/:token/*" element={<ScanRoute />} />
    <Route path="/admin/login" element={<AdminApp login />} />
    <Route path="/admin/*" element={<AdminApp />} />
    <Route path="*" element={<Navigate to="/scan" replace />} />
  </Routes></BrowserRouter>
}
