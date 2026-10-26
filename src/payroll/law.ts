// Legal values the payroll applies, each with the date it took effect and
// its source. Rates and ceilings that agencies revise by regulation (tax
// tables, contributions, de minimis ceilings) are versioned data in the
// database; this file holds the rest, so no legal number sits in the logic.

/** A legal value: what it is, since when, and where it comes from. */
export interface LegalValue<T = number> {
  value: T
  /** date the rule took effect (YYYY-MM-DD) */
  effectiveFrom: string
  /** law, regulation or circular, with the section */
  source: string
}

/** Labor Code (PD 442) took effect six months after its promulgation on 1 May 1974 (Art. 2). */
const LABOR_CODE = '1974-11-01'

/** Premium pay as a fraction of the regular daily wage, on top of the 100% for the day's work. */
export const PREMIUM = {
  restDay: { value: 0.3, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 93(a)' },
  specialDay: { value: 0.3, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 93(c)' },
  specialDayOnRestDay: { value: 0.5, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 93(c)' },
  /** a regular holiday pays 200%: the day's wage plus another 100% */
  regularHoliday: { value: 1, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 94(b)' },
  /** worked on the rest day: 30% more of the 200% holiday rate */
  regularHolidayOnRestDay: {
    value: 0.3,
    effectiveFrom: LABOR_CODE,
    source: 'Labor Code Art. 93(c); Omnibus Rules Book III, Rule IV, Sec. 4',
  },
} satisfies Record<string, LegalValue>

/** Overtime premium on the hourly rate of the day (Labor Code Art. 87). */
export const OVERTIME = {
  ordinaryDay: { value: 0.25, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 87' },
  /** rest days, special days and holidays: 30% of the hourly rate on that day */
  premiumDay: { value: 0.3, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 87' },
} satisfies Record<string, LegalValue>

/** Leave rules the payroll applies. */
export const LEAVE = {
  /** an employer granting at least this many days of paid vacation leave a year is outside the service incentive leave */
  vacationLeaveOutsideSil: { value: 5, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 95(b)' },
} satisfies Record<string, LegalValue>
