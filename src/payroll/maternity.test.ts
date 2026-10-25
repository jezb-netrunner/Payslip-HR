// Spec T4: maternity leave pay. MAT_SSS_BENEFIT is tax-exempt and out of the
// SSS base by default (P3). MAT_DIFFERENTIAL is taxable S by default (P1, a
// setting can make it exempt), in the SSS base, and in the 13th month base
// (P9, a setting). Without a DOLE exemption approval for the payroll year the
// differential is required. PhilHealth and Pag-IBIG during the leave keep
// today's rule (P4, a setting).
import { describe, expect, it } from 'vitest'
import { addDays, eachDate, isoWeekday } from '../lib/manila'
import { computeAttendance } from './attendance'
import { DEFAULT_PAYROLL_RULES, DEFAULT_TABLES } from './defaults'
import { computePayslip, sssCompensation, type MonthContributionsInput } from './engine'
import { PAY_CODES, payCodeOf } from './payCodes'
import { round2, type OneTimeEarningInput, type PayCode, type PayrollEmployeeInput, type PayrollSettingsInput, type PayslipComputation } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'monthly',
  minimumWageDaily: 755,
}
const employee: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Mara Ternidad',
  payType: 'monthly',
  monthlyRate: 30000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const zero = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }
const closing: MonthContributionsInput = { already: zero, compensationAlready: 0, closes: true, opens: true }

/** March 2026 attendance: maternity leave (leave type ML) from `from` to `to`, a full day's work on each weekday before it. */
const onLeave = (from: string, to: string) =>
  computeAttendance({
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    schedule: employee.schedule,
    standardHoursPerDay: 8,
    gracePeriodMinutes: 0,
    // Manila 09:00–18:00
    entries: eachDate('2026-03-01', addDays(from, -1))
      .filter((d) => isoWeekday(d) <= 5)
      .map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
    holidays: [],
    approvedLeaves: [{ start_date: from, end_date: to, paid: true, type_name: 'Maternity leave', type_code: 'ML' }],
  })

const benefit: OneTimeEarningInput = { label: 'SSS maternity benefit', amount: 70000, category: 'other_non_taxable', payCode: 'MAT_SSS_BENEFIT' }
const differential = (amount: number): OneTimeEarningInput => ({ label: 'Maternity salary differential', amount, category: 'other_non_taxable', payCode: 'MAT_DIFFERENTIAL' })
const withCode = (code: string, over: Partial<PayCode>) => PAY_CODES.map((c) => (c.code === code ? { ...c, ...over } : c))
const contributions = (s: PayslipComputation) => round2(s.sssEe + s.sssMpfEe + s.philhealthEe + s.pagibigEe)

type Extra = Omit<Partial<Parameters<typeof computePayslip>[0]>, 'employee'>
// the whole of March on maternity leave
const pay = (oneTimeEarnings: OneTimeEarningInput[], extra: Extra = {}) =>
  computePayslip({
    employee: { ...employee, oneTimeEarnings },
    settings,
    period: { start: '2026-03-01', end: '2026-03-31', index: 1, count: 1 },
    tables: DEFAULT_TABLES,
    days: onLeave('2026-03-01', '2026-03-31'),
    runType: 'regular',
    monthContributions: closing,
    ...extra,
  })

describe('T4 maternity leave', () => {
  it('the pay codes: P1 taxable, P3 SSS out, P9 in the 13th month base — all pending', () => {
    expect(payCodeOf('MAT_DIFFERENTIAL')).toMatchObject({
      tax_treatment: 'taxable', bir_bucket: 'other_taxable', income_class: 'supplementary', tax_pending: true,
      sss_include: true, sss_include_pending: false, include_in_13th_month_base: true, thirteenth_pending: true,
    })
    expect(payCodeOf('MAT_SSS_BENEFIT')).toMatchObject({
      tax_treatment: 'exempt', tax_pending: false, sss_include: false, sss_include_pending: true, include_in_13th_month_base: false,
    })
  })

  it('M1: a differential of 30,000 paid in March is March S (P1 = taxable)', () => {
    const slip = pay([benefit, differential(30000)])
    expect(slip.earnings.find((l) => l.payCode === 'MAT_DIFFERENTIAL')).toMatchObject({ bir: 'other_taxable', taxable: true })
    expect(slip.earnings.find((l) => l.payCode === 'MAT_SSS_BENEFIT')).toMatchObject({ bir: 'other_non_taxable', taxable: false })
    // no salary for the leave days: R is 0, so the contributions come out of S
    expect(slip.taxableRegular).toBe(0)
    expect(slip.taxableSupplementary).toBe(round2(30000 - contributions(slip)))
  })

  it('P1 set to exempt: the differential is tax-exempt, still in the SSS base', () => {
    const exempt = withCode('MAT_DIFFERENTIAL', { tax_treatment: 'exempt', bir_bucket: 'other_non_taxable', income_class: null })
    const slip = pay([benefit, differential(30000)], { payCodes: exempt })
    expect(slip.earnings.find((l) => l.payCode === 'MAT_DIFFERENTIAL')).toMatchObject({ bir: 'other_non_taxable', taxable: false, sss: true })
    expect(slip.taxableIncome).toBe(0)
  })

  it('M2: the differential is in March\'s SSS base, up to the maximum MSC', () => {
    const slip = pay([benefit, differential(30000)])
    expect(sssCompensation(slip.earnings)).toBe(30000) // the advanced SSS benefit is out (P3)
    expect(round2(slip.sssEe + slip.sssMpfEe)).toBe(1500)
    // half of March worked: 13,448.28 salary + 30,000 → the maximum MSC 35,000
    const half = pay([differential(30000)], { days: onLeave('2026-03-16', '2026-03-31') })
    expect(sssCompensation(half.earnings)).toBe(43448.28)
    expect(half.sssEe).toBe(1000)
    expect(half.sssMpfEe).toBe(750)
  })

  it('M3: the differential counts toward the 13th month (P9); the setting can leave it out', () => {
    expect(pay([differential(30000)]).basicPay).toBe(30000)
    expect(pay([differential(30000)], { payCodes: withCode('MAT_DIFFERENTIAL', { include_in_13th_month_base: false }) }).basicPay).toBe(0)
  })

  it('M4: without a DOLE exemption approval for the payroll year, a missing differential is an error', () => {
    expect(pay([benefit]).trace.errors).toEqual(['Differential required: no DOLE exemption approval for this year'])
    // approval_year = the payroll year: the differential may be left blank
    expect(pay([benefit], { maternityDifferentialExempt: true }).trace.errors).toEqual([])
    // a differential on this payslip, or paid earlier in this leave, is enough
    expect(pay([benefit, differential(30000)]).trace.errors).toEqual([])
    expect(pay([benefit], { maternityDifferentialPaid: ['2026-03-05'] }).trace.errors).toEqual([])
    expect(pay([benefit], { maternityDifferentialPaid: ['2026-02-20'] }).trace.errors).toHaveLength(1)
    // no maternity leave, no error
    expect(pay([], { days: [] }).trace.errors).toEqual([])
  })

  it('SSS in a month with no pay at all: none (kept)', () => {
    const slip = pay([benefit], { maternityDifferentialExempt: true })
    expect(sssCompensation(slip.earnings)).toBe(0)
    expect(slip.sssEe).toBe(0)
  })

  it('P4: PhilHealth and Pag-IBIG during the leave follow today\'s rule unless the setting pauses them', () => {
    const asUsual = pay([benefit, differential(30000)])
    expect(asUsual.philhealthEe).toBe(750)
    expect(asUsual.pagibigEe).toBe(200)
    const rules = { ...DEFAULT_PAYROLL_RULES, maternityContributions: 'pause_full_leave' as const }
    const paused = pay([benefit, differential(30000)], { rules })
    expect([paused.philhealthEe, paused.philhealthEr, paused.pagibigEe, paused.pagibigEr]).toEqual([0, 0, 0, 0])
    // a payroll with days worked still deducts them
    const half = pay([differential(30000)], { rules, days: onLeave('2026-03-16', '2026-03-31') })
    expect(half.philhealthEe).toBe(750)
    expect(DEFAULT_PAYROLL_RULES.maternityContributions).toBe('as_usual')
  })
})
