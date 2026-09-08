import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import CustomerApp from './components/CustomerApp'
import AdminApp from './components/AdminApp'
import { supabase } from './lib/supabase'
import './App.css'

function ScanError({ reason }) {
  const expired = reason === 'expired'
  const inactive = reason === 'inactive'
  const title = expired ? 'Your session has expired' : inactive ? 'This QR code is inactive' : 'This QR code is not recognised'
  const message = expired ? 'For your security, table sessions end after 15 minutes.' : inactive ? 'Please ask a member of staff for a current table QR code.' : 'Please scan the QR code displayed on your table and try again.'
  return <main className="scan-error"><div className="brand-mark">S</div><span>{expired ? '⏱' : inactive ? '⊘' : '⌁'}</span><h1>{title}</h1><p>{message}</p><a href="/">Return to menu →</a></main>
}

function ScanRoute() {
  const { token } = useParams()
  const [validation, setValidation] = useState(supabase ? 'loading' : 'demo')

  useEffect(() => {
    if (!supabase || token === 'invalid' || token === 'expired') return
    const validate = async () => {
      const { data, error } = await supabase.rpc('validate_qr', {
        scan_token: token,
        scan_user_agent: navigator.userAgent,
        scan_device_type: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      })
      if (error) {
        // Keep the designed demo usable until the supplied migration is applied.
        setValidation('demo')
        return
      }
      setValidation(data?.[0]?.valid ? 'active' : data?.[0]?.reason || 'invalid')
    }
    validate()
  }, [token])

  if (token === 'invalid' || token === 'expired') return <ScanError reason={token} />
  if (validation === 'loading') return <main className="scan-error"><div className="brand-mark">S</div><span className="scan-spinner" /><h1>Preparing your table</h1><p>We’re opening today’s menu for you.</p></main>
  if (!['active', 'demo'].includes(validation)) return <ScanError reason={validation} />
  return <CustomerApp />
}

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<CustomerApp />} />
    <Route path="/scan/:token" element={<ScanRoute />} />
    <Route path="/admin/login" element={<AdminApp login />} />
    <Route path="/admin/*" element={<AdminApp />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></BrowserRouter>
}
