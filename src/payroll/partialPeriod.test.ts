// A monthly rate for someone employed only part of a period, or absent most
// of it, is paid by the days at the daily rate: "salary less absences" pays a
// period with fewer workdays than the divisor's average something for no
// work, and a longer one less than the days worked. Also: the 13th month's
// withholding never exceeds its pay, and a whole-day leave on a worked day is
// named in the review.

import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { eachDate, isoWeekday } from '../lib/manila'
import type { LeaveLite, PayrollEmployeeInput, PayrollSettingsInput, PeriodInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 505,
}
const schedule = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 }
const monthly: PayrollEmployeeInput = {
  id: 'e1', name: 'Juan Cruz', payType: 'monthly', monthlyRate: 30000, dailyRate: 0, isMinimumWageEarner: false,
  schedule, allowances: [], extraDeductions: [],
}
// Jul 16–31, 2026: twelve weekdays; Feb 16–28, 2027: nine
const JULY: PeriodInput = { start: '2026-07-16', end: '2026-07-31', index: 2, count: 2 }
const FEB: PeriodInput = { start: '2027-02-16', end: '2027-02-28', index: 2, count: 2 }
const workdays = (p: PeriodInput) => eachDate(p.start, p.end).filter((d) => isoWeekday(d) <= 5)

function pay(employee: PayrollEmployeeInput, period: PeriodInput, worked: string[], leaves: LeaveLite[] = [], extra: Partial<PayrollSettingsInput> = {}) {
  return computePayslip({
    employee,
    settings: { ...settings, ...extra },
    period,
    tables: DEFAULT_TABLES,
    days: computeAttendance({
      periodStart: period.start,
      periodEnd: period.end,
      schedule,
      standardHoursPerDay: 8,
      gracePeriodMinutes: 0,
      entries: worked.map((d) => ({ work_date: d, clock_in: `${d}T00:00:00Z`, clock_out: `${d}T09:00:00Z` })),
      holidays: [],
      approvedLeaves: leaves,
    }),
    runType: 'regular',
  })
}
const basic = (s: ReturnType<typeof pay>) => Math.round(s.earnings.filter((l) => l.bir === 'basic').reduce((t, l) => t + l.amount, 0) * 100) / 100

describe('a monthly rate paid by the days', () => {
  it('pays a hire on the last two workdays of a twelve-workday period two days, not salary less ten', () => {
    const s = pay({ ...monthly, monthlyRate: 14000, hireDate: '2026-07-30' }, JULY, ['2026-07-30', '2026-07-31'])
    // 14,000 × 12 ÷ 261 = 643.68 a day; before: 7,000 − 10 × 643.68 = 563.22
    expect(s.earnings.find((l) => l.code === 'basic')).toMatchObject({ amount: 1287.36, label: 'Basic Pay (2 day/s paid at 643.68; hired Jul 30)' })
    expect(s.earnings.some((l) => l.code === 'absence' || l.code === 'outside_employment')).toBe(false)
    expect(s.absentDays).toBe(0)
  })

  it('pays a separation two days into the period two days', () => {
    const s = pay({ ...monthly, separationDate: '2026-07-17' }, JULY, ['2026-07-16', '2026-07-17'])
    expect(basic(s)).toBe(2758.62)
  })

  it('caps a hire on the second day of a long period at the period salary', () => {
    const s = pay({ ...monthly, hireDate: '2026-07-17' }, JULY, workdays(JULY).slice(1))
    // 11 × 1,379.31 = 15,172.41
    expect(basic(s)).toBe(15000)
    expect(s.trace.notes.some((n) => n.includes("capped at the period's salary"))).toBe(true)
  })

  it('pays a period with nine workdays and none worked nothing (before: ₱2,586.21)', () => {
    const s = pay(monthly, FEB, [])
    expect(basic(s)).toBe(0)
    expect(s.grossPay).toBe(0)
    const lwop: LeaveLite = { start_date: FEB.start, end_date: FEB.end, paid: false, type_name: 'Leave without pay', type_code: 'LWOP' }
    expect(basic(pay(monthly, FEB, [], [lwop]))).toBe(0)
  })

  it('pays one day worked of twelve (before: ₱0), never more than salary less absences with one day more', () => {
    const s = pay(monthly, JULY, ['2026-07-31'])
    // 1 × 1,379.31, but 15,000 − 10 × 1,379.31 = 1,206.90 is what two days would pay by the salary
    expect(basic(s)).toBe(1206.9)
    expect(s.trace.notes.some((n) => n.includes('so a day more never pays less'))).toBe(true)
  })

  it('keeps salary less absences for ordinary absences', () => {
    const s = pay(monthly, JULY, workdays(JULY).slice(2))
    expect(basic(s)).toBe(12241.38)
    expect(s.earnings.find((l) => l.code === 'absence')?.amount).toBe(-2758.62)
  })

  it.each([
    ['twelve workdays', JULY],
    ['nine workdays', FEB],
  ] as const)('never pays less for a day more worked, and pays the salary for all of them (%s)', (_, period) => {
    const all = workdays(period)
    const pays = all.map((_, i) => basic(pay(monthly, period, all.slice(0, i)))).concat(basic(pay(monthly, period, all)))
    for (let i = 1; i < pays.length; i++) expect(pays[i]).toBeGreaterThanOrEqual(pays[i - 1])
    expect(pays[0]).toBe(0)
    expect(pays[pays.length - 1]).toBe(15000)
  })

  it('warns when salary less absences leaves a day paid below the minimum wage', () => {
    // 14,000: 643.68 a day; six of twelve worked: 7,000 − 6 × 643.68 = 3,137.93, 522.99 a day
    const s = pay({ ...monthly, monthlyRate: 14000 }, JULY, workdays(JULY).slice(0, 6), [], { minimumWageDaily: 600 })
    expect(s.trace.warnings.some((w) => w.startsWith('Basic pay ₱3,137.93 for 6 day/s paid is ₱522.99 a day, below'))).toBe(true)
  })
})

describe('a whole-day leave on a day with time on record', () => {
  it('pays the day from the time and says the leave was set aside', () => {
    const vl: LeaveLite = { start_date: '2026-07-20', end_date: '2026-07-20', paid: true, type_name: 'Vacation Leave', type_code: 'VL' }
    const s = pay(monthly, JULY, workdays(JULY), [vl])
    expect(basic(s)).toBe(15000)
    expect(s.trace.warnings.some((w) => w.startsWith('Approved leave on a day with time in/out on record (Vacation Leave, Jul 20)'))).toBe(true)
  })
})

describe('13th month withholding', () => {
  it('never withholds more than the 13th month pays', () => {
    // a previous employer used the exemption and withheld nothing on ₱900,000
    const s = computePayslip({
      employee: { ...monthly, monthlyRate: 20000 },
      settings,
      period: { start: '2026-01-01', end: '2026-12-31', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'thirteenth_month',
      ytdBasicPay: 20000,
      priorThirteenthOtherBenefitsExempt: 90000,
      taxYear: { taxableBefore: 900000, withheldBefore: 0, periods: 22, cumulative: true },
    })
    expect(s.grossPay).toBe(1666.67)
    expect(s.withholdingTax).toBe(1666.67)
    expect(s.netPay).toBe(0)
    expect(s.trace.notes.some((n) => n.startsWith('Withholding tax due ₱'))).toBe(true)
  })
})
