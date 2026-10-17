import { requireActor } from '../_lib/actor.js'
import { safepayProblems } from '../_lib/safepay.js'

// Whether this deployment can take a payment at all.
//
// Deliberately not a mode indicator. The screens look the same whichever keys a
// deployment holds, and printing "test mode" in the product was a claim about
// the deployment that the browser could get wrong — and one that a customer
// should never see. What an operator configuring the platform needs to know is
// only whether the variables are present, and which one is not.
export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' })

  const actor = await requireActor(request)
  if (!actor?.isStaff) return response.status(403).json({ error: 'Only platform staff can read the payment configuration.' })

  const missing = safepayProblems({ webhook: true })
  return response.status(200).json({ configured: missing.length === 0, missing })
}
