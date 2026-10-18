import { Card } from './ui'
import { shortDate } from '../lib/format'
import { billingPhases, PHASE_META } from '../../../shared/periods.js'
import { progressView } from '../lib/subscription-progress'

// Where a subscription is in its life, drawn as a bar.
//
// Three phases, three colours — the same language the restaurant panel uses:
//
//   white   the free trial
//   green   the paid period
//   yellow  backup days (the free window after a period ends unpaid)
//
// A phase behind us is solid, the live one is filled up to today, and the ones
// ahead are hatched. The text beside the bar still comes from
// ../lib/subscription-progress.js; the bar itself comes from ../../../shared/
// periods.js, which the restaurant panel reads too, so the two panels cannot
// draw the same subscription differently.

const TONES = {
  indigo: { headline: 'text-slate-900', pay: 'text-indigo-700' },
  warning: { headline: 'text-amber-900', pay: 'text-amber-700' },
  danger: { headline: 'text-red-800', pay: 'text-red-700' },
  slate: { headline: 'text-slate-900', pay: 'text-slate-700' },
}

const PHASE_STYLE = {
  trial: { chip: 'border border-slate-300 bg-white', fill: '#ffffff', fillEdge: 'inset 0 0 0 1px #d6dde6', stripe: 'rgba(100,116,139,.28)', base: '#f1f5f9' },
  plan: { chip: 'bg-emerald-500', fill: '#2e8b57', fillEdge: 'none', stripe: 'rgba(46,139,87,.24)', base: '#f0fdf4' },
  backup: { chip: 'bg-amber-400', fill: '#e0ad18', fillEdge: 'none', stripe: 'rgba(224,173,24,.3)', base: '#fefce8' },
}

/**
 * The card itself. `subscription` is a row from `subscriptions` or the nested
 * object the restaurant read model returns — both carry the same field names.
 */
export default function SubscriptionProgress({ subscription, className = '' }) {
  if (!subscription) return null
  const view = progressView(subscription)
  const tone = TONES[view.tone] || TONES.indigo
  const { phases, current } = billingPhases(subscription)
  const first = phases[0]
  const last = phases[phases.length - 1]

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

      {phases.length > 0 && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {phases.map((phase) => (
              <span key={phase.kind} className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                <span className={`h-2.5 w-2.5 rounded-[3px] ${PHASE_STYLE[phase.kind].chip}`} />
                {PHASE_META[phase.kind].label}{phase.state === 'current' ? ' · now' : ''}
              </span>
            ))}
          </div>

          {/* One bar, one segment per phase. Behind is solid, the live phase is
              filled up to today, ahead is striped — so "where is this restaurant
              and what comes next" reads without doing arithmetic. */}
          <div className="mt-3 flex h-12 w-full overflow-hidden rounded-lg border border-slate-200" role="img" aria-label="Free trial, paid period and backup days">
            {phases.map((phase) => {
              const style = PHASE_STYLE[phase.kind]
              const ratio = phase.state === 'past' ? 1 : phase.state === 'current' ? (current?.ratio ?? 0) : 0
              return (
                <div
                  key={phase.kind}
                  className="relative h-full"
                  style={{
                    flexGrow: Math.max(phase.days, 0.6),
                    borderLeft: '2px solid #fff',
                    backgroundColor: style.base,
                    backgroundImage: phase.state === 'past'
                      ? 'none'
                      : `repeating-linear-gradient(45deg, ${style.stripe} 0 8px, transparent 8px 16px)`,
                  }}
                >
                  <div
                    className="absolute inset-y-0 left-0 min-w-[4px]"
                    style={{ width: `${Math.round(ratio * 100)}%`, background: style.fill, boxShadow: style.fillEdge === 'none' ? undefined : style.fillEdge }}
                  />
                </div>
              )
            })}
          </div>

          <div className="mt-3 flex flex-wrap justify-between gap-4 text-sm">
            <div>
              <strong className="block font-semibold text-slate-900">{shortDate(new Date(first.start).toISOString())}</strong>
              <small className="text-slate-500">{PHASE_META[first.kind].label} started</small>
            </div>
            <div className="text-right">
              <strong className="block font-semibold text-slate-900">{last ? shortDate(new Date((current?.end ?? last.end)).toISOString()) : '—'}</strong>
              <small className="text-slate-500">
                {!current ? 'Coverage ended'
                  : current.kind === 'trial' ? 'First payment'
                    : current.kind === 'backup' ? 'Menu goes offline'
                      : 'Next payment'}
              </small>
            </div>
          </div>
        </>
      )}

      <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{view.footer}</p>
    </Card>
  )
}
