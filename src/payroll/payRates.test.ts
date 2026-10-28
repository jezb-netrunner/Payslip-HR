// Pay-rate history: the rate in effect on a date, the rates over a period,
// and a payroll whose rate changes inside the period (each day at its rate).
import { describe, expect, it } from 'vitest'
import { computePayslip } from './engine'
import { DEFAULT_TABLES } from './defaults'
import { changesBetween, monthlyEquivalent, rateChanges, rateOn, rateSegments, type PayRateRow, type PayRateReason } from './payRates'
import { eachDate } from '../lib/manila'
import type { DayComputation, PayLine, PayrollEmployeeInput, PayrollSettingsInput, RateSegment } from './types'

const history: PayRateRow[] = [
  { effective_from: '2026-09-09', pay_type: 'monthly', rate: 33000 },
  { effective_from: '2026-01-05', pay_type: 'monthly', rate: 30000 },
  { effective_from: '2026-12-01', pay_type: 'monthly', rate: '35000.00' },
]

describe('pay-rate history lookups', () => {
  it('the rate on a date is the latest change on or before it, else the first', () => {
    expect(rateOn(history, '2026-09-08')?.rate).toBe(30000)
    expect(rateOn(history, '2026-09-09')?.rate).toBe(33000)
    expect(rateOn(history, '2025-12-01')?.rate).toBe(30000)
    expect(rateOn([], '2026-09-01')).toBeUndefined()
  })

  it('a period holds the rate on its first day, then each change inside it', () => {
    expect(rateSegments(history, '2026-09-01', '2026-09-15')).toEqual([
      { from: '2026-09-01', payType: 'monthly', monthlyRate: 30000, dailyRate: 0 },
      { from: '2026-09-09', payType: 'monthly', monthlyRate: 33000, dailyRate: 0 },
    ])
    expect(rateSegments(history, '2026-09-16', '2026-09-30')).toEqual([
      { from: '2026-09-16', payType: 'monthly', monthlyRate: 33000, dailyRate: 0 },
    ])
    expect(rateSegments([], '2026-09-01', '2026-09-15')).toEqual([])
    // a change to the same rate splits nothing
    const same = [...history, { effective_from: '2026-09-12', pay_type: 'monthly' as const, rate: 33000 }]
    expect(rateSegments(same, '2026-09-01', '2026-09-15')).toHaveLength(2)
  })

  it('each change against the rate before it, as monthly amounts when the basis changes', () => {
    const rows: PayRateRow[] = [
      { effective_from: '2026-01-05', pay_type: 'daily', rate: 700 },
      { effective_from: '2026-07-05', pay_type: 'daily', rate: 750 },
      { effective_from: '2026-09-01', pay_type: 'monthly', rate: 20000 },
    ]
    const changes = rateChanges(rows, 261)
    expect(changes[0]).toEqual({ row: rows[0] })
    expect(changes[1]).toMatchObject({ change: 50, pct: 7.14 })
    // 750 a day × 261 ÷ 12 = 16,312.50 a month
    expect(monthlyEquivalent(rows[1], 261)).toBe(16312.5)
    expect(changes[2]).toMatchObject({ change: 3687.5, pct: 22.61 })
  })
})

describe('pay changes in a year (the report)', () => {
  it('counts the changes that took effect in the range, not the hire rate or a correction, with the monthly cost change', () => {
    const rows: (PayRateRow & { reason: PayRateReason })[] = [
      { effective_from: '2025-03-01', pay_type: 'daily', rate: 650, reason: 'hired' },
      { effective_from: '2026-01-10', pay_type: 'daily', rate: 700, reason: 'wage_order' },
      { effective_from: '2026-02-01', pay_type: 'daily', rate: 705, reason: 'correction' },
      { effective_from: '2026-08-01', pay_type: 'monthly', rate: 20000, reason: 'regularized' },
      { effective_from: '2027-01-05', pay_type: 'monthly', rate: 21000, reason: 'merit_increase' },
    ]
    const changes = changesBetween(rows, '2026-01-01', '2026-12-31', 313)
    expect(changes.map((c) => [c.row.effective_from, c.change, c.pct, c.monthlyChange])).toEqual([
      // 650 → 700 a day = +50 (+7.69%); monthly 16,954.17 → 18,258.33
      ['2026-01-10', 50, 7.69, 1304.16],
      // 705 a day (18,388.75 a month) → 20,000 a month
      ['2026-08-01', 1611.25, 8.76, 1611.25],
    ])
  })
})

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 0,
}

/** Sep 1–15, 2026: weekdays worked 8 hours, weekends rest days; `absent` dates not worked. */
function september(absent: string[] = []): DayComputation[] {
  return eachDate('2026-09-01', '2026-09-15').map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const weekday = dow >= 1 && dow <= 5
    const worked = weekday && !absent.includes(date)
    return {
      date,
      dayType: weekday ? 'regular' : 'rest_day',
      scheduled: weekday,
      workedMinutes: worked ? 480 : 0,
      payableMinutes: worked ? 480 : 0,
      expectedMinutes: 480,
      otMinutes: 0,
      nightDiffMinutes: 0,
      ndOtMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      absent: weekday && !worked,
      onPaidLeave: false,
      onUnpaidLeave: false,
    }
  })
}

function pay(segments: RateSegment[], days = september()) {
  const last = segments[segments.length - 1]
  const employee: PayrollEmployeeInput = {
    id: 'e1',
    name: 'Rina Santos',
    payType: last.payType,
    monthlyRate: last.monthlyRate,
    dailyRate: last.dailyRate,
    rateSegments: segments,
    isMinimumWageEarner: false,
    schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 },
    allowances: [],
    extraDeductions: [],
  }
  return computePayslip({
    employee,
    settings,
    period: { start: '2026-09-01', end: '2026-09-15', index: 1, count: 2 },
    tables: DEFAULT_TABLES,
    days,
    runType: 'regular',
  })
}
const basic = (lines: PayLine[]) => lines.filter((l) => l.bir === 'basic').map((l) => [l.label, l.amount])
const monthly = (from: string, rate: number): RateSegment => ({ from, payType: 'monthly', monthlyRate: rate, dailyRate: 0 })
const daily = (from: string, rate: number): RateSegment => ({ from, payType: 'daily', monthlyRate: 0, dailyRate: rate })

describe('a pay rate that changes inside the period', () => {
  it('monthly raise from Sep 9: the rate of most of the period pays its salary, the other days their daily rate', () => {
    const slip = pay([monthly('2026-09-01', 30000), monthly('2026-09-09', 33000)])
    // 11 weekdays: 6 to Sep 8 at 30,000, 5 from Sep 9 at 33,000 (daily = monthly × 12 ÷ 261)
    // 15,000 − 5 × 1,379.31 = 8,103.45; 5 × 1,517.24 = 7,586.21
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 8 (30,000.00 a month)', 8103.45],
      ['Basic Pay from Sep 9 (33,000.00 a month)', 7586.21],
    ])
    expect(slip.grossPay).toBe(15689.66)
    // contributions on the rate at the end of the period
    expect(slip.trace.statutoryMonthlyBase).toBe(33000)
  })

  it('an absence after the raise is docked at the new daily rate', () => {
    const slip = pay([monthly('2026-09-01', 30000), monthly('2026-09-09', 33000)], september(['2026-09-10']))
    expect(slip.earnings.find((l) => l.code === 'absence')?.amount).toBe(-1517.24)
    expect(slip.grossPay).toBe(14172.42)
  })

  it('daily raise from Sep 9: each day worked at its rate', () => {
    const slip = pay([daily('2026-09-01', 700), daily('2026-09-09', 750)])
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 8 (6 day/s at 700.00)', 4200],
      ['Basic Pay from Sep 9 (5 day/s at 750.00)', 3750],
    ])
  })

  it('daily to monthly from Sep 9 (regularization): mostly daily-rated, each day at its own rate', () => {
    const slip = pay([daily('2026-09-01', 700), monthly('2026-09-09', 20000)])
    // 6 of the 11 weekdays daily-rated: the 5 monthly days at 20,000 × 12 ÷ 261 = 919.54
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 8 (6 day/s at 700.00)', 4200],
      ['Basic Pay from Sep 9 (20,000.00 a month)', 4597.7],
    ])
  })

  it('daily to monthly from Sep 7: monthly-rated for most of the period, its salary less the daily days', () => {
    const slip = pay([daily('2026-09-01', 700), monthly('2026-09-07', 20000)])
    // monthly: 10,000 − 4 days before Sep 7 × 919.54 = 6,321.84
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 6 (4 day/s at 700.00)', 2800],
      ['Basic Pay from Sep 7 (20,000.00 a month)', 6321.84],
    ])
  })

  it('monthly to daily from Sep 3: the 2 monthly days at their daily rate, never a salary less 9 days', () => {
    const slip = pay([monthly('2026-09-01', 30000), daily('2026-09-03', 1500)])
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 2 (30,000.00 a month)', 2758.62],
      ['Basic Pay from Sep 3 (9 day/s at 1,500.00)', 13500],
    ])
  })

  it("an absence and lateness on the daily days aren't in the monthly deductions' counts", () => {
    const days = september(['2026-09-14']).map((d) =>
      d.date === '2026-09-02' ? { ...d, lateMinutes: 10 } : d.date === '2026-09-10' ? { ...d, lateMinutes: 30 } : d,
    )
    const slip = pay([monthly('2026-09-01', 30000), daily('2026-09-09', 1500)], days)
    // monthly to Sep 8 (6 of 11 weekdays): only its 10 minutes are docked
    expect(slip.earnings.find((l) => l.code === 'late')).toMatchObject({ label: 'Tardiness (10 min)', amount: -28.74 })
    expect(slip.earnings.find((l) => l.code === 'absence')).toBeUndefined()
  })

  it('one rate over the period pays as before', () => {
    const slip = pay([monthly('2026-09-01', 30000)])
    expect(basic(slip.earnings)).toEqual([['Basic Pay', 15000]])
  })
})
