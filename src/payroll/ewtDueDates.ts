// The payor's EWT calendar: for a quarter, BIR 0619-E for its first two
// months, the 1601-EQ with the Quarterly Alphalist of Payees and the 2307s
// to the payees; for its year, the list of payees who gave sworn
// declarations and the 1604-E. The rules and their sources are in law.ts
// (DEADLINES). A client can replace a date (a BIR extension: ewt_due_dates);
// a date on a weekend or a holiday is shown with a note, never moved (as on
// the filing calendar).

import { addDays, endOfMonth } from '../lib/manila'
import { withDayNote } from './dueDates'
import { quarterOf, type Quarter } from './ewt'
import { DEADLINES } from './law'

export type EwtFiling = '0619e' | '2307' | '1601eq' | 'declarations' | '1604e'

export interface EwtFilingClient {
  filing: 'manual' | 'efps'
  efpsGroup: 'A' | 'B' | 'C' | 'D' | 'E' | null
}

export interface EwtDueOverride {
  filing: EwtFiling
  /** the month a 0619-E covers, the first day of a 2307's or 1601-EQ's quarter, 1 January for the year's filings */
  period: string
  due_date: string
  note: string
}

export interface EwtDue {
  filing: EwtFiling
  period: string
  label: string
  due: string
  basis: string
  note: string
  overridden?: boolean
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
/** the YYYY-MM month after a YYYY-MM month */
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4))
  const mm = Number(m.slice(5, 7))
  return mm === 12 ? `${y + 1}-01` : `${y}-${pad(mm + 1)}`
}
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function quarterRows(quarter: Quarter, client: EwtFilingClient): EwtDue[] {
  const D = DEADLINES
  const efps = client.filing === 'efps' && client.efpsGroup
  return [
    ...quarter.months.slice(0, 2).map((m) => ({
      filing: '0619e' as const,
      period: `${m}-01`,
      label: `BIR 0619-E for ${monthName(m)}`,
      due: `${nextMonth(m)}-${pad(efps ? D.ewt0619eEfpsDays.value[client.efpsGroup as 'A'] : D.ewt0619eManualDay.value)}`,
      basis: efps ? `eFPS group ${client.efpsGroup}: ${D.ewt0619eEfpsDays.source}` : D.ewt0619eManualDay.source,
      note: client.filing === 'efps' && !client.efpsGroup ? 'Set the eFPS group in Client Settings' : '',
    })),
    {
      filing: '2307',
      period: quarter.start,
      label: `BIR 2307s to the payees for ${quarter.label}`,
      due: addDays(quarter.end, D.form2307DaysAfterQuarter.value),
      basis: D.form2307DaysAfterQuarter.source,
      note: '',
    },
    {
      filing: '1601eq',
      period: quarter.start,
      label: `BIR 1601-EQ and the alphalist of payees for ${quarter.label}`,
      due: endOfMonth(`${nextMonth(quarter.months[2])}-01`),
      basis: D.ewt1601eqLastDayOfNextMonth.source,
      note: '',
    },
  ]
}

function yearRows(year: number): EwtDue[] {
  const D = DEADLINES
  return [
    {
      filing: 'declarations',
      period: `${year}-01-01`,
      label: `List of payees with sworn declarations for ${year}, to the RDO`,
      due: `${year}-01-${pad(D.payeeDeclarationsJanuaryDay.value)}`,
      basis: D.payeeDeclarationsJanuaryDay.source,
      note: 'A declaration received later: within 15 days after the month it came in',
    },
    { filing: '1604e', period: `${year}-01-01`, label: `BIR 1604-E for ${year}`, due: `${year + 1}-03-${pad(D.form1604eMarchDay.value)}`, basis: D.form1604eMarchDay.source, note: '' },
  ]
}

function finish(rows: EwtDue[], holidays: { holiday_date: string; name: string }[], overrides: EwtDueOverride[]): EwtDue[] {
  return rows
    .map((r) => {
      const o = overrides.find((x) => x.filing === r.filing && x.period === r.period)
      return o ? { ...r, due: o.due_date, note: o.note, overridden: true } : withDayNote(r, holidays)
    })
    .sort((a, b) => a.due.localeCompare(b.due) || a.label.localeCompare(b.label))
}

export function ewtDueDates(
  quarter: Quarter,
  client: EwtFilingClient = { filing: 'manual', efpsGroup: null },
  holidays: { holiday_date: string; name: string }[] = [],
  overrides: EwtDueOverride[] = [],
): EwtDueDates {
  const rows = finish([...quarterRows(quarter, client), ...yearRows(Number(quarter.start.slice(0, 4)))], holidays, overrides)
  const dueOf = (filing: EwtFiling, period: string) => rows.find((r) => r.filing === filing && r.period === period)?.due ?? ''
  return {
    monthly: [dueOf('0619e', `${quarter.months[0]}-01`), dueOf('0619e', `${quarter.months[1]}-01`)],
    return1601eq: dueOf('1601eq', quarter.start),
    form2307: dueOf('2307', quarter.start),
    rows,
  }
}

/** A year's EWT filings: its four quarters and the year's own. */
export function ewtYearCalendar(
  year: number,
  client: EwtFilingClient,
  holidays: { holiday_date: string; name: string }[] = [],
  overrides: EwtDueOverride[] = [],
): EwtDue[] {
  const quarters = [1, 4, 7, 10].map((m) => quarterOf(`${year}-${pad(m)}-01`))
  return finish([...quarters.flatMap((q) => quarterRows(q, client)), ...yearRows(year)], holidays, overrides)
}
