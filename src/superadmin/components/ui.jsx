import { STATUS_TONE } from '../lib/format'

// Presentational primitives only. Data hooks and formatters live in ../lib so
// this file stays a clean Fast Refresh boundary.

export function StatusBadge({ status = 'unconfigured' }) {
  const tone = STATUS_TONE[status] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${tone}`}>
      {String(status).replace(/_/g, ' ')}
    </span>
  )
}

export function Card({ children, className = '', as: Tag = 'article' }) {
  return <Tag className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>{children}</Tag>
}

export function SectionHead({ eyebrow, title, description, action }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <p className="text-xs font-semibold tracking-[.16em] text-indigo-600">{eyebrow}</p>}
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-2 text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'text-indigo-600 bg-indigo-50', trend }) {
  return (
    <article className="stat-card rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        {Icon ? <span className={`grid h-10 w-10 place-items-center rounded-lg ${tone}`}><Icon size={19} /></span> : <span />}
        {trend && (
          <span className={`text-xs font-semibold ${trend.direction === 'up' ? 'text-emerald-600' : trend.direction === 'down' ? 'text-red-600' : 'text-slate-400'}`}>
            {trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '•'} {trend.change}%
          </span>
        )}
      </div>
      <p className="mt-5 text-sm font-medium text-slate-500">{label}</p>
      <strong className="mt-1 block text-2xl tracking-tight text-slate-900">{value}</strong>
      {hint && <small className="mt-2 block text-xs text-slate-400">{hint}</small>}
    </article>
  )
}

export function EmptyState({ title, description, icon: Icon, action }) {
  return (
    <div className="grid min-h-56 place-items-center p-8 text-center">
      <div>
        {Icon && <Icon className="mx-auto text-indigo-300" size={30} />}
        <h2 className="mt-4 font-semibold text-slate-800">{title}</h2>
        {description && <p className="mt-2 max-w-sm text-sm text-slate-500">{description}</p>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  )
}

export function Notice({ tone = 'info', children, action }) {
  const tones = {
    info: 'border-slate-200 bg-slate-50 text-slate-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-700',
  }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-sm ${tones[tone] || tones.info}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>{children}</div>
      {action}
    </div>
  )
}

export function Spinner({ label = 'Loading' }) {
  return (
    <div className="flex items-center gap-3 p-8 text-sm font-medium text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />
      {label}…
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <label className="grid gap-2 text-sm font-medium text-slate-700">
      {label}
      {children}
      {hint && <small className="font-normal text-slate-400">{hint}</small>}
    </label>
  )
}

export const inputClass = 'h-11 rounded-lg border border-slate-300 px-3 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50 disabled:text-slate-400'
