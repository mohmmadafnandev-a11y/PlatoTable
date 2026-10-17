import { ApiError, postAuthorized } from './api'

// The billing calls the panel makes. The request mechanics themselves live in
// ./api, which every authorised endpoint shares.
//
// There is deliberately no "which mode is the server in" helper here. The
// deployment talks to Safepay's sandbox or its live account depending on its own
// keys, and the screens look identical either way — a badge that announced the
// mode was a claim about the deployment that the browser could get wrong, and
// the product ships without one.

/** Kept for callers that name billing specifically; identical to ApiError. */
export class BillingApiError extends ApiError {}

export const postBilling = (path, body) => postAuthorized(path, body)

// Whether this deployment holds the keys payments need — not which mode they
// are. Answered by the server, because only it can see them.

export const safepayReadiness = () => postBilling('/api/safepay/status')

export const savePlan = (plan) => postBilling('/api/safepay/plans', { action: 'save', plan })
export const deletePlan = (id) => postBilling('/api/safepay/plans', { action: 'delete', plan: { id } })

// Pulls a restaurant's real subscription state from Safepay. A webhook is the
// normal path; this is the repair one for a delivery that was missed, and what
// the billing screen calls when it comes back from a checkout.
export const syncSubscription = (restaurantId) => postBilling('/api/safepay/sync', { restaurantId })

// Starts a subscription: opens Safepay's hosted card page and has the platform
// take the first period itself once the card is confirmed (see server/safepay/checkout.js).
// The amount is resolved on the server from the plan, so nothing the browser sends
// can change what is charged.
export const startSubscription = (restaurantId, planId) => postBilling('/api/safepay/checkout', { restaurantId, planId })

// Opens Safepay's hosted *add card* page: a zero-amount verification that stores
// the card for later renewals. Adding a card never charges by itself, but if a
// payment is already due — a failed renewal, an ended trial — the platform takes
// it the moment the card is confirmed, which is what makes this the repair path
// for "my renewal failed".
export const savePaymentMethod = (restaurantId) => postBilling('/api/safepay/card', { restaurantId })

// Reads a payment session back from Safepay. The return trip from a checkout calls
// this, and so does a manual refresh when a webhook has not arrived.
export const settlePayment = (restaurantId, tracker = null) => postBilling('/api/safepay/settle', { restaurantId, ...(tracker ? { tracker } : {}) })

// Safepay publishes no hosted billing portal, so stopping a renewal is a call the
// platform makes rather than a page the customer is sent to.
export const cancelSubscription = (restaurantId) => postBilling('/api/safepay/manage', { action: 'cancel', restaurantId })
export const setAutoRenew = (restaurantId, on) => postBilling('/api/safepay/manage', { action: 'autoRenew', restaurantId, on })

// Forgets the card on Safepay's side and here. The honest answer to "stop charging my
// card", and what a test of the failed-card path needs.
export const removePaymentMethod = (restaurantId) => postBilling('/api/safepay/manage', { action: 'removeCard', restaurantId })

// The sweep normally runs on Vercel Cron. Being able to trigger it by hand is
// what makes the trial-warning and grace notifications reachable in a session
// rather than only on the morning after they were written.
export const runBillingSweep = (dryRun = false) => postBilling('/api/billing/sweep', { dry_run: dryRun })
