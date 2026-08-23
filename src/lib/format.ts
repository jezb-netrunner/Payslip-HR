const peso = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
})

const pesoWhole = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  maximumFractionDigits: 0,
})

const num = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2 })

export function money(v: number | null | undefined): string {
  return peso.format(v ?? 0)
}

export function moneyWhole(v: number | null | undefined): string {
  return pesoWhole.format(v ?? 0)
}

export function fmtNum(v: number | null | undefined): string {
  return num.format(v ?? 0)
}

/** 2026-08-23 -> Aug 23, 2026 */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(`${d.slice(0, 10)}T00:00:00`) : d
  return date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** timestamptz -> local (Asia/Manila) date + time */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** timestamptz -> Manila time only, e.g. 8:04 AM */
export function fmtTime(d: string | Date | null | undefined): string {
  if (!d) return '—'
  const date = typeof d === 'string' ? new Date(d) : d
  return date.toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function fmtHours(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function fullName(e: {
  first_name: string
  middle_name?: string | null
  last_name: string
  suffix?: string | null
}): string {
  return [e.first_name, e.middle_name, e.last_name, e.suffix].filter(Boolean).join(' ')
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

/** Period label, e.g. "Aug 1–15, 2026" */
export function fmtPeriod(start: string, end: string): string {
  const s = new Date(`${start.slice(0, 10)}T00:00:00`)
  const e = new Date(`${end.slice(0, 10)}T00:00:00`)
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()
  const sm = s.toLocaleDateString('en-PH', { month: 'short' })
  const em = e.toLocaleDateString('en-PH', { month: 'short' })
  if (sameMonth) return `${sm} ${s.getDate()}–${e.getDate()}, ${e.getFullYear()}`
  return `${sm} ${s.getDate()} – ${em} ${e.getDate()}, ${e.getFullYear()}`
}
