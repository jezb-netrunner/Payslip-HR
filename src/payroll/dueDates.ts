// The client's filing and payment calendar for a year (C9): BIR 1601-C,
// SSS, PhilHealth and Pag-IBIG every month, and the year-end BIR filings.
// The rules and their sources are in law.ts (DEADLINES). Each date can be
// replaced per year (extensions), and a date on a weekend or a holiday is
// shown with a note — never moved.

import { endOfMonth } from '../lib/manila'
import { DEADLINES } from './law'

export type Filing = '1601c' | 'sss' | 'philhealth' | 'pagibig' | 'refunds' | '2316_employees' | '1604c' | '2316_bir'

export interface FilingClient {
  filing: 'manual' | 'efps'
  efpsGroup: 'A' | 'B' | 'C' | 'D' | 'E' | null
  /** PhilHealth Employer Number: its last digit picks the payment window */
  philhealthEmployerNo: string
  /** Pag-IBIG: the day of the following month the client enters ('' when not set, O4) */
  pagibigDueDay: number | null
}

export interface DueDateOverride {
  filing: Filing
  period: string
  due_date: string
  note: string
}

export interface DueDate {
  filing: Filing
  /** the month a monthly filing covers, or 1 January of the tax year for a year-end filing */
  period: string
  /** YYYY-MM-DD ('' when the client hasn't entered it) */
  due: string
  /** start of a payment window (PhilHealth) */
  from?: string
  basis: string
  /** weekend or holiday, an extension's note, or what to enter */
  note: string
  overridden?: boolean
}

export const FILING_LABELS: Record<Filing, string> = {
  '1601c': 'BIR 1601-C (withholding tax on compensation)',
  sss: 'SSS contributions',
  philhealth: 'PhilHealth premiums',
  pagibig: 'Pag-IBIG contributions',
  refunds: 'Year-end refunds of over-withheld tax',
  '2316_employees': 'BIR 2316 to employees (separated employees: the last pay day)',
  '1604c': 'BIR 1604-C and alphalist',
  '2316_bir': 'BIR copies of the 2316s and the Annex F list',
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayOf = (y: number, m: number, d: number) => {
  const yy = m > 12 ? y + 1 : y
  const mm = m > 12 ? m - 12 : m
  return `${yy}-${pad(mm)}-${pad(Math.min(d, Number(endOfMonth(`${yy}-${pad(mm)}-01`).slice(8, 10))))}`
}
const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function filingCalendar(
  year: number,
  client: FilingClient,
  holidays: { holiday_date: string; name: string }[],
  overrides: DueDateOverride[] = [],
): DueDate[] {
  const rows: DueDate[] = []
  const D = DEADLINES
  const digit = Number((client.philhealthEmployerNo.match(/\d(?=\D*$)/) ?? [''])[0])
  const window = Number.isFinite(digit) && client.philhealthEmployerNo.trim()
    ? D.philhealthWindows.value.find((w) => w.digits.includes(digit))
    : undefined
  for (let m = 1; m <= 12; m++) {
    const period = `${year}-${pad(m)}-01`
    const monthEnd = endOfMonth(period)
    rows.push(
      client.filing === 'efps' && client.efpsGroup
        ? {
            filing: '1601c', period, due: addDaysIso(monthEnd, D.bir1601cEfpsDays.value[client.efpsGroup]),
            basis: `eFPS group ${client.efpsGroup}: ${D.bir1601cEfpsDays.source}`, note: '',
          }
        : {
            filing: '1601c', period,
            due: dayOf(year, m + 1, m === 12 ? D.bir1601cDecemberDay.value : D.bir1601cManualDay.value),
            basis: D.bir1601cManualDay.source, note: client.filing === 'efps' ? 'Set the eFPS group in Client Settings' : '',
          },
    )
    rows.push({ filing: 'sss', period, due: endOfMonth(dayOf(year, m + 1, 1)), basis: D.sssLastDayOfNextMonth.source, note: '' })
    rows.push(
      window
        ? { filing: 'philhealth', period, from: dayOf(year, m + 1, window.from), due: dayOf(year, m + 1, window.to), basis: D.philhealthWindows.source, note: '' }
        : { filing: 'philhealth', period, due: '', basis: D.philhealthWindows.source, note: 'Enter the PhilHealth employer number in Client Settings' },
    )
    rows.push({
      filing: 'pagibig', period,
      due: client.pagibigDueDay ? dayOf(year, m + 1, client.pagibigDueDay) : '',
      basis: 'Entered by the client (HDMF circular not verified)',
      note: client.pagibigDueDay ? '' : 'Enter the Pag-IBIG due day in Client Settings',
    })
  }
  const yearStart = `${year}-01-01`
  rows.push(
    { filing: 'refunds', period: yearStart, due: dayOf(year + 1, 1, D.refundsJanuaryDay.value), basis: D.refundsJanuaryDay.source, note: '' },
    { filing: '2316_employees', period: yearStart, due: dayOf(year + 1, 1, D.form2316EmployeesJanuaryDay.value), basis: D.form2316EmployeesJanuaryDay.source, note: '' },
    { filing: '1604c', period: yearStart, due: dayOf(year + 1, 1, D.form1604cJanuaryDay.value), basis: D.form1604cJanuaryDay.source, note: '' },
    { filing: '2316_bir', period: yearStart, due: dayOf(year + 1, 2, D.form2316BirFebruaryDay.value), basis: D.form2316BirFebruaryDay.source, note: '' },
  )
  return rows.map((r) => {
    const o = overrides.find((x) => x.filing === r.filing && x.period === r.period)
    const row = o ? { ...r, due: o.due_date, overridden: true, note: o.note } : r
    return !row.due || o ? row : withDayNote(row, holidays)
  })
}

/** A due date on a weekend or a holiday keeps its date and says so in its note. */
export function withDayNote<T extends { due: string; note: string }>(row: T, holidays: { holiday_date: string; name: string }[]): T {
  const day = new Date(`${row.due}T00:00:00Z`).getUTCDay()
  const holiday = holidays.find((h) => h.holiday_date === row.due)?.name
  const why = holiday ? `Falls on ${holiday}` : day === 0 || day === 6 ? `Falls on a ${WEEKDAYS[day]}` : ''
  return why ? { ...row, note: row.note ? `${row.note}. ${why}` : why } : row
}
