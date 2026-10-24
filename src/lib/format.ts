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

/** "13:05" -> "1:05 PM" (plain ASCII: also printed in PDFs, whose fonts lack narrow spaces) */
export function clock12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
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

/** First and last name initials ("Jose Miguel Santos Dela Cruz" → "JD"). */
export function personInitials(e: { first_name: string; last_name: string }): string {
  return `${e.first_name.trim()[0] ?? ''}${e.last_name.trim()[0] ?? ''}`.toUpperCase()
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

/** "3 employees", "1 employee" */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

/** "2026-10-01" (payroll month) -> "October 2026" */
export function fmtMonth(d: string | null | undefined): string {
  if (!d) return '—'
  return new Date(`${d.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
}

/**
 * Reads a client TIN as typed — "123-456-789", "123456789", or with the
 * branch appended ("123-456-789-00000") — into the 9-digit TIN and the
 * branch code the entities table stores separately. null = unreadable.
 */
export function splitClientTin(tin: string, branch: string): { tin: string; branch: string } | null {
  const d = tin.replace(/\D/g, '')
  const typedBranch = d.slice(9)
  const br = (typedBranch || branch.replace(/\D/g, '')) || '00000'
  if (!/^[0-9]{3,5}$/.test(br)) return null
  if (!d) return { tin: '', branch: br }
  if (d.length !== 9 && (d.length < 12 || d.length > 14)) return null
  return { tin: `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}`, branch: br }
}

/** Format a TIN as 000-000-000[-00000]. */
export function fmtTin(tin: string | null | undefined, branch?: string | null): string {
  const digits = (tin ?? '').replace(/\D/g, '')
  if (!digits) return ''
  const base = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)].filter(Boolean).join('-')
  const br = branch ?? (digits.length > 9 ? digits.slice(9) : '')
  return br ? `${base}-${br}` : base
}
