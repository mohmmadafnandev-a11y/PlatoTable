import { createHash } from 'node:crypto'
import { admin } from '../_lib/admin.js'
import { settle } from '../_lib/safepay-billing.js'
import { safepayProblems, verifyWebhookSignature } from '../_lib/safepay.js'

export const config = { api: { bodyParser: false } }

// Where Safepay tells the platform what happened to a payment.
//
// Safepay's own handbook is unusually precise about the order of operations here,
// and this endpoint follows it:
//
//   1. Verify the HMAC signature over the raw body — reject before parsing.
//   2. Deduplicate on the event id, so a retry is a no-op.
//   3. Persist the raw event.
//   4. Apply the business logic, then answer.
//
// One adaptation is deliberate: in a serverless runtime, work started after the
// response is not guaranteed to run before the instance is frozen, so the business
// logic runs *before* the reply — but a failure in it still answers 200. That is what
// the handbook is protecting against ("Safepay will not retry if you already responded
// 200"): the raw event is already in `billing_events`, so a failure is replayable from
// there, and asking Safepay to redeliver would only produce a duplicate of a row we
// hold. The `process_error` column is what the repair path reads.
//
// What this endpoint does *not* do is believe the payload. An event is a nudge, not
// a fact: the tracker it names is read back from Safepay's reporter, and the payment
// is written down from that answer (`settle` in _lib/safepay-billing.js). It matters
// because the same write happens on the customer's return trip, and both paths must
// agree on the amount, the card and the period — the one source of both is Safepay's
// own record of the payment.
//
// The two signature schemes are both accepted (see _lib/safepay.js): the current SDK
// signs the re-serialised `data` with SHA-512, the handbook signs the raw body with
// SHA-256, and an account can be switched between them.

/**
 * The request body as bytes.
 *
 * The catch-all router (`api/[...path].js`) reads the stream once and keeps the
 * raw bytes on `request.rawBody`, because the HMAC is computed over exactly what
 * Safepay sent — a re-serialisation would differ in whitespace and key order. The
 * local dev shim hands a parsed object instead (it never had a stream to give),
 * so the object is re-serialised — which is still enough to check the `data`-based
 * signature, and therefore enough to exercise the whole endpoint without a public
 * URL. A runtime that parses before the router ever sees the request ends up on
 * the same fallback.
 */
const readRawBody = (request) => new Promise((resolve) => {
  if (request?.rawBody !== undefined) {
    const raw = request.rawBody
    resolve(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8'))
    return
  }
  if (!request || typeof request.on !== 'function') {
    const body = request?.body
    resolve(body && typeof body === 'object' ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0))
    return
  }
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => resolve(Buffer.concat(chunks)))
  request.on('error', () => resolve(Buffer.alloc(0)))
})

/**
 * The tracker an event is about.
 *
 * Safepay's events name it `tracker` on the current API, but the field has moved
 * before and a payment event may nest it (`data.tracker.token`, `data.payment.tracker`).
 * Rather than guess one spelling, any tracker id in the payload is taken — and a wrong
 * guess is harmless, because a tracker that matches no subscription is reported as
 * `no-match` instead of writing anything.
 */
function findTracker(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return ''
  if (typeof value === 'string') return value.startsWith('track_') ? value : ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTracker(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findTracker(item, depth + 1)
      if (found) return found
    }
  }
  return ''
}

async function applyEvent(eventId, type, data) {
  const tracker = findTracker(data)
  if (tracker) {
    const result = await settle(admin, tracker, { source: 'webhook' })
    if (result.result === 'no-match') {
      console.warn('[safepay/webhook] a payment arrived for a tracker no subscription holds:', tracker, eventId)
    }
    return `${type} (${result.result})`
  }

  // Subscriptions: Safepay's own product, which this platform no longer uses — its
  // checkout requires a Safepay account. An event can still arrive if somebody
  // subscribed by hand in Safepay's dashboard, and saying so beats ignoring it
  // silently.
  if (/^subscription\./.test(type)) {
    return `ignored (${type}: Safepay subscriptions are not used by this platform)`
  }

  console.log('[safepay/webhook] unhandled event type:', type)
  return 'ignored'
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).end()

  const problems = safepayProblems({ webhook: true })
  if (problems.length) {
    console.error('[safepay/webhook] refusing an event:', problems.join(', '), 'is not set for this deployment')
    return response.status(503).send('Webhook is not configured')
  }

  const rawBody = await readRawBody(request)
  const signature = request.headers['x-sfpy-signature']
  let body = request.body && typeof request.body === 'object' && !Buffer.isBuffer(request.body) ? request.body : null
  if (!body) { try { body = JSON.parse(rawBody.toString('utf8')) } catch { body = null } }

  if (!verifyWebhookSignature({ rawBody, body, signature })) {
    console.warn('[safepay/webhook] rejected an event with an invalid signature')
    return response.status(401).send('Invalid signature')
  }
  if (!body || typeof body !== 'object') return response.status(400).send('Invalid payload')

  const type = String(body.type || body.event_type || body.eventType || 'unknown')
  const data = body.data && typeof body.data === 'object' ? body.data : {}
  // Safepay sends an event id. When one is absent the raw body is hashed instead,
  // which deduplicates a retry of the same delivery just as well.
  const eventId = String(body.id || body.event_id || body.eventId || body.token || createHash('sha256').update(rawBody).digest('hex'))

  const { error: storeError } = await admin.from('billing_events').insert({ id: eventId, provider: 'safepay', type, payload: body })
  if (storeError) {
    // 23505 is the primary key: this exact delivery has been seen before, which is
    // exactly what the dedupe is for. Answer 200 so Safepay stops retrying.
    if (storeError.code === '23505') return response.status(200).json({ received: true, duplicate: true })
    console.error('[safepay/webhook] could not store the event:', storeError.message)
    return response.status(500).json({ error: 'Could not store the event.' })
  }

  try {
    const handled = await applyEvent(eventId, type, data)
    await admin.from('billing_events').update({ processed_at: new Date().toISOString() }).eq('id', eventId)
    return response.status(200).json({ received: true, handled })
  } catch (error) {
    console.error('[safepay/webhook] processing failed:', eventId, error)
    await admin.from('billing_events').update({ process_error: String(error?.message || error) }).eq('id', eventId)
    // 200 on purpose — see the note at the top: the event is stored and the repair
    // path reads `process_error`, so a redelivery would only duplicate it.
    return response.status(200).json({ received: true, stored: true, processed: false })
  }
}
