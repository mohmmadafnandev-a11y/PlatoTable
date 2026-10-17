import { useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import BrandMark from './BrandMark'
import { supabase } from '../lib/supabase'
import { useRecoverySession } from '../lib/password-recovery'
import { PASSWORD_MIN, passwordError } from '../../shared/slug.js'
import { APP_NAME } from '../../shared/brand.js'

// Setting a new password after a reset link.
//
// One screen for both surfaces: a platform operator and a restaurant owner get
// the same link, the same rule about what a password has to be, and the same
// ending. It wears the landing page's palette — cream page, white card, brick
// accent — which is the light theme the panel and the tenant admin already share
// once the person is signed in.
//
// The session this screen uses exists only because the link was followed. It is
// signed out on success: a recovery link that left somebody signed in would be a
// way into an account whose password the recipient may not have chosen.

export default function ResetPassword({ loginPath = '/', surface = 'platform' }) {
  const state = useRecoverySession()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const field = 'sa-login-field h-12 w-full rounded-lg px-3 text-sm transition'

  const submit = async (event) => {
    event.preventDefault()
    const problem = passwordError(password)
    if (problem) return setError(problem)
    if (password !== confirm) return setError('The two passwords do not match.')
    if (!supabase) return setError('Supabase is not configured for this deployment.')

    setSaving(true)
    setError('')
    const { error: failure } = await supabase.auth.updateUser({ password })
    if (failure) {
      setSaving(false)
      return setError(/expired|invalid|session/i.test(failure.message)
        ? 'This reset link has expired or has already been used. Ask for a new one.'
        : failure.message)
    }

    // Nothing about this session should outlive the password change.
    await supabase.auth.signOut()
    setSaving(false)
    setDone(true)
  }

  const expired = state === 'expired'
  const checking = state === 'checking'

  return (
    <main className="sa-login-page grid min-h-screen place-items-center p-5">
      <section className="sa-login-card w-full max-w-md overflow-hidden rounded-[28px] bg-white p-7 shadow-2xl shadow-[#1b1a18]/10 sm:p-9">
        <div className="flex items-center gap-3">
          <BrandMark size={38} />
          <span className="sa-login-display text-lg">{APP_NAME}</span>
        </div>

        {done ? (
          <>
            <span className="sa-login-kicker mt-8 block text-xs font-semibold">PASSWORD UPDATED</span>
            <h1 className="sa-login-display mt-2 text-3xl">You can sign in now</h1>
            <p className="mt-2 text-sm text-[#57514a]">
              Your new password is in place and this reset link has been used up. Sign in with the new password to continue.
            </p>
            <a href={loginPath} className="sa-login-submit mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition">
              <ShieldCheck size={17} />Go to sign in
            </a>
          </>
        ) : (
          <>
            <span className="sa-login-kicker mt-8 block text-xs font-semibold">ACCOUNT RECOVERY</span>
            <h1 className="sa-login-display mt-2 text-3xl">Set a new password</h1>
            <p className="mt-2 text-sm text-[#57514a]">
              {surface === 'platform'
                ? 'Choose a new password for your Super Admin account.'
                : 'Choose a new password for your restaurant workspace.'}
            </p>

            {expired && (
              <div className="mt-6 rounded-xl border border-[#f2d3c9] bg-[#fdf1ea] px-4 py-3 text-sm text-[#9e382a]" role="alert">
                This reset link has expired or has already been used. Open the sign-in page and ask for a new one — reset links are single-use.
              </div>
            )}

            {error && (
              <div className="mt-6 rounded-xl border border-[#f2d3c9] bg-[#fdf1ea] px-4 py-3 text-sm text-[#9e382a]" role="alert">{error}</div>
            )}

            <form onSubmit={submit} className="mt-6">
              <label className="mb-4 grid gap-2 text-sm font-medium text-[#57514a]">
                New password
                <div className="relative">
                  <input
                    required
                    autoFocus
                    type={show ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={`At least ${PASSWORD_MIN} characters`}
                    className={`${field} pr-16`}
                  />
                  <button type="button" onClick={() => setShow(!show)} className="sa-login-link absolute inset-y-0 right-2 px-2 text-xs font-semibold">
                    {show ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              <label className="mb-6 grid gap-2 text-sm font-medium text-[#57514a]">
                Repeat it
                <input
                  required
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="Type it again"
                  className={field}
                />
                {confirm && confirm !== password && <small className="font-normal text-[#9e382a]">The two passwords do not match yet.</small>}
              </label>

              <button
                disabled={saving || checking || expired}
                className="sa-login-submit flex h-12 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition active:scale-[.99] disabled:opacity-60"
              >
                {saving && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                <KeyRound size={16} />
                {checking ? 'Checking the link…' : saving ? 'Saving…' : 'Save the new password'}
              </button>
            </form>

            <a href={loginPath} className="sa-login-link mt-5 block text-center text-xs font-semibold">Back to sign in</a>
          </>
        )}
      </section>
    </main>
  )
}
