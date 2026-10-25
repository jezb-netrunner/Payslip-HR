// Spec T3: the SSS base of a month is the pay lines whose pay code has
// sss_include, in the payrolls of that month. Bonuses are in it except the
// Christmas bonus; liquidated transportation, board and lodging are not;
// the P2/P3 items (13th month, de minimis, other non-taxable pay, the
// advanced SSS maternity benefit) are settings, excluded by default.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip, sssCompensation, type MonthContributionsInput } from './engine'
import { PAY_CODES, payCodeOf } from './payCodes'
import { round2, type PayrollEmployeeInput, type PayrollSettingsInput, type PeriodInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'monthly',
  minimumWageDaily: 755,
}
const march: PeriodInput = { start: '2026-03-01', end: '2026-03-31', index: 1, count: 1 }
const employee: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Sol Base',
  payType: 'monthly',
  monthlyRate: 20000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const zero = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }
// the month's only payroll: it settles SSS on the month's pay
const closing: MonthContributionsInput = { already: zero, compensationAlready: 0, closes: true, opens: true }

type Extra = Omit<Partial<Parameters<typeof computePayslip>[0]>, 'employee'>
const pay = (over: Partial<PayrollEmployeeInput>, extra: Extra = {}) =>
  computePayslip({
    employee: { ...employee, ...over },
    settings,
    period: march,
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'regular',
    monthContributions: closing,
    ...extra,
  })

describe('T3 SSS base by pay code', () => {
  it('S1: basic 20,000 + performance bonus 5,000 + Christmas bonus 5,000 + liquidated transport 2,000 + fixed transport 1,000 → 26,000', () => {
    const slip = pay({
      allowances: [
        { label: 'Transport (liquidated)', amount: 2000, category: 'other_non_taxable', basis: 'monthly', payCode: 'LIQUIDATED_ALLOWANCE' },
        { label: 'Transport allowance', amount: 1000, category: 'transportation', basis: 'monthly', payCode: 'TRANSPORTATION' },
      ],
      oneTimeEarnings: [
        { label: 'Performance bonus', amount: 5000, category: 'other_benefits', payCode: 'BONUS' },
        { label: 'Christmas bonus', amount: 5000, category: 'other_benefits', payCode: 'CHRISTMAS_BONUS' },
      ],
    })
    expect(sssCompensation(slip.earnings)).toBe(26000)
    // MSC 26,000: 5% of the 20,000 regular part, 5% of the 6,000 above it (MPF)
    expect(slip.sssEe).toBe(1000)
    expect(slip.sssMpfEe).toBe(300)
    expect(slip.trace.notes.join(' ')).toContain("SSS on the month's compensation ₱26,000")
  })

  it('the Christmas bonus and liquidated allowances are out; other bonuses and compensation are in', () => {
    expect(payCodeOf('CHRISTMAS_BONUS')).toMatchObject({ is_christmas_bonus: true, sss_include: false, bir_bucket: 'other_benefits' })
    expect(payCodeOf('BONUS')).toMatchObject({ is_christmas_bonus: false, sss_include: true })
    expect(payCodeOf('LIQUIDATED_ALLOWANCE')).toMatchObject({ subject_to_liquidation: true, sss_include: false, tax_treatment: 'exempt' })
    const included = [
      'BASIC_ADJ', 'HOLIDAY_ADJ', 'OVERTIME_ADJ', 'NIGHT_DIFF_ADJ', 'REPRESENTATION', 'TRANSPORTATION', 'COLA', 'HOUSING',
      'FIXED_ALLOWANCE', 'HAZARD', 'COMMISSION', 'OTHER_TAXABLE', 'BONUS',
    ]
    for (const c of included) expect(`${c}: ${payCodeOf(c).sss_include}`).toBe(`${c}: true`)
  })

  it('P2/P3: 13th month, de minimis, other non-taxable pay and the advanced SSS maternity benefit are settings, excluded by default', () => {
    const pending = PAY_CODES.filter((c) => c.sss_include_pending).map((c) => c.code).sort()
    expect(pending).toEqual(['DE_MINIMIS', 'MAT_SSS_BENEFIT', 'NON_TAXABLE', 'THIRTEENTH_MONTH'])
    for (const c of pending) expect(payCodeOf(c).sss_include).toBe(false)
  })

  it('a setting switched on puts its code in the base', () => {
    const rice = { label: 'Rice subsidy', amount: 2000, category: 'de_minimis' as const, basis: 'monthly' as const, payCode: 'DE_MINIMIS' }
    expect(sssCompensation(pay({ allowances: [rice] }).earnings)).toBe(20000)
    const on = PAY_CODES.map((c) => (c.code === 'DE_MINIMIS' ? { ...c, sss_include: true } : c))
    expect(sssCompensation(pay({ allowances: [rice] }, { payCodes: on }).earnings)).toBe(22000)
  })

  it('every new line says whether it is in the base; lines saved before T3 keep the old rule', () => {
    const slip = pay({ oneTimeEarnings: [{ label: 'Overtime (Feb)', amount: 1000, category: 'overtime', payCode: 'OVERTIME_ADJ' }] })
    expect(slip.earnings.map((l) => l.sss)).toEqual([true, true])
    // no flag: by BIR bucket, as before (bonuses and de minimis out)
    expect(sssCompensation([{ amount: 2000, bir: 'basic' }, { amount: 1000, bir: 'other_benefits' }, { amount: 300, bir: 'de_minimis' }])).toBe(2000)
  })

  it('13th month pay carries THIRTEENTH_MONTH and is in the base only when the setting is on', () => {
    const thirteenth = (extra: Extra) => pay({}, { runType: 'thirteenth_month', ytdBasicPay: 240000, monthContributions: undefined, ...extra })
    expect(thirteenth({}).earnings[0]).toMatchObject({ payCode: 'THIRTEENTH_MONTH', sss: false, amount: 20000 })
    const on = PAY_CODES.map((c) => (c.code === 'THIRTEENTH_MONTH' ? { ...c, sss_include: true } : c))
    expect(thirteenth({ payCodes: on }).earnings[0].sss).toBe(true)
  })

  it('tax link: the SSS excluded from taxable pay is the SSS actually deducted, a refund included', () => {
    // an earlier payroll of March took SSS on the rate of 30,000 (1,000 + 500 MPF); March paid 20,000
    const slip = pay({}, { monthContributions: { already: { ...zero, sssEe: 1000, sssMpfEe: 500 }, compensationAlready: 0, closes: true, opens: false } })
    expect(slip.sssEe).toBe(0)
    expect(slip.sssMpfEe).toBe(-500)
    expect(slip.taxableRegular).toBe(round2(20000 - (slip.sssEe + slip.sssMpfEe + slip.philhealthEe + slip.pagibigEe)))
  })
})
