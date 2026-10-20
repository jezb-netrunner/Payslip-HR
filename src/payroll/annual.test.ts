import { describe, expect, it } from 'vitest'
import { annualizedWithholding, NO_PRIOR_EMPLOYER, summarizeYear, type AnnualPayslipFact } from './annual'
import { computeAttendance } from './attendance'
import { BIR_ANNUAL_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import type { PayrollEmployeeInput, PayrollSettingsInput } from './types'

const month = (m: number) => `2026-${String(m).padStart(2, '0')}-01`

function regular(m: number, basic: number, contributions: number, wht: number, isMwe = false): AnnualPayslipFact {
  return {
    payMonth: month(m),
    isMwe,
    earnings: [{ amount: basic, bir: 'basic', taxable: !isMwe }],
    contributionsEe: contributions,
    unionDues: 0,
    withholdingTax: wht,
  }
}

describe('annual summary (BIR 2316 / alphalist columns)', () => {
  // 30,000/month for 12 months, 2,000 contributions, 1,500 withheld monthly,
  // a ₱70,000 June bonus and a ₱30,000 13th month pay in December.
  const facts: AnnualPayslipFact[] = [
    ...Array.from({ length: 12 }, (_, i) => regular(i + 1, 30000, 2000, 1500)),
    { payMonth: month(6), isMwe: false, earnings: [{ amount: 70000, bir: 'other_benefits' }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
    { payMonth: month(12), isMwe: false, earnings: [{ amount: 30000, bir: 'thirteenth' }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
  ]
  const s = summarizeYear(facts, BIR_ANNUAL_2023)

  it('carves contributions out of basic so gross = non-taxable + taxable', () => {
    expect(s.gross).toBe(460000)
    expect(s.contributions).toBe(24000)
    expect(s.taxableBasic).toBe(336000)
    expect(s.totalNonTaxable + s.totalTaxablePresent).toBe(s.gross)
  })

  it('exempts 13th month + other benefits up to the cap and taxes the excess', () => {
    expect(s.thirteenthOtherBenefits).toBe(100000)
    expect(s.thirteenthOtherBenefitsExempt).toBe(90000)
    expect(s.taxable13thOtherBenefits).toBe(10000)
  })

  it('computes tax due on the annual table and the year-end variance', () => {
    expect(s.totalTaxable).toBe(346000)
    expect(s.taxDue).toBe(14400) // 15% × (346,000 − 250,000)
    expect(s.withheldJanNov).toBe(16500)
    expect(s.withheldDec).toBe(1500)
    expect(s.variance).toBe(-3600) // over-withheld: refund due
  })

  it('treats a full-year minimum wage earner as fully exempt', () => {
    const mweFacts: AnnualPayslipFact[] = [
      ...Array.from({ length: 12 }, (_, i) => regular(i + 1, 20000, 1000, 0, true)),
      { payMonth: month(4), isMwe: true, earnings: [{ amount: 1000, bir: 'holiday' }, { amount: 500, bir: 'overtime' }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
      { payMonth: month(12), isMwe: true, earnings: [{ amount: 20000, bir: 'thirteenth' }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
    ]
    const m = summarizeYear(mweFacts, BIR_ANNUAL_2023)
    expect(m.allMwe).toBe(true)
    expect(m.mweBasic).toBe(228000) // 240,000 SMW less 12,000 contributions
    expect(m.mweHoliday).toBe(1000)
    expect(m.mweOvertime).toBe(500)
    expect(m.totalNonTaxable).toBe(m.gross)
    expect(m.totalTaxablePresent).toBe(0)
    expect(m.taxDue).toBe(0)
  })

  it("shares the cap with a previous employer's exempt benefits", () => {
    const withPrior = summarizeYear(
      [{ payMonth: month(12), isMwe: false, earnings: [{ amount: 60000, bir: 'thirteenth' }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 }],
      BIR_ANNUAL_2023,
      { ...NO_PRIOR_EMPLOYER, thirteenthOtherBenefitsExempt: 50000, taxableBasic: 100000, taxWithheld: 5000 },
    )
    expect(withPrior.thirteenthOtherBenefitsExempt).toBe(40000)
    expect(withPrior.taxable13thOtherBenefits).toBe(20000)
    expect(withPrior.prevTaxable).toBe(100000)
    expect(withPrior.totalTaxable).toBe(120000)
  })

  it('reports annualization refunds separately from December withholding', () => {
    const r = summarizeYear(
      [regular(11, 30000, 2000, 1500), { ...regular(12, 30000, 2000, -2100) }],
      BIR_ANNUAL_2023,
    )
    expect(r.withheldDec).toBe(0)
    expect(r.refunded).toBe(2100)
    expect(r.withheldAsAdjusted).toBe(-600)
  })
})

describe('annualized withholding in the last payroll of the year', () => {
  it('withholds tax due minus tax already withheld (refund when negative)', () => {
    const ytd = [
      ...Array.from({ length: 11 }, (_, i) => regular(i + 1, 30000, 2000, 1500)),
      { payMonth: month(6), isMwe: false, earnings: [{ amount: 70000, bir: 'other_benefits' as const }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
      { payMonth: month(12), isMwe: false, earnings: [{ amount: 30000, bir: 'thirteenth' as const }], contributionsEe: 0, unionDues: 0, withholdingTax: 0 },
    ]
    const { withholding } = annualizedWithholding(ytd, regular(12, 30000, 2000, 0), BIR_ANNUAL_2023)
    expect(withholding).toBe(-2100) // due 14,400 − withheld 16,500
  })

  it('replaces the table withholding on an annualizing payslip', () => {
    const settings: PayrollSettingsInput = {
      standardHoursPerDay: 8,
      workingDaysDivisor: 261,
      gracePeriodMinutes: 0,
      nightDiffRate: 0.1,
      contributionTiming: 'split',
      payFrequency: 'semi_monthly',
      minimumWageDaily: 755,
    }
    const employee: PayrollEmployeeInput = {
      id: 'e1',
      name: 'Juan Dela Cruz',
      payType: 'monthly',
      monthlyRate: 30000,
      dailyRate: 0,
      isMinimumWageEarner: false,
      schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
      allowances: [],
      extraDeductions: [],
    }
    const dates = ['2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23',
      '2026-12-24', '2026-12-28', '2026-12-29', '2026-12-31']
    const days = computeAttendance({
      periodStart: '2026-12-16',
      periodEnd: '2026-12-31',
      schedule: employee.schedule,
      standardHoursPerDay: 8,
      gracePeriodMinutes: 0,
      entries: dates.map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T10:00:00Z` })),
      // Dec 25 and Dec 30 are regular holidays; Dec 24 and 31 special days (worked)
      holidays: [
        { holiday_date: '2026-12-25', name: 'Christmas Day', kind: 'regular' },
        { holiday_date: '2026-12-30', name: 'Rizal Day', kind: 'regular' },
      ],
      approvedLeaves: [],
    })
    // 23 earlier semi-monthly payslips: 15,000 basic, 1,225 contributions, 503.70 withheld
    const ytd: AnnualPayslipFact[] = Array.from({ length: 23 }, (_, i) =>
      regular(Math.floor(i / 2) + 1, 15000, 1225, 503.7),
    )
    const slip = computePayslip({
      employee,
      settings,
      period: { start: '2026-12-16', end: '2026-12-31', index: 2, count: 2 },
      tables: DEFAULT_TABLES,
      days,
      runType: 'regular',
      annualization: { payMonth: month(12), ytd },
    })
    // year: 24 × 15,000 basic − 24 × 1,225 = 330,600 taxable -> due 12,090;
    // withheld so far 23 × 503.70 = 11,585.10 -> this payroll withholds 504.90
    expect(slip.withholdingTax).toBe(504.9)
    expect(slip.deductions.find((l) => l.code === 'wht')?.label).toBe('Withholding Tax (annualized)')
  })
})
