// The payor's EWT calendar for a quarter: BIR 0619-E for its first two
// months, the 1601-EQ with the Quarterly Alphalist of Payees, and the 2307s
// to the payees. The rules and their sources are in law.ts (DEADLINES); a
// date on a weekend or a holiday is shown as is, never moved.

import { endOfMonth } from '../lib/manila'
import type { Quarter } from './ewt'
import { DEADLINES } from './law'

export interface EwtDueDates {
  /** BIR 0619-E for the quarter's first and second months */
  monthly: [string, string]
  /** BIR 1601-EQ and the Quarterly Alphalist of Payees */
  return1601eq: string
  /** the signed BIR 2307s to the payees */
  form2307: string
  note: string
}

const pad = (n: number) => String(n).padStart(2, '0')
/** the first day of the month after a YYYY-MM month */
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4))
  const mm = Number(m.slice(5, 7))
  return mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`
}
const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

export function ewtDueDates(quarter: Quarter): EwtDueDates {
  const day = DEADLINES.ewt0619eManualDay.value
  const after = nextMonth(quarter.months[2])
  return {
    monthly: [`${nextMonth(quarter.months[0])}-${pad(day)}`, `${nextMonth(quarter.months[1])}-${pad(day)}`],
    return1601eq: endOfMonth(`${after}-01`),
    form2307: addDaysIso(quarter.end, DEADLINES.form2307DaysAfterQuarter.value),
    note: `Due dates: 0619-E by the ${day}th of the following month (${DEADLINES.ewt0619eManualDay.source}); 1601-EQ with the alphalist by the last day of the month after the quarter (${DEADLINES.ewt1601eqLastDayOfNextMonth.source}); 2307s within ${DEADLINES.form2307DaysAfterQuarter.value} days after the quarter (${DEADLINES.form2307DaysAfterQuarter.source}). A date on a weekend or holiday is shown as is.`,
  }
}
