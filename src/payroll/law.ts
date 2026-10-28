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

/** PhilHealth: the national government pays the employee half for solo parents and PWDs. */
export const PHILHEALTH_NG = {
  /** a solo parent's first month: the first month PhilHealth billing shows the tag, not earlier than this */
  soloParentFromMonth: {
    value: '2026-10-01',
    effectiveFrom: '2026-09-26',
    source: 'PhilHealth Circular 2026-0015 Secs. V.C, V.E.5, V.F.2 (effective 26 Sep 2026) and its Q&A; RA 11861',
  },
} satisfies Record<string, LegalValue<string>>

/** Holiday pay (Labor Code Art. 94). */
export const HOLIDAY_PAY = {
  /** retail and service establishments regularly employing fewer workers than this are exempt from holiday pay */
  exemptBelowWorkers: { value: 10, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 94(a); Omnibus Rules Book III, Rule IV, Sec. 1' },
} satisfies Record<string, LegalValue>

/**
 * Filing and payment deadlines. Agencies extend them now and then: each
 * client can replace a date for a year (filing_due_dates); a date that
 * falls on a weekend or holiday is shown with a note, not moved.
 */
export const DEADLINES = {
  /** 1601-C filed manually: day of the following month (January to November) */
  bir1601cManualDay: { value: 10, effectiveFrom: '2018-01-01', source: 'BIR Form 1601-C (January 2018 ENCS) page' },
  /** December's 1601-C filed manually: day of January */
  bir1601cDecemberDay: { value: 15, effectiveFrom: '2018-01-01', source: 'BIR Form 1601-C (January 2018 ENCS) page' },
  /** 1601-C on eFPS: days after the month's end for groups A to E */
  bir1601cEfpsDays: { value: { A: 15, B: 14, C: 13, D: 12, E: 11 }, effectiveFrom: '2002-12-01', source: 'BIR Form 1601-C page; RR 26-2002' },
  /** year-end refunds of over-withheld tax: day of January of the next year */
  refundsJanuaryDay: { value: 25, effectiveFrom: '2018-01-01', source: 'NIRC Sec. 79(F)' },
  /** BIR Form 2316 to employees: day of January (on separation, the last pay day) */
  form2316EmployeesJanuaryDay: { value: 31, effectiveFrom: '2018-01-01', source: 'NIRC Sec. 83(A)' },
  /** BIR Form 1604-C and the alphalist: day of January */
  form1604cJanuaryDay: { value: 31, effectiveFrom: '2018-01-01', source: 'NIRC Sec. 83(B); BIR Form 1604-C (January 2018 ENCS) page' },
  /** BIR copies of the 2316s and the Annex F list: day of February */
  form2316BirFebruaryDay: { value: 28, effectiveFrom: '2018-01-01', source: 'RR 2-98 Sec. 2.83.1 as amended by RR 11-2018' },
  /** BIR 0619-E (EWT of a quarter's first two months), filed manually: day of the following month */
  ewt0619eManualDay: { value: 10, effectiveFrom: '2018-01-01', source: 'BIR Form 0619-E; RR 2-98 Sec. 2.58(A)(2) as amended by RR 11-2018' },
  /** BIR 1601-EQ with the Quarterly Alphalist of Payees: the last day of the month after the quarter */
  ewt1601eqLastDayOfNextMonth: { value: true, effectiveFrom: '2018-01-01', source: 'BIR Form 1601-EQ (January 2019 ENCS); RR 2-98 Sec. 2.58(A)(2) as amended by RR 11-2018' },
  /** BIR 2307 to the payee: days after the close of the quarter */
  form2307DaysAfterQuarter: { value: 20, effectiveFrom: '2018-01-01', source: 'RR 2-98 Sec. 2.58.3(B) as amended' },
  /** SSS (regular employer): the last day of the month after the applicable month */
  sssLastDayOfNextMonth: { value: true, effectiveFrom: '2019-01-01', source: 'SSS release citing SSS Circular 2019-012' },
  /** PhilHealth: by the last digit of the employer number, windows in the following month */
  philhealthWindows: {
    value: [{ digits: [0, 1, 2, 3, 4], from: 11, to: 15 }, { digits: [5, 6, 7, 8, 9], from: 16, to: 20 }],
    effectiveFrom: '2020-01-01',
    source: 'PhilHealth employer payment schedule (pay_procedures page)',
  },
} satisfies Record<string, LegalValue<unknown>>

/** Hours of work (Labor Code Book III, Title I). */
export const HOURS = {
  /** normal hours of work a day; a longer day is a compressed-workweek shift */
  normalHoursPerDay: { value: 8, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 83' },
  /** night shift differential: at least 10% of the regular wage for each hour from 10pm to 6am */
  nightDifferentialMinimum: { value: 0.1, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 86' },
  nightShiftStartMinute: { value: 22 * 60, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 86' },
  nightShiftHours: { value: 8, effectiveFrom: LABOR_CODE, source: 'Labor Code Art. 86 (10pm to 6am)' },
  /** rest periods ("coffee breaks") of 5 to 20 minutes are hours worked */
  compensableRestMinutes: { value: 20, effectiveFrom: LABOR_CODE, source: 'Omnibus Rules Book III, Rule I, Sec. 7' },
  /** a compressed-workweek day: 12 hours of work at most */
  compressedDayMinutes: { value: 12 * 60, effectiveFrom: '2004-12-02', source: 'DOLE Department Advisory 02-04' },
  /** a compressed workweek: fewer than six workdays, 48 normal hours at most */
  compressedWeekDays: { value: 5, effectiveFrom: '2004-12-02', source: 'DOLE Department Advisory 02-04' },
  compressedWeekMinutes: { value: 48 * 60, effectiveFrom: '2004-12-02', source: 'DOLE Department Advisory 02-04' },
} satisfies Record<string, LegalValue>

/** Wages and employment. */
export const EMPLOYMENT = {
  /** apprentices and learners may be paid this share of the applicable minimum wage */
  apprenticeShareOfMinimumWage: { value: 0.75, effectiveFrom: LABOR_CODE, source: 'Labor Code Arts. 61 and 73' },
  /** probationary employment: six months, 180 days counted with the first day excluded */
  probationDays: {
    value: 180,
    effectiveFrom: LABOR_CODE,
    source: 'Labor Code Art. 296; Civil Code Art. 13; Mitsubishi Motors v. Chrysler Phils. Labor Union, G.R. 148738',
  },
  /** 13th month pay: one twelfth of the basic salary earned in the calendar year (the divisor) */
  thirteenthMonthDivisor: { value: 12, effectiveFrom: '1975-12-16', source: 'PD 851 Sec. 1; Revised Guidelines on the Implementation of the 13th Month Pay Law' },
} satisfies Record<string, LegalValue>
