// Pay-rate history: the rate in effect on a date, the rates over a period,
// and a payroll whose rate changes inside the period (each day at its rate).
import { describe, expect, it } from 'vitest'
import { computePayslip } from './engine'
import { DEFAULT_TABLES } from './defaults'
import { monthlyEquivalent, rateChanges, rateOn, rateSegments, type PayRateRow } from './payRates'
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

  it('daily to monthly from Sep 9 (regularization): the days before stay on the daily rate', () => {
    const slip = pay([daily('2026-09-01', 700), monthly('2026-09-09', 20000)])
    // monthly: 10,000 − 6 days before Sep 9 × 919.54 = 4,482.76
    expect(basic(slip.earnings)).toEqual([
      ['Basic Pay to Sep 8 (6 day/s at 700.00)', 4200],
      ['Basic Pay from Sep 9 (20,000.00 a month)', 4482.76],
    ])
  })

  it('one rate over the period pays as before', () => {
    const slip = pay([monthly('2026-09-01', 30000)])
    expect(basic(slip.earnings)).toEqual([['Basic Pay', 15000]])
  })
})
