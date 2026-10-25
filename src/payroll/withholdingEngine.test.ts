// Spec T2 and §2 through the payroll engine: each taxable line is regular (R)
// or supplementary (S) compensation by its pay code, contributions come out
// of R first, the ₱90k excess is S, and the method follows the triggers.
import { describe, expect, it } from 'vitest'
import { BIR_WHT_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { computeWithholdingTax } from './statutory'
import { camTotalDue, regularMethodTax, type WithholdingYtdFact } from './withholding'
import type { PayrollEmployeeInput, PayrollSettingsInput, PayslipComputation, PeriodInput } from './types'

const monthly = BIR_WHT_2023.monthly
const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'monthly',
  minimumWageDaily: 755,
}
const june: PeriodInput = { start: '2026-06-01', end: '2026-06-30', index: 1, count: 1 }
const december: PeriodInput = { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 }
const employee: PayrollEmployeeInput = {
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

type Extra = Omit<Partial<Parameters<typeof computePayslip>[0]>, 'employee'>
const pay = (over: Partial<PayrollEmployeeInput>, extra: Extra = {}) =>
  computePayslip({ employee: { ...employee, ...over }, settings, period: june, tables: DEFAULT_TABLES, days: [], runType: 'regular', ...extra })
const contributions = (s: PayslipComputation) => Math.round((s.sssEe + s.sssMpfEe + s.philhealthEe + s.pagibigEe) * 100) / 100

describe('T2 §2: R and S by pay code', () => {
  it('R is basic pay and allowances paid each period; S is overtime, hazard pay, commission and other one-time pay', () => {
    const slip = pay({
      allowances: [
        { label: 'Transportation', amount: 2000, category: 'transportation', basis: 'monthly', payCode: 'TRANSPORTATION' },
        { label: 'Hazard pay', amount: 1000, category: 'hazard', basis: 'monthly', payCode: 'HAZARD' },
      ],
      oneTimeEarnings: [
        { label: 'Overtime (May)', amount: 3000, category: 'overtime', payCode: 'OVERTIME_ADJ' },
        { label: 'Salary adjustment', amount: 500, category: 'basic', payCode: 'BASIC_ADJ' },
        { label: 'Sales commission', amount: 4000, category: 'other_taxable', payCode: 'COMMISSION' },
      ],
    })
    expect(contributions(slip)).toBe(2450)
    expect(slip.taxableRegular).toBe(30050) // 30,000 + 2,000 + 500 − 2,450 contributions
    expect(slip.taxableSupplementary).toBe(8000)
    expect(slip.taxableIncome).toBe(38050)
    expect(slip.whtMethod).toBe('regular')
    // the row from R 30,050 (15%), applied to R + S: 15% × (38,050 − 20,833)
    expect(slip.withholdingTax).toBe(2582.55)
    // the old method found the row from the total: 1,875 + 20% × (38,050 − 33,333)
    expect(computeWithholdingTax(38050, 'monthly', BIR_WHT_2023)).toBe(2818.4)
    expect(slip.earnings.find((l) => l.label === 'Sales commission')?.payCode).toBe('COMMISSION')
    expect(slip.earnings.find((l) => l.label === 'Transportation')?.payCode).toBe('TRANSPORTATION')
  })

  it('a row saved without a pay code uses its category\'s code', () => {
    const slip = pay({
      allowances: [{ label: 'Rice', amount: 1500, category: 'other_taxable', basis: 'monthly' }],
      oneTimeEarnings: [{ label: 'Incentive', amount: 2000, category: 'other_taxable' }],
    })
    // FIXED_ALLOWANCE (an allowance) is R; OTHER_TAXABLE (one-time) is S
    expect(slip.earnings.find((l) => l.label === 'Rice')?.payCode).toBe('FIXED_ALLOWANCE')
    expect(slip.earnings.find((l) => l.label === 'Incentive')?.payCode).toBe('OTHER_TAXABLE')
    expect(slip.taxableRegular).toBe(29050)
    expect(slip.taxableSupplementary).toBe(2000)
  })

  it('without regular pay, contributions come out of S', () => {
    const slip = pay({
      payType: 'daily',
      monthlyRate: 0,
      dailyRate: 1000,
      oneTimeEarnings: [{ label: 'Overtime (May)', amount: 5000, category: 'overtime', payCode: 'OVERTIME_ADJ' }],
    })
    expect(slip.taxableRegular).toBe(0)
    expect(slip.taxableSupplementary).toBe(Math.round((5000 - contributions(slip)) * 100) / 100)
    expect(slip.whtMethod).toBe('cam') // R 0 is in the 0% row and S > 0
  })

  it('W5: the part of a bonus above what is left of the ₱90k is S of the period it is paid', () => {
    const slip = pay(
      { oneTimeEarnings: [{ label: 'Christmas bonus', amount: 20000, category: 'other_benefits', payCode: 'BONUS' }] },
      { period: december, benefitsExemptLeft: 10000 },
    )
    expect(slip.taxableRegular).toBe(27550)
    expect(slip.taxableSupplementary).toBe(10000)
    expect(slip.whtMethod).toBe('regular')
    expect(slip.withholdingTax).toBe(regularMethodTax(27550, 10000, monthly))
    expect(slip.withholdingTax).toBe(2507.55)
  })

  it('an MWE\'s bonus excess is S and starts CAM (the regular method would withhold nothing)', () => {
    const slip = pay(
      {
        monthlyRate: 16000,
        isMinimumWageEarner: true,
        allowances: [{ label: 'Fixed allowance', amount: 1000, category: 'other_taxable', basis: 'monthly', payCode: 'FIXED_ALLOWANCE' }],
        oneTimeEarnings: [{ label: 'Productivity bonus', amount: 60000, category: 'other_benefits', payCode: 'BONUS' }],
      },
      { benefitsExemptLeft: 5000 },
    )
    // contributions come out of the exempt minimum wage
    expect(slip.taxableRegular).toBe(1000)
    expect(slip.taxableSupplementary).toBe(55000)
    expect(regularMethodTax(1000, 55000, monthly)).toBe(0)
    expect(slip.whtMethod).toBe('cam')
    // one period: the table on 56,000 = 1,875 + 20% × 22,667
    expect(slip.withholdingTax).toBe(6408.4)
  })
})

describe('T2: CAM through the engine', () => {
  const regularFact = (m: number, regular: number, supplementary = 0, withheld = 0): WithholdingYtdFact => ({
    payDate: `2026-${String(m).padStart(2, '0')}-28`, regular, supplementary, withheld, method: 'regular', gross: regular + supplementary + 1700,
  })

  it('W2 at the engine: overtime in March with R in the 0% row', () => {
    const slip = computePayslip({
      employee: { ...employee, monthlyRate: 20000, oneTimeEarnings: [{ label: 'Overtime (Feb)', amount: 10000, category: 'overtime', payCode: 'OVERTIME_ADJ' }] },
      settings,
      period: { start: '2026-03-01', end: '2026-03-31', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      withholding: { payDate: '2026-03-31', ytd: [regularFact(1, 18300), regularFact(2, 18300)] },
    })
    expect(slip.whtMethod).toBe('cam')
    expect(slip.withholdingTax).toBe(camTotalDue(36600 + slip.taxableIncome, 3, monthly))
    expect(slip.trace.notes.join(' ')).toMatch(/cumulative average method/i)
  })

  it('W4 at the engine: a previous employer this year (trigger c)', () => {
    const prior = { taxable: 120000, withheld: 5500.2, employedFrom: '2026-01-01' }
    const slip = computePayslip({
      employee,
      settings,
      period: { start: '2026-05-01', end: '2026-05-31', index: 1, count: 1 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'regular',
      withholding: { payDate: '2026-05-31', ytd: [], prior },
    })
    expect(slip.whtMethod).toBe('cam')
    const due = camTotalDue(120000 + slip.taxableIncome, 5, monthly)
    expect(slip.withholdingTax).toBe(Math.round((due - 5500.2) * 100) / 100)
    expect(slip.trace.notes.join(' ')).toMatch(/previous employer/i)
  })

  it('without an earlier payroll this year, the period end is the pay date and the plain table applies', () => {
    const slip = pay({})
    expect(slip.whtMethod).toBe('regular')
    expect(slip.taxableRegular).toBe(27550)
    expect(slip.withholdingTax).toBe(computeWithholdingTax(27550, 'monthly', BIR_WHT_2023))
  })

  it('an annualizing payroll keeps the annual method', () => {
    const slip = pay({}, { period: december, annualization: { payMonth: '2026-12-01', ytd: [] } })
    expect(slip.whtMethod).toBe('annualized')
    expect(slip.taxableRegular).toBe(27550)
  })
})

describe('T2: 13th month runs', () => {
  const year = Array.from({ length: 12 }, (_, i): WithholdingYtdFact => ({
    payDate: `2026-${String(i + 1).padStart(2, '0')}-15`, regular: 30000, supplementary: 0, withheld: 1375.05, method: 'regular', gross: 32450,
  }))
  const thirteenth = (extra: Extra) =>
    computePayslip({ employee, settings, period: december, tables: DEFAULT_TABLES, days: [], runType: 'thirteenth_month', ytdBasicPay: 240000, ...extra })

  it('the excess over the ₱90k is S and is withheld by CAM', () => {
    const slip = thirteenth({ taxYearBenefitsPaid: 85000, withholding: { payDate: '2026-12-20', ytd: year } })
    expect(slip.grossPay).toBe(20000)
    expect(slip.taxableIncome).toBe(15000)
    expect(slip.taxableRegular).toBe(0)
    expect(slip.taxableSupplementary).toBe(15000)
    expect(slip.whtMethod).toBe('cam')
    // 12 periods: 15% × (375,000 − 12 × 20,833) = 18,750.60 due, less 16,500.60 withheld
    expect(slip.withholdingTax).toBe(2250)
  })

  it('a 13th month within the ₱90k withholds nothing and does not start CAM', () => {
    const slip = thirteenth({ withholding: { payDate: '2026-12-20', ytd: [{ ...year[0], supplementary: 5000 }] } })
    expect(slip.taxableIncome).toBe(0)
    expect(slip.whtMethod).toBe('regular')
    expect(slip.withholdingTax).toBe(0)
  })
})
