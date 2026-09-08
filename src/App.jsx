import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import CustomerApp from './components/CustomerApp'
import AdminApp from './components/AdminApp'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import './App.css'

function ScanError({ reason = 'invalid' }) {
  const content = {
    expired: ['Session expired', 'Your table session has ended. Please scan the QR code on your table again.'],
    inactive: ['QR not available', 'This QR code has been deactivated. Please ask a member of staff for help.'],
    invalid: ['Please scan again', 'This link is not a valid table QR code. Scan the QR code displayed on your table.'],
  }[reason] || ['Please scan again', 'This QR code could not be verified.']
  return <main className="scan-error"><div className="brand-mark">P</div><span>{reason === 'expired' ? '⏱' : '⌁'}</span><h1>{content[0]}</h1><p>{content[1]}</p></main>
}

function ScanRoute() {
  const { token } = useParams()
  const [result, setResult] = useState(() => isSupabaseConfigured && token ? null : { valid: false, reason: 'invalid' })

  useEffect(() => {
    let active = true
    if (!isSupabaseConfigured || !token) return undefined
    const validate = async () => {
      const { data, error } = await supabase.rpc('validate_qr', {
        scan_token: token,
        scan_user_agent: navigator.userAgent,
        scan_device_type: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
      })
      if (active) setResult(error ? { valid: false, reason: 'invalid' } : data?.[0] || { valid: false, reason: 'invalid' })
    }
    validate()
    return () => { active = false }
  }, [token])

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
