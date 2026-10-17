import { Card } from './ui'
import { shortDate } from '../lib/format'
import { progressView } from '../lib/subscription-progress'

// Where a subscription is in its life, drawn as a bar.
//
// The panel used to answer this with a status badge and two dates, which is
// three separate facts an operator has to assemble in their head — and the one
// question they actually have ("how long until money moves, and how much") was
// the one nothing answered. This is that answer: one bar for the current period,
// with the elapsed part solid and the remaining part striped, and the amount and
// date of the next charge stated plainly.
//
// The states the bar can describe are in ../lib/subscription-progress.js.

const TONES = {
  indigo: { headline: 'text-slate-900', pay: 'text-indigo-700', bar: '#4f46e5', stripe: 'rgba(79,70,229,.22)', stripeBase: '#eef2ff', track: 'border-slate-200' },
  warning: { headline: 'text-amber-900', pay: 'text-amber-700', bar: '#d97706', stripe: 'rgba(217,119,6,.22)', stripeBase: '#fffbeb', track: 'border-amber-200' },
  danger: { headline: 'text-red-800', pay: 'text-red-700', bar: '#dc2626', stripe: 'rgba(220,38,38,.2)', stripeBase: '#fef2f2', track: 'border-red-200' },
  slate: { headline: 'text-slate-900', pay: 'text-slate-700', bar: '#64748b', stripe: 'rgba(100,116,139,.2)', stripeBase: '#f8fafc', track: 'border-slate-200' },
}

/**
 * The card itself. `subscription` is a row from `subscriptions` or the nested
 * object the restaurant read model returns — both carry the same field names.
 */
export default function SubscriptionProgress({ subscription, className = '' }) {
  if (!subscription) return null
  const view = progressView(subscription)
  const tone = TONES[view.tone] || TONES.indigo
  const elapsed = view.ratio === null ? 0 : Math.round(view.ratio * 100)
  const finalLabel = view.payLabel === 'NO FURTHER PAYMENT'

  return (
    <Card className={`p-6 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[.16em] text-slate-400">{view.eyebrow}</p>
          <p className={`mt-2 text-2xl font-semibold tracking-tight ${tone.headline}`}>{view.headline}</p>
        </div>
        {view.payValue && (
          <div className="text-right">
            <p className="text-xs font-semibold tracking-[.16em] text-slate-400">{view.payLabel}</p>
            <p className={`mt-2 text-2xl font-semibold tracking-tight ${tone.pay}`}>{view.payValue}</p>
          </div>
        )}
      </div>

      {view.ratio !== null && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {view.legend.map((item) => (
              <span key={item.label} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                {item.kind === 'solid'
                  ? <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: tone.bar }} />
                  : <span className="h-2.5 w-2.5 rounded-[3px] border border-dashed border-slate-400" />}
                {item.label}
              </span>
            ))}
          </div>

          {/* One bar, two segments. The elapsed part is solid and the remainder
              is striped, so "how much of this period is spent" reads at a glance
              without a number printed on the bar itself. */}
          <div className={`mt-3 flex h-12 w-full overflow-hidden rounded-lg border ${tone.track}`} role="img" aria-label={`${elapsed}% of this period elapsed`}>
            {/* min-width keeps the elapsed segment visible on a period that has
                only just begun. Without it a fresh trial draws an empty bar with
                a legend beside it naming two colours, one of which is not on
                screen. The width itself is still the real proportion. */}
            <div className="h-full min-w-[6px]" style={{ width: `${elapsed}%`, background: tone.bar }} />
            <div
              className="h-full flex-1"
              style={{
                backgroundImage: `repeating-linear-gradient(45deg, ${tone.stripe} 0 8px, transparent 8px 16px)`,
                backgroundColor: tone.stripeBase,
              }}
            />
          </div>

          <div className="mt-3 flex flex-wrap justify-between gap-4 text-sm">
            <div>
              <strong className="block font-semibold text-slate-900">{shortDate(subscription.trial_start || subscription.current_period_start)}</strong>
              <small className="text-slate-500">{subscription.trial_start ? 'Trial started' : 'Period started'}</small>
            </div>
            <div className="text-right">
              <strong className="block font-semibold text-slate-900">{finalLabel ? '—' : shortDate(subscription.trial_end || subscription.current_period_end)}</strong>
              <small className="text-slate-500">{finalLabel ? 'No further payment' : subscription.trial_end ? 'First payment' : 'Renews'}</small>
            </div>
          </div>
        </>
      )}

      <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{view.footer}</p>
    </Card>
  )
}
