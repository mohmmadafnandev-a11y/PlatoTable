import { useId } from 'react'
import { monthLabel } from '../lib/format'

// Dependency-free charts. Recharts is one of the libraries the PRD mentions,
// but it is not installed and no library may be added without approval, so
// these are inline SVG that scale with their container.

const isZero = (points) => !points.length || points.every((point) => !Number(point.value))

export function AreaChart({ points = [], currency = 'USD', format, height = 200 }) {
  const gradientId = useId().replace(/:/g, '')
  if (isZero(points)) return null

  const values = points.map((point) => Number(point.value) || 0)
  const max = Math.max(...values, 1)
  const width = 620
  const paddingTop = 18
  const paddingBottom = 26
  const innerHeight = height - paddingTop - paddingBottom
  const step = values.length > 1 ? (width - 16) / (values.length - 1) : 0
  const xAt = (index) => 8 + index * step
  const yAt = (value) => paddingTop + innerHeight - (value / max) * innerHeight
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(' ')
  const area = `${line} L${xAt(values.length - 1).toFixed(1)},${paddingTop + innerHeight} L${xAt(0).toFixed(1)},${paddingTop + innerHeight} Z`
  const peak = Math.max(...values)
  const label = format || ((value) => `${currency} ${value.toLocaleString()}`)

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`Revenue chart, peak ${label(peak)}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f46e5" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((ratio) => (
          <line
            key={ratio}
            x1="8"
            x2={width - 8}
            y1={paddingTop + innerHeight * ratio}
            y2={paddingTop + innerHeight * ratio}
            stroke="#e2e8f0"
            strokeWidth="1"
            strokeDasharray={ratio === 1 ? '0' : '4 6'}
          />
        ))}

        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="#4f46e5" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

        {values.map((value, index) => (
          value === peak && value > 0
            ? <circle key={index} cx={xAt(index)} cy={yAt(value)} r="4.5" fill="#fff" stroke="#4f46e5" strokeWidth="2.5" />
            : null
        ))}

        {points.map((point, index) => (
          index % 2 === 0 || index === points.length - 1
            ? (
              <text key={point.label} x={xAt(index)} y={height - 6} textAnchor="middle" className="fill-slate-400" style={{ fontSize: 11 }}>
                {monthLabel(point.label)}
              </text>
            )
            : null
        ))}
      </svg>
    </div>
  )
}

export function BarChart({ points = [], height = 120, ariaLabel = 'Daily series' }) {
  if (isZero(points)) return null
  const values = points.map((point) => Number(point.value) || 0)
  const max = Math.max(...values, 1)

  return (
    <div className="flex items-end gap-[3px]" style={{ height }} role="img" aria-label={ariaLabel}>
      {points.map((point) => {
        const value = Number(point.value) || 0
        const percent = Math.max((value / max) * 100, value ? 6 : 2)
        return (
          <span
            key={point.label}
            title={`${point.label}: ${value}`}
            className={`flex-1 rounded-sm transition-all ${value ? 'bg-indigo-500 hover:bg-indigo-600' : 'bg-slate-100'}`}
            style={{ height: `${percent}%` }}
          />
        )
      })}
    </div>
  )
}

export function PlanDistribution({ rows = [] }) {
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  if (!total) return null
  const tones = ['bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-red-500', 'bg-slate-400']

  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {rows.map((row, index) => (
          row.count > 0
            ? <span key={row.label} className={tones[index % tones.length]} style={{ width: `${(row.count / total) * 100}%` }} title={`${row.label}: ${row.count}`} />
            : null
        ))}
      </div>
      <ul className="mt-4 grid gap-2">
        {rows.map((row, index) => (
          <li key={row.label} className="flex items-center gap-3 text-sm">
            <span className={`h-2.5 w-2.5 rounded-full ${tones[index % tones.length]}`} />
            <span className="capitalize text-slate-600">{row.label.replace(/_/g, ' ')}</span>
            <strong className="ml-auto text-slate-900">{row.count}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}
