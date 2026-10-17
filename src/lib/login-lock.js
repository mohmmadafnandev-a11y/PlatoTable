import { useEffect, useState } from 'react'

// The device lock in front of both sign-in screens.
//
// What this is and is not: it stops somebody sitting at a keyboard guessing
// passwords, which is the attack a browser can actually see. It cannot stop a
// script that talks to the auth API directly — nothing running in the page can —
// and that is what Supabase's own auth rate limits and CAPTCHA are for. Both
// halves matter, so the copy on screen says "this device", not "your account":
// an honest lock is one whose scope is true.
//
// Ten attempts, then an hour. Kept in localStorage per surface so the platform
// panel and each restaurant's workspace lock independently.
//
// Two traps live in this file's history, and the tests of it are the sentences
// below:
//
//   * the ticker used to remove the stored entry whenever there was no *lock* —
//     which is every second while attempts are still being counted — so the
//     counter restarted from zero forever and a hundred wrong passwords still
//     read "2 attempts remaining". Only an expired lock is tidied now.
//   * a lock that had run its course used to leave its `attempts: 3` behind, so
//     the first try after the hour counted as attempt four and locked again
//     instantly — one lockout became permanent. An expired lock resets the count.

const MAX_ATTEMPTS = 10
const LOCK_MS = 60 * 60 * 1000

export const MAX_LOGIN_ATTEMPTS = MAX_ATTEMPTS

export const loginLockKey = (surface) => `platotable-login-lock:${surface}`

/** The stored entry as it is — `{ attempts }` while counting, `{ attempts, lockedUntil }` once locked. */
export function readLoginState(surface) {
  try {
    return JSON.parse(localStorage.getItem(loginLockKey(surface)) || 'null')
  } catch {
    return null
  }
}

/** The entry only while a lock is actually in force. */
export function readLoginLock(surface) {
  const value = readLoginState(surface)
  return value?.lockedUntil > Date.now() ? value : null
}

/** Counts a failed sign-in, locking the surface once the budget is spent. */
export function registerFailedAttempt(surface) {
  const previous = readLoginState(surface)

  // A lock whose hour is over starts the count over. Keeping the old attempts
  // would make every try after the first lockout lock again immediately.
  const expired = Boolean(previous?.lockedUntil) && previous.lockedUntil <= Date.now()
  const attempts = (expired ? 0 : previous?.attempts || 0) + 1

  if (attempts >= MAX_ATTEMPTS) {
    const lock = { attempts, lockedUntil: Date.now() + LOCK_MS }
    localStorage.setItem(loginLockKey(surface), JSON.stringify(lock))
    return { attempts, lock, remaining: 0 }
  }
  localStorage.setItem(loginLockKey(surface), JSON.stringify({ attempts }))
  return { attempts, lock: null, remaining: MAX_ATTEMPTS - attempts }
}

/** Called on every successful sign-in: the lock is about attempts, not people. */
export function clearLoginLock(surface) {
  localStorage.removeItem(loginLockKey(surface))
}

/**
 * The lock as it stands right now, ticking once a second so a countdown on
 * screen stays true without the caller wiring up its own timer.
 */
export function useLoginLock(surface) {
  // The countdown is state rather than a value read during render, because
  // reading the clock while rendering makes the same props produce different
  // output on every pass. The timer below moves it forward instead.
  const [state, setState] = useState(() => {
    const active = readLoginLock(surface)
    return { lock: active, secondsLeft: active ? Math.max(0, Math.ceil((active.lockedUntil - Date.now()) / 1000)) : 0 }
  })

  useEffect(() => {
    const tick = () => {
      const stored = readLoginState(surface)
      const active = stored?.lockedUntil > Date.now() ? stored : null
      // Tidy away only a lock that has actually expired. An entry that is merely
      // counting failed attempts has no `lockedUntil` and is live data — removing
      // it here is what reset the count every second and made the lock useless.
      if (stored?.lockedUntil && !active) localStorage.removeItem(loginLockKey(surface))
      const secondsLeft = active ? Math.max(0, Math.ceil((active.lockedUntil - Date.now()) / 1000)) : 0
      setState((current) => (
        (current.lock?.lockedUntil || 0) === (active?.lockedUntil || 0) && current.secondsLeft === secondsLeft
          ? current
          : { lock: active, secondsLeft }
      ))
    }
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [surface])

  const { lock, secondsLeft } = state
  const clock = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`
  return { lock, secondsLeft, clock }
}
