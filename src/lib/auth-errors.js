// Supabase Auth failures were previously collapsed into "wrong password" at
// every call site. That misdiagnoses the common cases (a rate limit, an
// unconfirmed address, a dropped connection) and, in the restaurant admin,
// even consumed one of three lockout attempts. Translate once, here.

const includesAny = (haystack, needles) => needles.some((needle) => haystack.includes(needle))

/**
 * Describe a Supabase auth error for display.
 *
 * Returns null when there is no error. Otherwise:
 *   message            - text safe to show the user
 *   isCredentialFailure - true only for a genuine email/password mismatch, so
 *                         callers can restrict lockout counting to real attempts
 */
export function describeAuthError(error) {
  if (!error) return null

  const code = error.code || ''
  const status = Number(error.status) || 0
  const raw = error.message || ''
  const lower = raw.toLowerCase()

  if (code === 'invalid_credentials' || includesAny(lower, ['invalid login credentials', 'invalid_grant'])) {
    return { message: 'Your email or password is incorrect.', isCredentialFailure: true }
  }

  if (code === 'email_not_confirmed' || includesAny(lower, ['email not confirmed'])) {
    return {
      message: 'That email address has not been confirmed yet. Open the confirmation link we sent, then try again.',
      isCredentialFailure: false,
    }
  }

  if (code === 'user_banned' || includesAny(lower, ['user is banned'])) {
    return { message: 'This account has been disabled. Contact the platform owner.', isCredentialFailure: false }
  }

  if (includesAny(code, ['over_request_rate_limit', 'over_email_send_rate_limit', 'too_many_requests']) || status === 429) {
    return { message: 'Too many sign-in attempts. Please wait a minute and try again.', isCredentialFailure: false }
  }

  if (includesAny(code, ['weak_password', 'same_password']) || includesAny(lower, ['weak password'])) {
    return { message: 'That password was rejected as too weak. Choose a longer one.', isCredentialFailure: false }
  }

  // A request that never reached Supabase arrives with no status at all.
  if (status === 0 || includesAny(lower, ['failed to fetch', 'networkerror', 'network request failed', 'load failed'])) {
    return {
      message: 'Could not reach the sign-in service. Check your connection and try again.',
      isCredentialFailure: false,
    }
  }

  return {
    message: `Sign-in failed: ${raw || 'unexpected error'}${status ? ` (${status})` : ''}.`,
    isCredentialFailure: false,
  }
}
