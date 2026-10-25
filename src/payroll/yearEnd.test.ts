// Spec T8: the year-end adjustment withholds a shortfall only up to the net
// pay available (net pay never goes below 0); the employer pays the rest and
// it is recorded as an advance to the employee. What the employer paid
// counts as paid for the year: a later annualization doesn't take it again.
import { describe, expect, it } from 'vitest'
import { annualizedWithholding, summarizeYear, type AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip, type MonthContributionsInput } from './engine'
import { capYearEndWithholding } from './withholding'
import type { PayrollEmployeeInput, PayrollSettingsInput } from './types'

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
  name: 'Yuri Endo',
  payType: 'monthly',
  monthlyRate: 20000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const zero = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }
const closing: MonthContributionsInput = { already: zero, compensationAlready: 0, closes: true, opens: true }
// January–November: taxable 481,700, of which 25,000 withheld
const ytd: AnnualPayslipFact[] = [
  { payMonth: '2026-11-01', isMwe: false, earnings: [{ amount: 481700, bir: 'basic', taxable: true }], contributionsEe: 0, unionDues: 0, withholdingTax: 25000 },
]
const loan = { label: 'Company loan', category: 'company_loan', amount: 8300 }

type Extra = Omit<Partial<Parameters<typeof computePayslip>[0]>, 'employee'>
const december = (over: Partial<PayrollEmployeeInput>, extra: Extra = {}) =>
  computePayslip({
    employee: { ...employee, ...over },
    settings,
    period: { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 },
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'regular',
    monthContributions: closing,
    annualization: { payMonth: '2026-12-01', ytd },
    ...extra,
  })

// Owner 2026-10-25 (replaces "up to the net pay available"): the last pay
// of the year deducts (1) compulsory contributions and union dues, (2) the
// YEA tax, (3) loans, cash advances and other deductions; the employer pays
// only the part of the tax that is more than the pay left after (1).
const unionDues = { label: 'Union dues', category: 'union_dues', amount: 8300 }
const ytdUnion: AnnualPayslipFact[] = [{ ...ytd[0], earnings: [{ amount: 490000, bir: 'basic', taxable: true }] }]

describe('T8 year-end shortfall', () => {
  it('Y1: tax 42,500 on 500,000, 25,000 withheld: of the 17,500 shortfall the 10,000 pay left is withheld, the employer pays 7,500', () => {
    // contributions 1,700 and union dues 8,300 come first: 10,000 left (and taxable)
    const s = december({ extraDeductions: [unionDues] }, { annualization: { payMonth: '2026-12-01', ytd: ytdUnion } })
    expect(s.sssEe + s.philhealthEe + s.pagibigEe).toBe(1700)
    expect(s.withholdingTax).toBe(10000)
    expect(s.taxPaidByEmployer).toBe(7500)
    expect(s.netPay).toBe(0)
    expect(s.whtMethod).toBe('annualized')
    expect(s.trace.notes.join(' ')).toMatch(/employer pays the remaining ₱7,500/)
  })

  it('the tax comes before loans: the loan gets what is left, the rest stays owed', () => {
    const s = december({ extraDeductions: [{ ...loan, id: 'loan-1' }] })
    expect(s.withholdingTax).toBe(17500)
    expect(s.taxPaidByEmployer).toBe(0)
    expect(s.deductions.find((l) => l.meta === 'loan-1')?.amount).toBe(800)
    expect(s.otherDeductionsTotal).toBe(800)
    expect(s.netPay).toBe(0)
    expect(s.trace.warnings.join(' ')).toMatch(/Company loan: ₱7,500.00 of this payroll's deduction could not be taken: the year-end tax comes first/)
  })

  it('the pay covers the shortfall: all of it is withheld', () => {
    const s = december({})
    expect(s.withholdingTax).toBe(17500)
    expect(s.taxPaidByEmployer).toBe(0)
    expect(s.netPay).toBe(800)
  })

  it('the shortfall is more than the pay: the employer pays the rest, the loan gets nothing, net pay stays 0', () => {
    const s = december({ extraDeductions: [loan] }, { annualization: { payMonth: '2026-12-01', ytd: [{ ...ytd[0], withholdingTax: 0 }] } })
    expect(s.withholdingTax).toBe(18300)
    expect(s.taxPaidByEmployer).toBe(24200)
    expect(s.deductions.some((l) => l.code === 'other:company_loan')).toBe(false)
    expect(s.netPay).toBe(0)
  })

  it('a cash advance is repaid only from what the tax and the loans leave', () => {
    const s = december({ extraDeductions: [loan, { label: 'Cash advance', category: 'cash_advance', amount: 500, upToNet: true, balance: 500 }] })
    expect(s.withholdingTax).toBe(17500)
    expect(s.deductions.some((l) => l.code === 'other:cash_advance')).toBe(false)
    expect(s.trace.warnings.join(' ')).toMatch(/Cash advance: ₱500.00 of this payroll's installment could not be deducted/)
  })

  it('a payroll that does not annualize keeps its order: loans before the tax', () => {
    const s = december({ extraDeductions: [loan] }, { annualization: undefined })
    expect(s.deductions.find((l) => l.code === 'other:company_loan')?.amount).toBe(8300)
  })

  it('a refund is paid in full (never capped)', () => {
    const s = december({}, { annualization: { payMonth: '2026-12-01', ytd: [{ ...ytd[0], withholdingTax: 50000 }] } })
    expect(s.withholdingTax).toBe(-7500)
    expect(s.taxPaidByEmployer).toBe(0)
  })

  it('a 13th month paid after the year was annualized: the cap is the 13th month pay', () => {
    const s = december({}, {
      runType: 'thirteenth_month',
      ytdBasicPay: 12000,
      monthContributions: undefined,
      annualization: { payMonth: '2026-12-01', ytd: [{ ...ytd[0], earnings: [{ amount: 600000, bir: 'basic', taxable: true }] }] },
    })
    // 1,000 of 13th month pay (exempt), tax on 600,000 = 62,500, 25,000 withheld
    expect(s.grossPay).toBe(1000)
    expect(s.withholdingTax).toBe(1000)
    expect(s.taxPaidByEmployer).toBe(36500)
    expect(s.netPay).toBe(0)
  })

  it('capYearEndWithholding: the shortfall up to the pay left after contributions and union dues, never below 0', () => {
    expect(capYearEndWithholding(17500, 10000)).toEqual({ withheld: 10000, paidByEmployer: 7500 })
    expect(capYearEndWithholding(17500, 20000)).toEqual({ withheld: 17500, paidByEmployer: 0 })
    expect(capYearEndWithholding(17500, -300)).toEqual({ withheld: 0, paidByEmployer: 17500 })
    expect(capYearEndWithholding(-7500, 0)).toEqual({ withheld: -7500, paidByEmployer: 0 })
    expect(capYearEndWithholding(1000.005, 999.995)).toEqual({ withheld: 1000, paidByEmployer: 0.01 })
  })
})

describe('T8 tax paid by the employer counts as paid for the year', () => {
  const dec: AnnualPayslipFact = {
    payMonth: '2026-12-01',
    isMwe: false,
    earnings: [{ amount: 20000, bir: 'basic', taxable: true }],
    contributionsEe: 1700,
    unionDues: 0,
    withholdingTax: 10000,
    taxPaidByEmployer: 7500,
  }

  it('the year reconciles: December withholding includes it, nothing is left to withhold', () => {
    const s = summarizeYear([...ytd, dec], BIR_ANNUAL_2023)
    expect(s.taxDue).toBe(42500)
    expect(s.withheldDec).toBe(17500)
    expect(s.paidByEmployer).toBe(7500)
    expect(s.withheldAsAdjusted).toBe(42500)
    expect(s.variance).toBe(0)
  })

  it('a later annualization (a bonus paid on Dec 28) does not withhold it again', () => {
    const bonus: AnnualPayslipFact = { payMonth: '2026-12-01', isMwe: false, earnings: [], contributionsEe: 0, unionDues: 0, withholdingTax: 0 }
    expect(annualizedWithholding([...ytd, dec], bonus, BIR_ANNUAL_2023).withholding).toBe(0)
  })
})
