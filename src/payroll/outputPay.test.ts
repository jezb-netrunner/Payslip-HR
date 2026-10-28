// Output-based pay: the outputs an admin accepted in the period are paid as
// their own lines, classified per employee (the basic pay of a worker paid
// by results, or fees, commission or other supplementary pay on top of the
// salary); Pag-IBIG counts them, PhilHealth only as a worker's basic pay
// (never below the minimum wage for one paid by results).
import { describe, expect, it } from 'vitest'
import { computePayslip, type MonthContributionsInput } from './engine'
import { DEFAULT_TABLES } from './defaults'
import { eachDate } from '../lib/manila'
import type { DayComputation, OutputInput, PayrollEmployeeInput, PayrollSettingsInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 695,
}
const consultant: PayrollEmployeeInput = {
  id: 'c1',
  name: 'Rhea Santos',
  payType: 'monthly',
  monthlyRate: 30000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
  fixedSalary: true,
  outputPay: { class: 'fees', thirteenth: true },
}
// paid by results: no salary, a day's work is what the outputs pay
const sewer: PayrollEmployeeInput = {
  ...consultant,
  id: 'p1',
  name: 'Lorna Cruz',
  payType: 'daily',
  monthlyRate: 0,
  dailyRate: 0,
  fixedSalary: false,
  outputPay: { class: 'basic', thirteenth: true },
}

/** Sep 1–15, 2026: every weekday worked, or as given. */
function sept(over: Partial<Record<string, Partial<DayComputation>>> = {}): DayComputation[] {
  return eachDate('2026-09-01', '2026-09-15').map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const weekday = dow >= 1 && dow <= 5
    return {
      date,
      dayType: weekday ? 'regular' : 'rest_day',
      scheduled: weekday,
      workedMinutes: weekday ? 480 : 0,
      payableMinutes: weekday ? 480 : 0,
      expectedMinutes: 480,
      otMinutes: 0,
      nightDiffMinutes: 0,
      ndOtMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      absent: false,
      onPaidLeave: false,
      onUnpaidLeave: false,
      ...over[date],
    }
  })
}

const pay = (
  employee: PayrollEmployeeInput,
  outputs: OutputInput[],
  extra: { days?: DayComputation[]; daysBefore?: DayComputation[]; mc?: MonthContributionsInput; second?: boolean } = {},
) =>
  computePayslip({
    employee: { ...employee, outputs },
    settings,
    period: extra.second
      ? { start: '2026-09-16', end: '2026-09-30', index: 2, count: 2 }
      : { start: '2026-09-01', end: '2026-09-15', index: 1, count: 2 },
    tables: DEFAULT_TABLES,
    days: extra.days ?? sept(),
    ...(extra.daysBefore ? { daysBefore: extra.daysBefore } : {}),
    runType: 'regular',
    ...(extra.mc ? { monthContributions: extra.mc } : {}),
  })

/** Aug 18–31, 2026: every weekday worked. */
const augustTail = (): DayComputation[] =>
  eachDate('2026-08-18', '2026-08-31').map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const weekday = dow >= 1 && dow <= 5
    return {
      date,
      dayType: weekday ? 'regular' : 'rest_day',
      scheduled: weekday,
      workedMinutes: weekday ? 480 : 0,
      payableMinutes: weekday ? 480 : 0,
      expectedMinutes: 480,
      otMinutes: 0,
      nightDiffMinutes: 0,
      ndOtMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      absent: false,
      onPaidLeave: false,
      onUnpaidLeave: false,
    }
  })

const articles: OutputInput[] = [
  { id: 'o1', date: '2026-09-03', description: 'Article', quantity: 2, unitRate: 5000, amount: 10000 },
  { id: 'o2', date: '2026-09-10', description: 'Market study', amount: 20000 },
  { id: 'o3', date: '2026-09-11', description: 'article ', quantity: 1, unitRate: 5000, amount: 5000 },
]
const NONE = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }

describe('output pay on top of the salary', () => {
  it('pays units at one rate as one line and a fixed amount on its own, classified as fees', () => {
    const slip = pay(consultant, articles)
    const out = slip.earnings.filter((l) => l.code === 'output')
    expect(out.map((l) => [l.label, l.amount, l.bir, l.taxable])).toEqual([
      ['Output: Article (3 × 5,000.00)', 15000, 'fees', true],
      ['Output: Market study', 20000, 'fees', true],
    ])
    expect(slip.grossPay).toBe(50000)
    // counts toward the 13th month under the client's policy
    expect(slip.basicPay).toBe(50000)
    expect(slip.trace.notes.some((n) => n.startsWith('Output pay ₱35,000.00 (3 output/s'))).toBe(true)
    // PhilHealth stays on the salary (its monthly basic salary has no fees)
    expect(slip.deductions.find((l) => l.code === 'philhealth')?.amount).toBe(375)
  })

  it('leaves it out of the 13th month when the client says so', () => {
    const slip = pay({ ...consultant, outputPay: { class: 'commission', thirteenth: false } }, articles)
    expect(slip.earnings.filter((l) => l.code === 'output').every((l) => l.bir === 'commission' && l.thirteenthBasis === undefined)).toBe(true)
    expect(slip.basicPay).toBe(15000)
  })

  it("settles Pag-IBIG on the month's output pay at the closing payroll", () => {
    const low = { ...consultant, monthlyRate: 6000 }
    // the first half took ₱60 on the ₱6,000 salary; the month paid ₱5,000 of output then
    const first = pay(low, [])
    expect(first.deductions.find((l) => l.code === 'pagibig')?.amount).toBe(60)
    const mc: MonthContributionsInput = {
      already: { ...NONE, pagibigEe: 60, pagibigEr: 60, philhealthEe: 125, philhealthEr: 125 },
      compensationAlready: 3000 + 5000,
      outputAlready: { all: 5000, basic: 0 },
      closes: true,
      opens: false,
    }
    const second = pay(low, [{ id: 'o4', date: '2026-09-20', description: 'Report', amount: 1000 }], { mc, second: true })
    // ₱6,000 + ₱6,000 of output → ₱12,000, capped at ₱10,000: ₱200 for the month
    expect(second.deductions.find((l) => l.code === 'pagibig')?.amount).toBe(140)
    expect(second.trace.notes.some((n) => n.startsWith("Pag-IBIG on the month's pay with its output pay ₱6,000.00"))).toBe(true)
    // PhilHealth stays on the salary (here its floor): fees are not in it
    expect(second.deductions.find((l) => l.code === 'philhealth')?.amount).toBe(125)
  })

  it('pays an output with no classification as other supplementary pay, and says so', () => {
    const slip = pay({ ...consultant, outputPay: undefined }, articles.slice(1, 2))
    expect(slip.earnings.find((l) => l.code === 'output')?.bir).toBe('other_supplementary')
    expect(slip.trace.warnings.some((w) => w.startsWith('Output pay has no classification'))).toBe(true)
  })
})

describe('a worker paid by results', () => {
  // 11 weekdays worked Sep 1–15
  const shirts = (pieces: number): OutputInput[] => [
    { id: 's1', date: '2026-09-15', description: 'Sewn shirts', quantity: pieces, unitRate: 25, amount: pieces * 25 },
  ]

  it('pays the outputs as basic pay, toward the 13th month, with no warning about a rate under the minimum', () => {
    const slip = pay(sewer, shirts(400))
    const out = slip.earnings.find((l) => l.code === 'output')!
    expect([out.label, out.amount, out.bir, out.thirteenthBasis]).toEqual(['Output: Sewn shirts (400 × 25.00)', 10000, 'basic', undefined])
    expect(slip.basicPay).toBe(10000)
    expect(slip.trace.warnings.some((w) => w.startsWith('Derived daily rate'))).toBe(false)
    expect(slip.trace.warnings.some((w) => w.startsWith('Pay for the period'))).toBe(false)
  })

  it('warns when the period pays less than the minimum wage for the days worked', () => {
    const slip = pay(sewer, shirts(200))
    // ₱5,000 for 11 days against ₱695 × 11 = ₱7,645
    expect(slip.trace.warnings.find((w) => w.startsWith('Pay for the period'))).toContain('₱5,000.00 is below the minimum wage for 11 day/s worked or on paid leave (₱7,645.00)')
  })

  it('warns a minimum wage earner paid above the minimum', () => {
    const slip = pay({ ...sewer, isMinimumWageEarner: true }, shirts(400))
    expect(slip.trace.warnings.some((w) => w.startsWith('Marked as a minimum wage earner, but pay for the period ₱10,000.00'))).toBe(true)
    // the basic pay of a minimum wage earner is exempt
    expect(slip.earnings.find((l) => l.code === 'output')?.taxable).toBe(false)
  })

  it('pays an unworked regular holiday at the average of the last 7 working days (Omnibus Rules Book III Rule IV Sec. 8(b))', () => {
    const days = sept({ '2026-09-08': { dayType: 'regular_holiday', workedMinutes: 0, payableMinutes: 0, holidayName: 'Test holiday' } })
    // ₱1,200 of shirts accepted each working day: Aug 28 and 31 before the period, Sep 1–4 and 7 in it
    const daily = (date: string): OutputInput => ({ id: date, date, description: 'Sewn shirts', quantity: 48, unitRate: 25, amount: 1200 })
    const inPeriod = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'].map(daily)
    const slip = computePayslip({
      employee: { ...sewer, outputs: inPeriod, outputsBefore: ['2026-08-27', '2026-08-28', '2026-08-31'].map(daily) },
      settings,
      period: { start: '2026-09-01', end: '2026-09-15', index: 1, count: 2 },
      tables: DEFAULT_TABLES,
      days,
      daysBefore: augustTail(),
      runType: 'regular',
    })
    // the window is Aug 28 – Sep 7: 7 working days, ₱8,400 of output (Aug 27 falls before it)
    const holiday = slip.earnings.find((l) => l.label.startsWith('Holiday Pay, Sep 8'))
    expect([holiday?.amount, holiday?.bir]).toEqual([1200, 'holiday'])
    expect(slip.trace.notes.some((n) => n.includes('average daily earnings of the last 7 working day/s before it, ₱1,200.00'))).toBe(true)
    expect(slip.trace.warnings.some((w) => w.includes('working day/s on record'))).toBe(false)
  })

  it('never pays a regular holiday below the minimum wage, and says when the record is short', () => {
    const days = sept({ '2026-09-08': { dayType: 'regular_holiday', workedMinutes: 0, payableMinutes: 0, holidayName: 'Test holiday' } })
    // nothing accepted before the holiday, and only the period's 5 working days on record
    const slip = pay(sewer, shirts(400), { days })
    expect(slip.earnings.find((l) => l.label.startsWith('Holiday Pay, Sep 8'))?.amount).toBe(695)
    expect(slip.trace.warnings.some((w) => w.startsWith('Regular holiday Sep 8: only 5 working day/s on record'))).toBe(true)
  })

  it("counts what a daily rate already pays for the holiday", () => {
    const days = sept({ '2026-09-08': { dayType: 'regular_holiday', workedMinutes: 0, payableMinutes: 0 } })
    const slip = pay({ ...sewer, dailyRate: 500 }, [], { days, daysBefore: augustTail() })
    // average 500 a day (no output): the minimum wage 695 is due, the rate paid 500 of it
    expect(slip.earnings.find((l) => l.label.startsWith('Holiday Pay, Sep 8'))?.amount).toBe(195)
  })

  it("warns that output made on a worked holiday or rest day is paid without the day's premium", () => {
    const days = sept({
      '2026-09-08': { dayType: 'regular_holiday', holidayName: 'Test holiday' },
      '2026-09-12': { dayType: 'rest_day', scheduled: false, workedMinutes: 480, payableMinutes: 480, absent: false },
    })
    const slip = pay(sewer, shirts(400), { days })
    expect(slip.trace.warnings.some((w) => w.startsWith('Worked on a holiday or rest day (Sep 8, Sep 12): output pay is at its own rates'))).toBe(true)
    expect(pay(sewer, shirts(400)).trace.warnings.some((w) => w.startsWith('Worked on a holiday or rest day'))).toBe(false)
  })

  it('takes PhilHealth on at least the minimum wage, and settles both on the month at its close', () => {
    const first = pay(sewer, shirts(400))
    // ₱695 × 261 ÷ 12 = ₱15,116.25 → ₱755.81 a month, ₱377.90 the employee's, half of it now
    expect(first.deductions.find((l) => l.code === 'philhealth')?.amount).toBe(188.95)
    expect(first.trace.notes.some((n) => n.includes('a worker paid by results is not below the minimum wage'))).toBe(true)
    // no salary and the month's output not known yet: no Pag-IBIG on this one
    expect(first.deductions.find((l) => l.code === 'pagibig')).toBeUndefined()

    const mc: MonthContributionsInput = {
      already: { ...NONE, philhealthEe: 188.95, philhealthEr: 188.95 },
      compensationAlready: 10000,
      outputAlready: { all: 10000, basic: 10000 },
      closes: true,
      opens: false,
    }
    const second = pay(sewer, shirts(400), { mc, second: true, days: sept() })
    // the month paid ₱20,000 of output: PhilHealth ₱1,000 (₱500 the employee's), Pag-IBIG ₱200
    expect(second.deductions.find((l) => l.code === 'philhealth')?.amount).toBe(311.05)
    expect(second.deductions.find((l) => l.code === 'pagibig')?.amount).toBe(200)
  })
})
