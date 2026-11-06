// Opening balances (this employer's pay before going live on the app):
// annualization, the ₱90,000 exemption and the alphalist count them like
// the payslips they replace.
import { describe, expect, it } from 'vitest'
import { annualizedWithholding, summarizeYear, type AnnualPayslipFact } from './annual'
import { buildAlphalist } from './alphalist'
import { BIR_ANNUAL_2023 } from './defaults'
import { blankOpening, openingAppliesTo, openingBenefits, openingFact, openingOverlaps, openingTaxable } from './opening'
import type { Employee, Entity } from '../lib/db'

const month = (m: number) => `2026-${String(m).padStart(2, '0')}-01`

// ₱25,000 a month: SSS ₱1,250 + PhilHealth ₱625 + Pag-IBIG ₱200 = ₱2,075,
// taxable ₱22,925, withheld ₱313.80 a month on the monthly table
// ((22,925 − 20,833) × 15%). The year: 22,925 × 12 = ₱275,100 taxable
// (the ₱25,000 13th month is exempt) → tax due (275,100 − 250,000) × 15% = ₱3,765.
function monthFact(m: number, wht = 313.8, extra: AnnualPayslipFact['earnings'] = []): AnnualPayslipFact {
  return {
    payMonth: month(m),
    payDate: `2026-${String(m).padStart(2, '0')}-28`,
    isMwe: false,
    earnings: [{ amount: 25000, bir: 'basic', taxable: true }, ...extra],
    contributionsEe: 2075,
    unionDues: 0,
    withholdingTax: wht,
  }
}

// January–September before go-live, as the old payroll register totals them
const janSep = {
  ...blankOpening('e1', 2026, '2026-09-30'),
  basic_salary: 225000,
  contributions: 18675,
  tax_withheld: 2824.2,
  thirteenth_basis: 225000,
}

describe('opening balances as a payslip of the year', () => {
  it('maps every column to its BIR Form 2316 bucket, dated the last pay date', () => {
    const f = openingFact({ ...janSep, overtime_pay: 4000, premium_pay: 1500, thirteenth_month: 12500, de_minimis: 9000, commission: 7000 })
    expect(f).toMatchObject({ payMonth: '2026-09-01', payDate: '2026-09-30', isMwe: false, contributionsEe: 18675, unionDues: 0, withholdingTax: 2824.2 })
    expect(f.earnings).toEqual([
      { amount: 225000, bir: 'basic' },
      { amount: 1500, bir: 'premium' },
      { amount: 4000, bir: 'overtime' },
      { amount: 7000, bir: 'commission' },
      { amount: 12500, bir: 'thirteenth' },
      { amount: 9000, bir: 'de_minimis' },
    ])
  })

  it('December annualization withholds the balance instead of refunding the year before go-live', () => {
    const ytd = [openingFact(janSep), monthFact(10), monthFact(11)]
    const december = { ...monthFact(12, 0, [{ amount: 25000, bir: 'thirteenth', taxable: false }]) }
    const { withholding, summary } = annualizedWithholding(ytd, december, BIR_ANNUAL_2023)
    expect(summary.totalTaxable).toBe(275100)
    expect(summary.taxDue).toBe(3765)
    // 3,765 − (2,824.20 + 313.80 × 2)
    expect(withholding).toBe(313.2)
    // the same year with every month in the app gives the same answer
    const allYear = annualizedWithholding(
      Array.from({ length: 11 }, (_, i) => monthFact(i + 1)),
      december,
      BIR_ANNUAL_2023,
    )
    expect(allYear.summary.taxDue).toBe(summary.taxDue)
    expect(allYear.withholding).toBe(withholding)
    // without them: October onward only, so the year's tax is nil and
    // October–November's withholding comes back as a refund
    const without = annualizedWithholding([monthFact(10), monthFact(11)], december, BIR_ANNUAL_2023)
    expect(without.summary.taxDue).toBe(0)
    expect(without.withholding).toBe(-627.6)
  })

  it('counts its 13th month and bonuses against the ₱90,000 exemption', () => {
    const o = { ...janSep, thirteenth_month: 12500, other_benefits: 70000 }
    expect(openingBenefits(o)).toBe(82500)
    // ₱12,500 more 13th month in December: ₱95,000 paid, ₱5,000 taxable
    const s = summarizeYear([openingFact(o), monthFact(10), monthFact(11), monthFact(12, 0, [{ amount: 12500, bir: 'thirteenth' }])], BIR_ANNUAL_2023)
    expect(s.thirteenthOtherBenefits).toBe(95000)
    expect(s.thirteenthOtherBenefitsExempt).toBe(90000)
    expect(s.taxable13thOtherBenefits).toBe(5000)
    expect(s.totalTaxable).toBe(275100 + 5000)
  })

  it("adds its taxable pay to the year to date, after a previous employer's exemption", () => {
    const o = { ...janSep, overtime_pay: 4000, thirteenth_month: 50000, other_benefits: 50000 }
    // 225,000 − 18,675 + 4,000 + (100,000 − 90,000)
    expect(openingTaxable(o, BIR_ANNUAL_2023)).toBe(220325)
    // a previous employer already exempted ₱30,000: ₱40,000 of the benefits is taxable
    const prior = { ...priorNone, thirteenthOtherBenefitsExempt: 30000 }
    expect(openingTaxable(o, BIR_ANNUAL_2023, prior)).toBe(250325)
  })

  it("keeps a minimum wage earner's SMW, holiday and overtime exempt and the rest-day premium taxable", () => {
    const o = { ...blankOpening('e1', 2026, '2026-09-30'), minimum_wage_earner: true, basic_salary: 180000, holiday_pay: 5000, overtime_pay: 3000, premium_pay: 2000, contributions: 9000 }
    const s = summarizeYear([openingFact(o)], BIR_ANNUAL_2023)
    expect(s.mweBasic).toBe(171000)
    expect(s.mweHoliday).toBe(5000)
    expect(s.mweOvertime).toBe(3000)
    expect(s.taxablePremiumMwe).toBe(2000)
    expect(s.totalTaxablePresent).toBe(2000)
    expect(s.allMwe).toBe(true)
  })

  it('applies to pay released after its last pay date, and finds payslips it already covers', () => {
    expect(openingAppliesTo(janSep, '2026-10-05')).toBe(true)
    expect(openingAppliesTo(janSep, '2026-09-30')).toBe(false)
    expect(openingAppliesTo(undefined, '2026-10-05')).toBe(false)
    expect(openingOverlaps(janSep, ['2026-10-05', '2026-09-30', null, '2026-09-15', '2026-09-30'])).toEqual(['2026-09-15', '2026-09-30'])
  })
})

const priorNone = {
  mweExempt: 0, thirteenthOtherBenefitsExempt: 0, deMinimis: 0, contributions: 0, otherNonTaxable: 0,
  taxableBasic: 0, taxable13thOtherBenefits: 0, taxableOther: 0, taxWithheld: 0,
}

describe('alphalist with opening balances', () => {
  const entity = { id: 'ent', working_days_divisor: 261, minimum_wage_region: 'NCR' } as unknown as Entity
  const emp = (id: string, over: Partial<Employee> = {}) =>
    ({
      id, entity_id: 'ent', first_name: 'Grace', last_name: id, hire_date: '2023-09-01', separation_date: null,
      employment_status: 'regular', pay_type: 'monthly', monthly_rate: 25000, daily_rate: 0, tin: '111-111-111',
      birth_date: '1995-05-27', address: 'Makati', zip_code: '1200', ...over,
    }) as unknown as Employee

  it('reports the whole year as this employer, reconciled, and lists who left before go-live', () => {
    const rows = buildAlphalist({
      year: 2026,
      entity,
      employees: [emp('stays'), emp('left', { separation_date: '2026-06-30', separation_reason: 'resignation' })],
      payslips: [10, 11].map((m) => ({ employee_id: 'stays', fact: monthFact(m) })).concat([
        { employee_id: 'stays', fact: { ...monthFact(12, 313.2, [{ amount: 25000, bir: 'thirteenth' }]) } },
      ]),
      taxYears: [],
      openings: [
        { ...janSep, employee_id: 'stays' },
        { ...blankOpening('left', 2026, '2026-06-30'), basic_salary: 150000, contributions: 12450, tax_withheld: 1882.8, thirteenth_month: 12500 },
      ],
      annual: BIR_ANNUAL_2023,
    })
    const stays = rows.find((r) => r.employee.id === 'stays')!
    expect(stays.summary.gross).toBe(325000)
    expect(stays.summary.taxDue).toBe(3765)
    expect(stays.summary.withheldJanNov).toBe(3451.8)
    expect(stays.summary.withheldDec).toBe(313.2)
    expect(stays.summary.variance).toBe(0)
    // same employer all year: still substituted filing, no previous-employer columns
    expect(stays.substitutedFiling).toBe(true)
    expect(stays.summary.prevGross).toBe(0)
    expect(stays.issues).toEqual([])
    const left = rows.find((r) => r.employee.id === 'left')!
    expect(left.summary.gross).toBe(162500)
    expect(left.summary.withheldAsAdjusted).toBe(1882.8)
    expect(left.to).toBe('2026-06-30')
  })

  it('flags payslips the opening balances already cover', () => {
    const rows = buildAlphalist({
      year: 2026,
      entity,
      employees: [emp('stays')],
      payslips: [9, 10].map((m) => ({ employee_id: 'stays', fact: monthFact(m) })),
      taxYears: [],
      openings: [{ ...janSep, employee_id: 'stays' }],
      annual: BIR_ANNUAL_2023,
    })
    expect(rows[0].issues).toEqual(['Opening balances (paid through 2026-09-30) overlap payrolls paid on 2026-09-28: counted twice'])
  })
})
