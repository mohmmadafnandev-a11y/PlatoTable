import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// A password reset link, and whether it is still usable.
//
// Supabase sends the recovery link as a URL fragment (`#access_token=...&
// type=recovery`) which the client consumes on load and answers with a
// PASSWORD_RECOVERY event. Two things follow from that, and both were missing:
//
//   * the screen that receives the link has to KNOW it received one. Without
//     that, the operator lands on the ordinary sign-in form, the form tells them
//     their password is wrong, and there is nothing anywhere that says "set a new
//     password" — which is exactly the state this codebase was in.
//   * the link expires, and the fragment carries the reason when it has. An
//     expired link must say so rather than looking like a normal visit.

const fragmentParams = () => new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''))
const queryParams = () => new URLSearchParams(window.location.search || '')

/**
 * True when this page load is the landing end of a reset link.
 *
 * Three forms, all of them a reset and none of them an ordinary visit:
 *
 *   * `token_hash` + `type=recovery` — the link the platform panel hands over.
 *     It carries the token itself rather than asking Supabase to redirect, so
 *     it works on any host, allow-listed or not.
 *   * `code` — the PKCE form of a mail-based link.
 *   * a `#type=recovery` fragment with tokens — the implicit form Supabase's
 *     own mail sends.
 */
export function isRecoveryLink() {
  if (typeof window === 'undefined') return false
  const query = queryParams()
  if (query.has('token_hash')) return true
  if (query.get('type') === 'recovery' && query.has('code')) return true
  const fragment = fragmentParams()
  if (fragment.get('type') === 'recovery') return true
  if (fragment.get('access_token') && fragment.get('refresh_token')) return true
  return query.has('code')
}

/** Why the link failed, when Supabase says so in the fragment. */
export function recoveryLinkError() {
  if (typeof window === 'undefined') return ''
  const fragment = fragmentParams()
  const code = fragment.get('error_code') || new URLSearchParams(window.location.search || '').get('error_code')
  if (!code) return ''
  if (code === 'otp_expired') return 'This reset link has expired. Ask for a new one.'
  return fragment.get('error_description')?.replace(/\+/g, ' ') || 'This reset link is no longer valid.'
}

/**
 * Exchange the hand-over token, once per page load.
 *
 * A recovery token is single-use, and React mounts effects twice in
 * development. Without this, the second mount spends the token again, Supabase
 * answers 403, and a perfectly good link is reported as expired — the failure
 * looks exactly like a broken reset. Remembering the exchange (and never the
 * promise, because a promise is not something to hand out twice) makes the
 * second mount await the first one's answer.
 */
let handoverToken = ''
let handoverResult = null

function exchangeHandover(tokenHash, type) {
  if (!supabase) return Promise.resolve({ error: { message: 'Supabase is not configured for this deployment.' } })
  if (handoverToken !== tokenHash || !handoverResult) {
    handoverToken = tokenHash
    handoverResult = supabase.auth.verifyOtp({ type, token_hash: tokenHash })
  }
  return handoverResult
}

/**
 * `checking` while the client is still establishing the session from the link,
 * then `ready` when a new password can be set. `expired` covers both a link that
 * carried an error and one where no session ever appeared.
 */
export function useRecoverySession() {
  const [state, setState] = useState(() => {
    if (typeof window === 'undefined') return 'idle'
    if (recoveryLinkError()) return 'expired'
    return isRecoveryLink() ? 'checking' : 'idle'
  })

  useEffect(() => {
    if (state === 'expired' || state === 'idle' || !supabase) return undefined
    let active = true

    // A hand-over link carries the token in the query string, and exchanging it
    // is what creates the session — there is no redirect and no event to wait
    // for. A failure is the whole answer: the token was spent or tampered with.
    const tokenHash = queryParams().get('token_hash')
    if (tokenHash) {
      exchangeHandover(tokenHash, queryParams().get('type') || 'recovery').then(({ error }) => {
        if (!active) return
        if (!error) return setState('ready')
        // A link that failed but left a session behind is a refresh of a screen
        // that already worked, not an expired link.
        supabase.auth.getSession().then(({ data }) => { if (active) setState(data.session ? 'ready' : 'expired') })
      })
      return () => { active = false }
    }

    // The event can fire before this effect mounts, so the stored session is
    // checked as well. Whichever answers first wins.
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') setState('ready')
    })

    supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) setState('ready')
    })

    // A link that produced no session is spent or was tampered with. Saying so
    // after a short wait beats an enabled button that fails on submit.
    const timer = window.setTimeout(() => setState((current) => (current === 'checking' ? 'expired' : current)), 4000)

    return () => { active = false; window.clearTimeout(timer); listener.subscription.unsubscribe() }
  }, [state])

  return state
}

/**
 * Asks for a reset email.
 *
 * `redirectTo` has to be a URL this Supabase project allows; the login page of
 * the surface the person is recovering is the only sensible destination, because
 * that is where the "set a new password" screen lives.
 */
export async function sendPasswordReset(email, redirectTo) {
  if (!supabase) return { error: 'Supabase is not configured for this deployment.' }
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
  return { error: error ? error.message : '' }
}
