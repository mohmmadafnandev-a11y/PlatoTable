// Pure formatting helpers. Kept out of the component files so React Fast
// Refresh keeps working (a module may not mix component and non-component
// exports).

export const STATUSES = ['trialing', 'active', 'past_due', 'suspended', 'canceled']

export const STATUS_TONE = {
  active: 'bg-emerald-100 text-emerald-700',
  trialing: 'bg-indigo-100 text-indigo-700',
  past_due: 'bg-amber-100 text-amber-800',
  suspended: 'bg-red-100 text-red-700',
  canceled: 'bg-slate-100 text-slate-600',
  unconfigured: 'bg-slate-100 text-slate-600',
}

export function money(amount, currency = 'PKR') {
  const value = Number(amount ?? 0)
  const code = (currency || 'PKR').toUpperCase()
  try {
    // Rupees are pinned to en-PK so the figure reads "Rs 2,000" the way the price
    // is spoken here, rather than whatever symbol an arbitrary browser locale
    // picks for PKR.
    return new Intl.NumberFormat(code === 'PKR' ? 'en-PK' : undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value)
  } catch {
    // An unknown currency code should not blank out a revenue figure.
    return `${code} ${value.toLocaleString()}`
  }
}

export function plainNumber(value) {
  return Number(value ?? 0).toLocaleString()
}

export function shortDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function dateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function relativeTime(value) {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return shortDate(value)
}

export function daysBetween(from, to = Date.now()) {
  if (!from) return null
  const start = new Date(from).getTime()
  if (Number.isNaN(start)) return null
  return Math.ceil((start - to) / 86400000)
}

/** Month labels for the revenue chart: "2026-03" becomes "Mar". */
export function monthLabel(key) {
  const [, month] = String(key).split('-')
  const index = Number(month) - 1
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][index] || key
}

/** Trigger a CSV download without touching the DOM outside this call. */
export function downloadCsv(filename, rows, columns) {
  const escape = (cell) => {
    const text = cell === null || cell === undefined ? '' : String(cell)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [
    columns.map((column) => escape(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => escape(column.value(row))).join(',')),
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Total collected, and how it moved against the previous month. */
export function revenueTrend(revenue = {}) {
  const current = Number(revenue.this_month ?? 0)
  const previous = Number(revenue.last_month ?? 0)
  if (!previous) return { change: current > 0 ? 100 : 0, direction: current > 0 ? 'up' : 'flat' }
  const change = ((current - previous) / previous) * 100
  return { change: Math.abs(Math.round(change)), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' }
}
