import { supabase } from './supabase'

// Every browser call to an /api endpoint goes through here.
//
// Two reasons this is a module rather than a fetch in each screen. The endpoints
// require a platform session, so the token has to be attached to all of them and
// forgetting it in one place produces a confusing 403. And `fetch` does not throw
// on 4xx/5xx, so a naive caller treats a rejected card, a missing API key, and a
// duplicate plan name as the same silent success — which is how a screen ends up
// reporting "saved" for something the server refused.

/** Thrown with the server's own wording, so the screen never invents a cause. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function postAuthorized(path, body) {
  if (!supabase) throw new ApiError('Supabase is not configured for this deployment.', 0)
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ApiError('Your session expired. Please sign in again.', 401)

  let response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    // A network failure is not a refusal by the server. Saying so is the
    // difference between an operator retrying and an operator filing a bug.
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0)
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(payload.error || `The request failed (${response.status}).`, response.status)
  return payload
}

/** Removes a restaurant, either entirely or keeping its payment history. */
export const deleteRestaurant = (restaurantId, mode, confirm) =>
  postAuthorized('/api/restaurants/delete', { restaurantId, mode, confirm })
