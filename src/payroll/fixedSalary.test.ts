// Fixed salary without timekeeping: the monthly rate pays the period; no
// time in/out needed, no docking for absence or lateness, no overtime or
// holiday premium; leave without pay and days outside the employment are
// still deducted.
import { describe, expect, it } from 'vitest'
import { computePayslip } from './engine'
import { DEFAULT_TABLES } from './defaults'
import { eachDate } from '../lib/manila'
import type { DayComputation, PayrollEmployeeInput, PayrollSettingsInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 0,
}
const executive: PayrollEmployeeInput = {
  id: 'x1',
  name: 'Celia Ramos',
  payType: 'monthly',
  monthlyRate: 80000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
  fixedSalary: true,
}

/** Sep 1–15, 2026 as attendance sees it with no time entries: every weekday absent. */
function noEntries(over: Partial<Record<string, Partial<DayComputation>>> = {}): DayComputation[] {
  return eachDate('2026-09-01', '2026-09-15').map((date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    const weekday = dow >= 1 && dow <= 5
    return {
      date,
      dayType: weekday ? 'regular' : 'rest_day',
      scheduled: weekday,
      workedMinutes: 0,
      payableMinutes: 0,
      expectedMinutes: 480,
      otMinutes: 0,
      nightDiffMinutes: 0,
      ndOtMinutes: 0,
      lateMinutes: 0,
      undertimeMinutes: 0,
      absent: weekday,
      onPaidLeave: false,
      onUnpaidLeave: false,
      ...over[date],
    }
  })
}

const pay = (employee: PayrollEmployeeInput, days: DayComputation[]) =>
  computePayslip({
    employee,
    settings,
    period: { start: '2026-09-01', end: '2026-09-15', index: 1, count: 2 },
    tables: DEFAULT_TABLES,
    days,
    runType: 'regular',
  })

describe('fixed salary without timekeeping', () => {
  it('pays the period without time entries: nothing docked, no absence warning', () => {
    const slip = pay(executive, noEntries())
    expect(slip.earnings.filter((l) => l.bir === 'basic').map((l) => [l.code, l.amount])).toEqual([['basic', 40000]])
    expect(slip.absentDays).toBe(0)
    expect(slip.trace.warnings.some((w) => w.includes('charged as absence'))).toBe(false)
    expect(slip.trace.notes.some((n) => n.startsWith('Fixed salary, no timekeeping'))).toBe(true)
  })

  it('computes no overtime, lateness or holiday premium from time entered anyway', () => {
    const worked = { workedMinutes: 600, payableMinutes: 450, otMinutes: 120, lateMinutes: 30, absent: false }
    const slip = pay(executive, noEntries({ '2026-09-02': worked, '2026-09-06': { ...worked, dayType: 'rest_day' } }))
    expect(slip.grossPay).toBe(40000)
    expect(slip.overtimeHours).toBe(0)
  })

  it('deducts leave without pay at the daily rate', () => {
    const slip = pay(executive, noEntries({ '2026-09-10': { onUnpaidLeave: true, absent: false } }))
    // 80,000 × 12 ÷ 261 = 3,678.16
    expect(slip.earnings.find((l) => l.code === 'absence')).toMatchObject({ label: 'Leave without pay (1 day/s)', amount: -3678.16 })
  })

  it('deducts the workdays before a mid-period hire', () => {
    const slip = pay({ ...executive, hireDate: '2026-09-09' }, noEntries())
    // Sep 1–4, 7–8: 6 workdays before the hire
    expect(slip.earnings.find((l) => l.code === 'outside_employment')).toMatchObject({
      label: 'Days before the hire date or after the last day (6 day/s)',
      amount: -22068.97,
    })
  })

  it('needs a monthly rate: a daily-rated employee is paid on attendance, with a warning', () => {
    const slip = pay({ ...executive, payType: 'daily', monthlyRate: 0, dailyRate: 3000 }, noEntries())
    expect(slip.grossPay).toBe(0)
    expect(slip.trace.warnings).toContain('Fixed salary needs a monthly rate: this payroll used attendance as usual.')
  })
})
