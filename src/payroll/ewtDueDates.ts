// The payor's EWT calendar: for a quarter, BIR 0619-E for its first two
// months, the 1601-EQ with the Quarterly Alphalist of Payees and the 2307s
// to the payees; for its year, the list of payees who gave sworn
// declarations and the 1604-E. The rules and their sources are in law.ts
// (DEADLINES). A date on a weekend or a holiday is shown with a note, never
// moved (as on the filing calendar).

import { endOfMonth } from '../lib/manila'
import type { Quarter } from './ewt'
import { DEADLINES } from './law'

export interface EwtFilingClient {
  filing: 'manual' | 'efps'
  efpsGroup: 'A' | 'B' | 'C' | 'D' | 'E' | null
}

export interface EwtDue {
  label: string
  due: string
  basis: string
  note: string
}

export interface EwtDueDates {
  /** BIR 0619-E for the quarter's first and second months */
  monthly: [string, string]
  /** BIR 1601-EQ and the Quarterly Alphalist of Payees */
  return1601eq: string
  /** the signed BIR 2307s to the payees */
  form2307: string
  /** the quarter's filings and the year's, in date order */
  rows: EwtDue[]
}

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** the YYYY-MM month after a YYYY-MM month */
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4))
  const mm = Number(m.slice(5, 7))
  return mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`
}
const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' })

export function ewtDueDates(
  quarter: Quarter,
  client: EwtFilingClient = { filing: 'manual', efpsGroup: null },
  holidays: { holiday_date: string; name: string }[] = [],
): EwtDueDates {
  const D = DEADLINES
  const efps = client.filing === 'efps' && client.efpsGroup
  const monthly = quarter.months.slice(0, 2).map(
    (m) => `${nextMonth(m)}-${pad(efps ? D.ewt0619eEfpsDays.value[client.efpsGroup as 'A'] : D.ewt0619eManualDay.value)}`,
  ) as [string, string]
  const return1601eq = endOfMonth(`${nextMonth(quarter.months[2])}-01`)
  const form2307 = addDaysIso(quarter.end, D.form2307DaysAfterQuarter.value)
  const year = Number(quarter.start.slice(0, 4))
  const rows: EwtDue[] = [
    ...monthly.map((due, k) => ({
      label: `BIR 0619-E for ${monthName(quarter.months[k])}`,
      due,
      basis: efps ? `eFPS group ${client.efpsGroup}: ${D.ewt0619eEfpsDays.source}` : D.ewt0619eManualDay.source,
      note: client.filing === 'efps' && !client.efpsGroup ? 'Set the eFPS group in Client Settings' : '',
    })),
    { label: `BIR 2307s to the payees for ${quarter.label}`, due: form2307, basis: D.form2307DaysAfterQuarter.source, note: '' },
    { label: `BIR 1601-EQ and the alphalist of payees for ${quarter.label}`, due: return1601eq, basis: D.ewt1601eqLastDayOfNextMonth.source, note: '' },
    {
      label: `List of payees with sworn declarations for ${year}, to the RDO`,
      due: `${year}-01-${pad(D.payeeDeclarationsJanuaryDay.value)}`,
      basis: D.payeeDeclarationsJanuaryDay.source,
      note: 'A declaration received later: within 15 days after the month it came in',
    },
    { label: `BIR 1604-E for ${year}`, due: `${year + 1}-03-${pad(D.form1604eMarchDay.value)}`, basis: D.form1604eMarchDay.source, note: '' },
  ]
  const holidayOn = new Map(holidays.map((h) => [h.holiday_date, h.name]))
  return {
    monthly,
    return1601eq,
    form2307,
    rows: rows
      .map((r) => {
        const day = new Date(`${r.due}T00:00:00Z`).getUTCDay()
        const holiday = holidayOn.get(r.due)
        const why = holiday ? `Falls on ${holiday}` : day === 0 || day === 6 ? `Falls on a ${WEEKDAYS[day]}` : ''
        return why ? { ...r, note: r.note ? `${r.note}. ${why}` : why } : r
      })
      .sort((a, b) => a.due.localeCompare(b.due)),
  }
}
