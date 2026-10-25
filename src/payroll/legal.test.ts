// Statutory rules from the 2026-10-24 legal review: maternity pay (RA 11210),
// the PhilHealth employee-share waiver (RA 11228, RA 11861) and salary
// deductions that never exceed the period's salary.

import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { PAY_CODES } from './payCodes'
import type { LeaveLite, PayCode, PayrollEmployeeInput, PayrollSettingsInput, PeriodInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 755,
}
const monthly: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Ana Reyes',
  payType: 'monthly',
  monthlyRate: 30000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const daily: PayrollEmployeeInput = { ...monthly, id: 'e2', payType: 'daily', monthlyRate: 0, dailyRate: 800 }
const period: PeriodInput = { start: '2026-08-16', end: '2026-08-31', index: 2, count: 2 }
const WORKDAYS = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
  '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31',
]
const maternity = (start: string, end = '2026-11-29'): LeaveLite => ({
  start_date: start,
  end_date: end,
  paid: true,
  type_name: 'Maternity Leave (RA 11210)',
  type_code: 'ML',
})

function pay(employee: PayrollEmployeeInput, worked: string[], leaves: LeaveLite[] = []) {
  const days = computeAttendance({
    periodStart: period.start,
    periodEnd: period.end,
    schedule: employee.schedule,
    standardHoursPerDay: 8,
    gracePeriodMinutes: 0,
    entries: worked.map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
    holidays: [],
    approvedLeaves: leaves,
  })
  return computePayslip({ employee, settings, period, tables: DEFAULT_TABLES, days, runType: 'regular' })
}

describe('maternity leave is paid as the maternity benefit, not as salary (RA 11210)', () => {
  it('takes the leave days out of a monthly salary, never below zero', () => {
    const slip = pay(monthly, [], [maternity('2026-08-10')])
    // 11 weekdays at 1,379.31 would be 15,172.41: capped at the period's 15,000
    expect(slip.earnings.find((l) => l.code === 'maternity')?.amount).toBe(-15000)
    expect(slip.basicPay).toBe(0)
    expect(slip.absentDays).toBe(0)
  })

  it('docks only the leave days when the leave starts mid-period', () => {
    const slip = pay(monthly, WORKDAYS.slice(0, 5), [maternity('2026-08-24')])
    // Aug 24–28 and 31: six weekdays
    expect(slip.earnings.find((l) => l.code === 'maternity')).toMatchObject({ amount: -8275.86, label: 'Maternity leave (8 day/s, paid as the maternity benefit)' })
    expect(slip.trace.warnings.some((w) => w.startsWith('Maternity leave from Aug 24:'))).toBe(true)
  })

  it('pays a daily-paid employee nothing for the leave days', () => {
    const slip = pay(daily, WORKDAYS.slice(0, 5), [maternity('2026-08-24')])
    expect(slip.earnings.find((l) => l.code === 'basic')?.amount).toBe(4000) // the five days worked
  })

  it('pays the SSS benefit tax-exempt; the differential is taxable S until its exemption is confirmed (spec P1) and counts for the 13th month', () => {
    const run = (payCodes?: PayCode[]) =>
      computePayslip({
        employee: {
          ...monthly,
          oneTimeEarnings: [
            { id: 'a1', label: 'SSS maternity benefit', amount: 70000, category: 'other_non_taxable', benefit: 'sss_maternity' },
            { id: 'a2', label: 'Maternity salary differential', amount: 5000, category: 'other_non_taxable', benefit: 'maternity_differential' },
          ],
        },
        settings,
        period,
        tables: DEFAULT_TABLES,
        days: computeAttendance({
          periodStart: period.start,
          periodEnd: period.end,
          schedule: monthly.schedule,
          standardHoursPerDay: 8,
          gracePeriodMinutes: 0,
          entries: [],
          holidays: [],
          approvedLeaves: [maternity('2026-08-10')],
        }),
        runType: 'regular',
        payCodes,
      })
    const slip = run()
    const [benefit, differential] = slip.earnings.filter((l) => l.code === 'adjustment')
    expect(benefit).toMatchObject({ taxable: false, bir: 'other_non_taxable', payCode: 'MAT_SSS_BENEFIT' })
    expect(differential).toMatchObject({ taxable: true, bir: 'other_taxable', payCode: 'MAT_DIFFERENTIAL' })
    expect(slip.basicPay).toBe(5000) // the differential only
    expect(slip.taxableRegular).toBe(0)
    expect(slip.taxableSupplementary).toBeGreaterThan(0)
    expect(slip.trace.warnings.some((w) => w.startsWith('Maternity leave from'))).toBe(false)
    // the P1 setting at "exempt": both are tax-exempt, as before the spec
    const exempt = run(PAY_CODES.map((c) => (c.code === 'MAT_DIFFERENTIAL' ? { ...c, tax_treatment: 'exempt' as const, bir_bucket: 'other_non_taxable' as const, income_class: null } : c)))
    expect(exempt.earnings.filter((l) => l.code === 'adjustment').every((l) => l.taxable === false && l.bir === 'other_non_taxable')).toBe(true)
    expect(exempt.basicPay).toBe(5000)
    expect(exempt.taxableIncome).toBe(0)
    expect(exempt.withholdingTax).toBe(0)
  })
})

describe('PhilHealth employee share paid by the national government', () => {
  it('drops the employee share for a PWD and keeps the employer share', () => {
    const base = pay(monthly, WORKDAYS)
    const pwd = pay({ ...monthly, philhealthEeWaiver: 'pwd' }, WORKDAYS)
    expect(base.philhealthEe).toBe(375)
    expect(pwd.philhealthEe).toBe(0)
    expect(pwd.philhealthEr).toBe(base.philhealthEr)
    expect(pwd.deductions.find((l) => l.code === 'philhealth')).toBeUndefined()
    expect(pwd.trace.notes.some((n) => n.includes('RA 11228'))).toBe(true)
  })

  it('does the same for a solo parent', () => {
    const slip = pay({ ...monthly, philhealthEeWaiver: 'solo_parent' }, WORKDAYS)
    expect(slip.philhealthEe).toBe(0)
    expect(slip.trace.notes.some((n) => n.includes('PhilHealth Circular 2026-0015'))).toBe(true)
  })
})

describe('salary deductions never exceed the salary', () => {
  it('caps a fully absent period at the period salary', () => {
    const slip = pay(monthly, [])
    expect(slip.earnings.find((l) => l.code === 'absence')?.amount).toBe(-15000)
    expect(slip.basicPay).toBe(0)
  })
})

describe('SSS on the month\'s actual compensation (RA 11199 Sec. 8(f))', () => {
  // the first half of the month deducted a provisional half on the ₱30,000 rate
  const firstHalf = {
    sssEe: 500, sssMpfEe: 250, philhealthEe: 375, pagibigEe: 100,
    sssEr: 1000, sssMpfEr: 500, sssEcEr: 15, philhealthEr: 375, pagibigEr: 100,
  }
  const closing = (worked: string[], extra: Partial<PayrollEmployeeInput> = {}, compensationAlready = 15000, leaves: LeaveLite[] = []) =>
    computePayslip({
      employee: { ...monthly, ...extra },
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: computeAttendance({
        periodStart: period.start,
        periodEnd: period.end,
        schedule: monthly.schedule,
        standardHoursPerDay: 8,
        gracePeriodMinutes: 0,
        entries: worked.map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
        holidays: [],
        approvedLeaves: leaves,
      }),
      runType: 'regular',
      monthContributions: { already: firstHalf, compensationAlready, closes: true, opens: false },
    })

  it('settles the month on everything it paid, overtime included', () => {
    const slip = closing(WORKDAYS, { oneTimeEarnings: [{ id: 'o1', label: 'Overtime (Aug 3)', amount: 3000, category: 'overtime' }] })
    // ₱33,000 → MSC 33,000: regular 20,000 (EE 1,000 / ER 2,000), MPF 13,000 (650 / 1,300), EC 30
    expect([slip.sssEe, slip.sssMpfEe, slip.sssEr, slip.sssMpfEr, slip.sssEcEr]).toEqual([500, 400, 1000, 800, 15])
    expect(slip.trace.notes.some((n) => n.startsWith("SSS on the month's compensation ₱33,000"))).toBe(true)
  })

  it('refunds what the first half over-deducted when the month paid less', () => {
    // on maternity leave the whole second half: the month paid ₱15,000 → MSC 15,000, no MPF
    const slip = closing([], {}, 15000, [maternity('2026-08-16')])
    expect(slip.sssEe).toBe(250)
    expect(slip.sssMpfEe).toBe(-250)
    expect(slip.deductions.find((l) => l.code === 'sss_mpf')?.label).toBe('SSS MySSS Pension Booster (MPF) refund')
  })

  it('takes no SSS for a month that paid no compensation', () => {
    const slip = computePayslip({
      employee: monthly,
      settings,
      period,
      tables: DEFAULT_TABLES,
      days: computeAttendance({
        periodStart: period.start,
        periodEnd: period.end,
        schedule: monthly.schedule,
        standardHoursPerDay: 8,
        gracePeriodMinutes: 0,
        entries: [],
        holidays: [],
        approvedLeaves: [maternity('2026-07-20')],
      }),
      runType: 'regular',
      monthContributions: {
        already: { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 },
        compensationAlready: 0,
        closes: true,
        opens: false,
      },
    })
    expect([slip.sssEe, slip.sssEr, slip.sssEcEr]).toEqual([0, 0, 0])
    expect(slip.trace.notes).toContain('No SSS contribution: the month paid no compensation.')
  })

  it('keeps the provisional share on the rate before the month closes', () => {
    const slip = computePayslip({
      employee: monthly,
      settings,
      period: { ...period, index: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      monthContributions: {
        already: { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 },
        compensationAlready: 0,
        closes: false,
        opens: true,
      },
    })
    expect([slip.sssEe, slip.sssMpfEe]).toEqual([500, 250])
  })
})

describe('Pag-IBIG on basic salary plus allowances', () => {
  it('counts the allowances up to the maximum fund salary', () => {
    const partTime: PayrollEmployeeInput = {
      ...monthly,
      monthlyRate: 8000,
      allowances: [{ label: 'Transportation', amount: 1000, category: 'transportation', basis: 'monthly' }],
    }
    const slip = computePayslip({ employee: partTime, settings: { ...settings, contributionTiming: 'last_period' }, period, tables: DEFAULT_TABLES, days: [], runType: 'regular' })
    expect(slip.pagibigEe).toBe(180) // 2% of 9,000
    const capped = computePayslip({ employee: monthly, settings: { ...settings, contributionTiming: 'last_period' }, period, tables: DEFAULT_TABLES, days: [], runType: 'regular' })
    expect(capped.pagibigEe).toBe(200)
  })
})

describe('review fixes (2026-10-24)', () => {
  it('credits grace minutes only up to the shift\'s own hours', () => {
    const halfDay = { start: '08:00', end: '12:00', break_minutes: 0 }
    const sat = '2026-08-22'
    const [d] = computeAttendance({
      periodStart: sat,
      periodEnd: sat,
      schedule: { days: [6], ...halfDay },
      standardHoursPerDay: 8,
      gracePeriodMinutes: 15,
      // Manila 08:10–12:10: the half day's four hours, worked in full
      entries: [{ work_date: sat, clock_in: `${sat}T00:10:00Z`, clock_out: `${sat}T04:10:00Z` }],
      holidays: [],
      approvedLeaves: [],
    })
    expect(d.payableMinutes).toBe(240)
    expect(d.lateMinutes).toBe(0)
  })

  it('warns about maternity pay only in the payroll the leave starts in', () => {
    expect(pay(monthly, WORKDAYS.slice(0, 5), [maternity('2026-08-24')]).trace.warnings.some((w) => w.startsWith('Maternity leave from Aug 24'))).toBe(true)
    // started in the previous payroll: no repeat
    expect(pay(monthly, [], [maternity('2026-08-10')]).trace.warnings.some((w) => w.startsWith('Maternity leave from'))).toBe(false)
  })

  it('takes no provisional SSS from a payroll that paid no compensation', () => {
    const slip = computePayslip({
      employee: monthly,
      settings,
      period: { ...period, index: 1 },
      tables: DEFAULT_TABLES,
      days: computeAttendance({
        periodStart: period.start,
        periodEnd: period.end,
        schedule: monthly.schedule,
        standardHoursPerDay: 8,
        gracePeriodMinutes: 0,
        entries: [],
        holidays: [],
        approvedLeaves: [maternity('2026-08-10')],
      }),
      runType: 'regular',
      monthContributions: {
        already: { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 },
        compensationAlready: 0,
        closes: false,
        opens: true,
      },
    })
    expect([slip.sssEe, slip.sssMpfEe, slip.sssEr]).toEqual([0, 0, 0])
    expect(slip.trace.notes).toContain("No SSS this payroll: it paid no compensation; the month's last payroll settles the month.")
  })

  it('pays no regular holiday before the hire date', () => {
    const holiday = [{ holiday_date: '2026-08-21', name: 'Hypothetical Holiday', kind: 'regular' as const }]
    const run = (employee: PayrollEmployeeInput) =>
      computePayslip({
        employee: { ...employee, hireDate: '2026-08-24' },
        settings,
        period,
        tables: DEFAULT_TABLES,
        days: computeAttendance({
          periodStart: period.start,
          periodEnd: period.end,
          schedule: employee.schedule,
          standardHoursPerDay: 8,
          gracePeriodMinutes: 0,
          entries: WORKDAYS.slice(5).map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
          holidays: holiday,
          approvedLeaves: [],
        }),
        runType: 'regular',
      })
    expect(run(daily).earnings.find((l) => l.code === 'holiday')).toBeUndefined()
    const m = run(monthly)
    // Aug 17–20 are docked as absences; Aug 21, the holiday before the hire, as well
    expect(m.earnings.find((l) => l.code === 'outside_employment')?.amount).toBe(-1379.31)
    expect(m.trace.warnings.some((w) => w.startsWith('Regular holiday not paid'))).toBe(false)
  })
})
