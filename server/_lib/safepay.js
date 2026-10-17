// Safepay, in one place.
//
// Every call the platform makes to Safepay goes through this module, for the same
// reason the service-role client lives in one file: the day the API changes, or a
// second endpoint needs to charge a card, there is one place to look.
//
// ─────────────────────────────────────────────────────────────────────────────
// Why this module pays with *trackers* and not with Safepay's Subscriptions
// ─────────────────────────────────────────────────────────────────────────────
//
// Safepay sells a Subscriptions product — create a plan, send the customer to
// /checkout/subscribe, let Safepay bill them. It cannot be used here, and the
// reason is not a preference:
//
//   * Subscriptions cannot be created through the API at all. Safepay's own
//     documentation says so: "Subscriptions cannot be created using APIs since a
//     customer has to subscribe to a plan."
//   * That checkout puts the shopper through Safepay's *account* login. Measured
//     against the sandbox, /checkout/subscribe redirects every anonymous visitor
//     to /checkout/auth/login and offers Sign Up, so a restaurant owner would
//     have to create a Safepay account before they could pay this platform.
//     Testing with a merchant-managed customer attached made no difference.
//   * That login page was also broken for a visitor with no account: the reCAPTCHA
//     never rendered and the form answered "recaptcha_token is required" — a dead
//     end that still sends a customer away from the platform.
//
// What Safepay does offer, and what this module uses, is the Hosted Checkout over
// a *tracker*: a page that asks for the card itself, with no account and no login,
// and that can save the card for later merchant-initiated charges. Everything the
// platform needs was measured on the live sandbox rather than read out of a doc:
//
//   * a payment      POST /order/payments/v3/ { mode: 'payment', user: cus_..., amount }
//                    -> a tracker; the customer pays on /embedded/?tracker=...
//                    Caveat, measured later: the hosted page cannot *finish* a
//                    payment for a tracker that carries a merchant-managed
//                    customer — its enrolment step answers 401 "this request
//                    requires merchant authentication" — so the platform starts
//                    subscriptions on the instrument page and takes the money
//                    with a merchant-initiated charge. See safepay-billing.js.
//   * saving a card  the same with mode: 'instrument' and is_account_verification,
//                    which shows "we'll charge and refund you Rs.0.00" and stores
//                    the card in that customer's wallet
//   * charging it    mode: 'subscription' + entry_mode: 'mit' for an amount nobody
//                    is present to approve, then the AUTHORIZATION action carrying
//                    payment_method.tokenized_card.token — a real, settled
//                    merchant-initiated charge (sandbox: TRACKER_ENDED, capture
//                    "Successful transaction")
//   * reading it back GET /reporter/api/v1/payments/{tracker} — state, charge,
//                    card, and the events list
//
// Two details of the tracker API are unforgiving and are handled here:
//
//   * `metadata` is not free-form. Only a fixed set of keys is accepted; an
//     unknown one is refused with "unsupported meta key <name>". `order_id` is
//     used for the platform's own reference.
//   * `mode: 'subscription'` wants the shopper under BOTH `user` and `customer`
//     fields. With only one of them the API answers a bare "missing customer",
//     which reads like the customer does not exist rather than like a field is
//     missing.
//
// The hosted checkout is served from the API host under /embedded/ in both
// environments (https://getsafepay.com/embedded/ in production), which is why the
// checkout host defaults to the API host.
//
// The sandbox and live hosts are separate, with separate keys, and the module
// refuses to guess: `safepayEnv()` reads SAFEPAY_ENV and anything that is not
// explicitly 'production' is treated as sandbox. A misconfigured deployment that
// forgot the variable therefore cannot silently charge a real card.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { CURRENCY, toMinorUnits } from '../../shared/plans.js'

const SANDBOX_API = 'https://sandbox.api.getsafepay.com'
const LIVE_API = 'https://api.getsafepay.com'
const SANDBOX_CHECKOUT = 'https://sandbox.api.getsafepay.com'
const LIVE_CHECKOUT = 'https://getsafepay.com'

/** 'production' only when the deployment says so; everything else is sandbox. */
export const safepayEnv = () => (String(process.env.SAFEPAY_ENV || '').toLowerCase() === 'production' ? 'production' : 'sandbox')
const isLive = () => safepayEnv() === 'production'

/** Where the API answers. Overridable so the sandbox host can be pinned in a test. */
export const apiBase = () => (process.env.SAFEPAY_HOST || '').replace(/\/+$/, '') || (isLive() ? LIVE_API : SANDBOX_API)

/** Where the customer's browser is sent to pay. */
export const checkoutBase = () => (process.env.SAFEPAY_CHECKOUT_HOST || '').replace(/\/+$/, '') || (isLive() ? LIVE_CHECKOUT : SANDBOX_CHECKOUT)

/**
 * A secret that is really set, or the empty string.
 *
 * A value copied out of `.env.example` and never replaced is not a credential,
 * and treating it as one is the worst of both worlds: the webhook answers 401 to
 * every real event (so payments silently stop being recorded) while the readiness
 * screen reports the deployment as configured. Reading it as absent instead turns
 * both into the same explicit "this is not set yet".
 */
const credential = (value) => {
  const trimmed = String(value || '').trim()
  return /^(replace[-_ ]?with|change[-_ ]?me|your[-_ ]|todo|xxx+|<.*>)/i.test(trimmed) ? '' : trimmed
}

const secret = () => credential(process.env.SAFEPAY_SECRET_KEY)
const webhookSecret = () => credential(process.env.SAFEPAY_WEBHOOK_SECRET)

/** The public/merchant key, sent with every tracker and recorded against the plans we create. */
export const merchantKey = () => credential(process.env.SAFEPAY_MERCHANT_KEY)

/**
 * What is missing before Safepay can be used at all.
 *
 * Returned as a list of names rather than a boolean so an endpoint can say which
 * variable is absent — "SAFEPAY_SECRET_KEY is not set" sends someone to the right
 * place, "Safepay is not configured" does not.
 */
export function safepayProblems({ webhook = false } = {}) {
  const missing = []
  if (!secret()) missing.push('SAFEPAY_SECRET_KEY')
  if (!merchantKey()) missing.push('SAFEPAY_MERCHANT_KEY')
  if (webhook && !webhookSecret()) missing.push('SAFEPAY_WEBHOOK_SECRET')
  return missing
}

/** True when the server half of Safepay is usable. */
export const safepayConfigured = () => safepayProblems().length === 0

// ─────────────────────────────────────────────────────────────────────────────
// The passport token
// ─────────────────────────────────────────────────────────────────────────────

// One token is valid for about an hour, and every checkout would otherwise mint
// a fresh one. A module-scope cache is enough: the value is not user data, and a
// cold start simply mints another. The five-minute buffer means a token that is
// about to expire mid-request is never handed to a browser.
let tokenCache = { value: '', expiresAt: 0 }

export async function passportToken({ force = false } = {}) {
  const now = Date.now()
  if (!force && tokenCache.value && now < tokenCache.expiresAt - 5 * 60_000) return tokenCache.value

  const response = await fetch(`${apiBase()}/client/passport/v1/token`, {
    method: 'POST',
    headers: { 'X-SFPY-MERCHANT-SECRET': secret(), 'Content-Type': 'application/json' },
  })
  const payload = await response.json().catch(() => ({}))
  const token = payload?.data
  if (!response.ok || typeof token !== 'string' || !token) {
    throw new SafepayError(payload?.error || payload?.message || `Safepay refused to issue a checkout token (HTTP ${response.status}).`, response.status)
  }
  tokenCache = { value: token, expiresAt: now + 60 * 60_000 }
  return token
}

// ─────────────────────────────────────────────────────────────────────────────
// The API itself
// ─────────────────────────────────────────────────────────────────────────────

export class SafepayError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'SafepayError'
    this.status = status
  }
}

/**
 * A server call, with Safepay's own words on failure.
 *
 * `{ error: "..." }` and `{ status: { errors: [...] } }` are both shapes the API
 * refuses with, and those sentences are far more useful in a log than a status
 * code — so they are preserved on the thrown error. The second shape matters more
 * than it looks: a declined card arrives as HTTP 403 with the issuer's reason in
 * `status.errors`, and that sentence is what an operator needs to read.
 */
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: { 'X-SFPY-MERCHANT-SECRET': secret(), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()
  // A body that is not JSON is not itself the failure worth reporting — the
  // status is — so the parse is best-effort and null means "no message".
  const payload = (() => { try { return text ? JSON.parse(text) : null } catch { return null } })()

  if (!response.ok) {
    const listed = Array.isArray(payload?.status?.errors) ? payload.status.errors.filter(Boolean) : []
    const message = payload?.error || payload?.message || listed.join('; ') || `${method} ${path} failed (HTTP ${response.status}).`
    throw new SafepayError(message, response.status)
  }
  return payload?.data ?? payload
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans (the catalogue mirror)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a reusable plan and returns its token.
 *
 * The catalogue is still mirrored into Safepay — the Plans screen shows whether a
 * price is live there — but no charge depends on it any more: an amount is sent
 * with each tracker, so what a restaurant is billed is the rupee price on the
 * plan row rather than whatever a Safepay plan happens to hold.
 *
 * The argument names are deliberately permissive: `planPayload` is passed
 * straight through by the plan writer and its keys are the platform's
 * (`interval_count`, `trial_days`), while a hand-written call reads better as
 * `intervalCount` / `trialDays`. Both spellings work, and that is not tidiness —
 * a name that does not match is dropped in silence, and that is how every mirror
 * was created monthly (a 90 day plan billed every 30 days) and without the trial
 * the platform advertises.
 */
export async function createPlan({ name, amount, currency = CURRENCY, interval, intervalCount, interval_count, trialDays, trial_days, trial_period_days, product, description }) {
  const intervalCountValue = Number(intervalCount ?? interval_count) || 1
  const trialDaysValue = Math.max(0, Number(trialDays ?? trial_days ?? trial_period_days) || 0)
  const payload = {
    name,
    amount: String(toMinorUnits(amount, currency)),
    currency: String(currency).toUpperCase(),
    interval: String(interval).toUpperCase(),
    interval_count: intervalCountValue,
    type: 'RECURRING',
    product,
    active: true,
    ...(description ? { description } : {}),
    // Sent for both variants: 0 is the explicit "no trial", which keeps the two
    // payloads the same shape and therefore comparable in the database.
    trial_period_days: trialDaysValue,
  }

  const data = await api('/client/plans/v1/', { method: 'POST', body: payload })
  const planId = data?.plan_id || data?.token
  if (!planId) throw new SafepayError('Safepay accepted the plan but returned no plan id.', 502)
  return { planId, payload }
}

/** The plan as Safepay holds it. `null` when it is gone. */
export async function readPlan(planId) {
  try {
    const data = await api(`/client/plans/v1/${encodeURIComponent(planId)}/`)
    return data?.plan || null
  } catch (error) {
    if (error instanceof SafepayError && error.status === 404) return null
    throw error
  }
}

/** Closes a plan that is no longer on sale; Safepay archives rather than deletes it. */
export async function deletePlan(planId) {
  if (!planId) return { deleted: false }
  try {
    await api(`/client/plans/v1/${encodeURIComponent(planId)}/`, { method: 'DELETE' })
    return { deleted: true }
  } catch (error) {
    console.error('[safepay] could not close plan', planId, error?.message)
    return { deleted: false, error: error?.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Merchant-managed customers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one customer per restaurant that holds its card.
 *
 * Safepay distinguishes a shopper who has a Safepay account from a customer the
 * merchant manages. Only the second kind can be used here — the restaurant owner
 * should never need a Safepay account — and only the second kind gives the
 * platform a card it may charge later: `is_guest: true` customers may tokenize
 * payment methods, and those tokens are restricted to this merchant, which is
 * exactly the scope wanted.
 *
 * A customer is created with the owner's details so the hosted page arrives
 * pre-filled, which is the difference between a form and a form with three fields
 * already answered.
 */
export async function createCustomer({ name, email, phone }) {
  const [first = '', ...rest] = String(name || '').trim().split(/\s+/)
  const data = await api('/user/customers/v1/', {
    method: 'POST',
    body: {
      first_name: first || 'Restaurant',
      last_name: rest.join(' ') || 'Owner',
      ...(email ? { email: String(email) } : {}),
      ...(phone ? { phone_number: String(phone) } : {}),
      country: 'PK',
      is_guest: true,
    },
  })
  const customerId = data?.token
  if (!customerId) throw new SafepayError('Safepay accepted the customer but returned no customer id.', 502)
  return { customerId, customer: data }
}

/** The customer as Safepay holds it. `null` when the id is unknown. */
export async function readCustomer(customerId) {
  if (!customerId) return null
  try {
    return await api(`/user/customers/v1/${encodeURIComponent(customerId)}`)
  } catch (error) {
    if (error instanceof SafepayError && error.status === 404) return null
    throw error
  }
}

/**
 * The cards Safepay holds for this customer.
 *
 * Read back after a card is added, so the row stores what Safepay actually
 * accepted rather than what the browser claimed. Two tokens come back and both
 * matter: the `pm_` token identifies the entry in the wallet, and the
 * `cybersource.tms_` pointer is what a merchant-initiated charge is authorised
 * with. Only the brand, the last four digits and the expiry ever leave here —
 * Safepay hands out nothing more, which is the point of collecting the card on
 * their page instead of on ours.
 */
export async function listPaymentMethods(customerId) {
  if (!customerId) return []
  const data = await api(`/user/customers/v1/${encodeURIComponent(customerId)}/wallet/?limit=10&page=0`)
  const wallet = Array.isArray(data?.wallet) ? data.wallet : []
  return wallet.filter((entry) => !entry.is_deleted).map((entry) => {
    const card = entry.cybersource || entry.card || {}
    return {
      token: entry.token,
      pointer: card.token || null,
      brand: card.scheme || card.card_type || card.brand || null,
      last4: card.last_four || card.last4 || null,
      expMonth: card.expiry_month || card.expiration_month || null,
      expYear: card.expiry_year || card.expiration_year || null,
      created: entry.created_at?.seconds ? new Date(entry.created_at.seconds * 1000).toISOString() : null,
    }
  })
}

/**
 * Removes the customer and, with it, every card they hold.
 *
 * Used when a restaurant is erased: a token that still works for a tenant that no
 * longer exists is the one piece of Safepay state this platform must not leave
 * behind.
 */
export async function deleteCustomer(customerId) {
  if (!customerId) return { deleted: false }
  try {
    await api(`/user/customers/v1/${encodeURIComponent(customerId)}`, { method: 'DELETE' })
    return { deleted: true }
  } catch (error) {
    if (error instanceof SafepayError && error.status === 404) return { deleted: true }
    return { deleted: false, error: error?.message }
  }
}

/** Removes a stored card. Used when a card is replaced or a tester clears one. */
export async function deletePaymentMethod(customerId, paymentMethodId) {
  if (!customerId || !paymentMethodId) return { deleted: false }
  try {
    await api(`/user/customers/v1/${encodeURIComponent(customerId)}/wallet/${encodeURIComponent(paymentMethodId)}`, { method: 'DELETE' })
    return { deleted: true }
  } catch (error) {
    if (error instanceof SafepayError && error.status === 404) return { deleted: true }
    return { deleted: false, error: error?.message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Trackers: the payment session behind the hosted page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a payment session and returns its tracker.
 *
 * `metadata` accepts only a fixed set of keys ("unsupported meta key probe"),
 * and `order_id` is the platform's own reference — the restaurant id, which comes
 * back with the payment so an event can be matched without a lookup table.
 *
 * `customer` is duplicated into `user` on purpose: `mode: 'subscription'` refuses
 * a tracker with only one of them, and answers "missing customer" if either is
 * absent. Sending both is accepted by every mode.
 */
export async function createTracker({ mode, customerId, amount, currency = CURRENCY, reference, entryMode, isAccountVerification = false, metadata = {} }) {
  const data = await api('/order/payments/v3/', {
    method: 'POST',
    body: {
      merchant_api_key: merchantKey(),
      ...(customerId ? { user: customerId, customer: customerId } : {}),
      intent: 'CYBERSOURCE',
      mode,
      ...(entryMode ? { entry_mode: entryMode } : {}),
      currency: String(currency).toUpperCase(),
      // A zero-amount verification is still an amount, and Safepay is happiest
      // being told it explicitly.
      amount: toMinorUnits(amount, currency),
      ...(isAccountVerification ? { is_account_verification: true } : {}),
      ...(reference ? { metadata: { order_id: String(reference), ...metadata } } : Object.keys(metadata).length ? { metadata } : {}),
      include_fees: false,
    },
  })
  const tracker = data?.tracker?.token
  if (!tracker) throw new SafepayError('Safepay accepted the session but returned no tracker.', 502)
  return { tracker, state: data.tracker.state, entryMode: data.tracker.entry_mode || entryMode || null, totals: data.tracker.purchase_totals || null }
}

/**
 * A session for a customer to pay an amount: the direct card page.
 *
 * Kept for the record, but the platform does not bill through it: the hosted page
 * refuses the enrolment step for a tracker that carries a merchant-managed
 * customer — `401 this request requires merchant authentication`, reproduced
 * against the exact payload the page sends — and a tracker without that customer
 * saves the card somewhere the merchant cannot read it for renewals. A
 * subscription starts on the instrument page instead (see openCardCapture in
 * safepay-billing.js).
 */
export const createPaymentTracker = ({ customerId, amount, currency, reference }) =>
  createTracker({ mode: 'payment', customerId, amount, currency, reference })

/**
 * A session that saves a card instead of taking money.
 *
 * `mode: 'instrument'` with `is_account_verification` is Safepay's own "add a
 * payment method" flow: the page says it will charge and refund Rs 0.00, the card
 * is verified with a zero-amount authorisation, and it lands in the customer's
 * wallet. No PCI certificate is needed, because the card is typed on Safepay's
 * page and never reaches this server — which is the whole reason the platform has
 * no card field of its own.
 */
export const createInstrumentTracker = ({ customerId, reference }) =>
  createTracker({ mode: 'instrument', customerId, amount: 0, currency: CURRENCY, reference, isAccountVerification: true })

/**
 * The URL the customer is sent to in order to pay.
 *
 * Built here rather than from an SDK, because the format is not documented
 * outside the libraries: the hosted page lives at `/embedded/` on the API host and
 * takes the tracker, a short-lived passport token, the source, the customer, and
 * where to return to. `env` is passed explicitly — the same page is served in
 * both environments and picks its sandbox from this flag.
 */
export async function hostedCheckoutUrl({ tracker, customerId, redirectUrl, cancelUrl }) {
  const token = await passportToken()
  const params = new URLSearchParams({
    environment: safepayEnv(),
    tracker,
    tbt: token,
    source: 'hosted',
    ...(customerId ? { user_id: customerId } : {}),
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
  })
  return `${checkoutBase()}/embedded/?${params.toString()}`
}

/**
 * Charges a card that is already saved against the customer.
 *
 * This is a merchant-initiated transaction: nobody is at the keyboard, so there is
 * no 3DS challenge and no hosted page — the platform asks for the money and the
 * issuer answers. The sequence and the payload shape are not guessable, and both
 * were measured against the sandbox:
 *
 *   * the session is `mode: 'subscription'` with `entry_mode: 'mit'`;
 *   * the AUTHORIZATION action expects the card under
 *     `payment_method.tokenized_card.token` — `payment_method.token`,
 *     `payment_method.card.token` and `payment_method.instrument` are each
 *     refused with "missing tokenized card or network token payload";
 *   * the token is the `tms_` pointer from the customer's wallet (a `pm_` token is
 *     accepted by the wallet API but not by this action).
 *
 * `do_capture: true` asks for authorisation and capture in one call, so a
 * successful response means the money moved rather than merely being reserved.
 * A refusal — an expired card, no funds, an issuer that does not permit a
 * merchant-initiated charge — arrives as a SafepayError carrying the issuer's own
 * reason, which is what the ledger records.
 */
export async function chargeSavedCard({ customerId, amount, currency = CURRENCY, pointer, reference }) {
  if (!pointer) throw new SafepayError('This subscription has no saved card to charge.', 400)
  const { tracker } = await createTracker({ mode: 'subscription', entryMode: 'mit', customerId, amount, currency, reference })
  try {
    const data = await api(`/order/payments/v3/${encodeURIComponent(tracker)}`, {
      method: 'POST',
      body: { payload: { payment_method: { tokenized_card: { token: pointer } }, authorization: { do_capture: true } } },
    })
    return { tracker, state: data?.tracker?.state || null, action: data?.action || null }
  } catch (error) {
    // The tracker exists whether or not the charge was allowed, and it is the
    // only handle on "what Safepay thought of this attempt" — so it travels with
    // the failure rather than being lost with it.
    error.tracker = tracker
    throw error
  }
}

/**
 * A payment as Safepay reports it.
 *
 * The reporter is the source of truth for a tracker: `state` says whether it
 * ended, `charge` carries the settled amount and the fees, and `attempts[].payment_method`
 * holds the card that paid. Both the return path and the webhook read this rather
 * than trusting the shape of whatever an event happened to carry.
 */
export async function readTracker(trackerId) {
  if (!trackerId) return null
  try {
    const data = await api(`/reporter/api/v1/payments/${encodeURIComponent(trackerId)}`)
    return data || null
  } catch (error) {
    if (error instanceof SafepayError && error.status === 404) return null
    throw error
  }
}

/** `TRACKER_ENDED` is the only state in which the money has moved. */
export const trackerPaid = (payment) => String(payment?.state || '').toUpperCase() === 'TRACKER_ENDED'

/** True while Safepay is still waiting for the customer to finish. */
export const trackerOpen = (payment) => /TRACKER_(STARTED|PENDING|AUTHORIZED)$/i.test(String(payment?.state || ''))

/**
 * The card facts a ledger row is allowed to hold, read from a tracker.
 *
 * The attempt carries the card; an older tracker may only carry `action`. Both
 * are read, and a payment that recorded no card yields nulls rather than a guess.
 */
export function cardFromTracker(payment) {
  const attempt = Array.isArray(payment?.attempts) ? payment.attempts[0] : null
  const method = attempt?.payment_method || payment?.action?.payment_method || {}
  return {
    brand: method.scheme || method.card_type || method.brand || null,
    last4: method.last_four || method.last4 || null,
    expMonth: method.expiration_month || method.expiry_month || null,
    expYear: method.expiration_year || method.expiry_year || null,
    // The pointer a later charge is authorised with, when Safepay reported one.
    pointer: method.pointer || null,
  }
}

/** The settled charge behind a tracker, in rupees. */
export function chargeFromTracker(payment) {
  const charge = payment?.charge || null
  if (!charge) return null
  return {
    id: charge.token || null,
    // Safepay reports minor units; the ledger holds rupees, because a bank
    // statement for PKR 2,000 says 2,000 and nothing else.
    amount: charge.amount?.amount === undefined ? null : Number(charge.amount.amount) / 100,
    currency: charge.amount?.currency || null,
    captured: charge.capture?.created_at?.seconds ? new Date(charge.capture.created_at.seconds * 1000).toISOString() : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks
// ─────────────────────────────────────────────────────────────────────────────

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

/**
 * True when the signature matches under either scheme Safepay has shipped.
 *
 * The SDK signs `JSON.stringify(body.data)` with SHA-512; the handbook signs the
 * raw request body with SHA-256. Checking both means a webhook endpoint that was
 * written against one of them keeps working when the account is switched to the
 * other, and it is the difference between recording a payment and dropping it.
 */
export function verifyWebhookSignature({ rawBody, body, signature }) {
  const provided = String(signature || '').trim()
  if (!provided || !webhookSecret()) return false

  if (rawBody) {
    const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
    const sha256 = createHmac('sha256', webhookSecret()).update(raw).digest('hex')
    if (safeEqual(sha256, provided)) return true
  }

  if (body && body.data !== undefined) {
    const serialized = Buffer.from(JSON.stringify(body.data), 'utf8')
    const sha512 = createHmac('sha512', webhookSecret()).update(serialized).digest('hex')
    if (safeEqual(sha512, provided)) return true
    const sha256Data = createHmac('sha256', webhookSecret()).update(serialized).digest('hex')
    if (safeEqual(sha256Data, provided)) return true
  }

  return false
}
