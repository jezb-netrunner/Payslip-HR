// Owner's answer to the T3 question (2026-10-25): LIQUIDATED_ALLOWANCE is
// only for an expense the employee paid for the employer's business
// (travel, representation), liquidated with receipts — not taxed, not in the
// SSS base. The employee's own board and lodging (BOARD_LODGING) is taxable
// pay for rank-and-file staff; for managerial or supervisory staff it is a
// fringe benefit: flagged for FBT review, not withheld on, and not
// compensation on the 2316. PENDING: the exact conditions in RR 2-98
// §2.78.1(A) and RR 3-98 §2.33.
import { describe, expect, it } from 'vitest'
import { summarizeYear } from './annual'
import { BIR_ANNUAL_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { payCodeOf } from './payCodes'
import type { AllowanceInput, PayrollEmployeeInput, PayrollSettingsInput } from './types'

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
  name: 'Bo Lodge',
  payType: 'monthly',
  monthlyRate: 30000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const boardLodging: AllowanceInput = { label: 'Board and lodging', amount: 3000, category: 'other_taxable', basis: 'monthly', payCode: 'BOARD_LODGING' }
const pay = (over: Partial<PayrollEmployeeInput>) =>
  computePayslip({
    employee: { ...employee, allowances: [boardLodging], ...over },
    settings,
    period: { start: '2026-06-01', end: '2026-06-30', index: 1, count: 1 },
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'regular',
  })
const line = (s: ReturnType<typeof pay>) => s.earnings.find((l) => l.payCode === 'BOARD_LODGING')!

describe('owner 2026-10-25: business reimbursements and board and lodging', () => {
  it('LIQUIDATED_ALLOWANCE repays business expenses liquidated with receipts: not taxed, not in SSS', () => {
    const c = payCodeOf('LIQUIDATED_ALLOWANCE')
    expect(c).toMatchObject({ label: 'Business expense reimbursement (liquidated)', tax_treatment: 'exempt', sss_include: false, subject_to_liquidation: true })
    expect(c.description).toMatch(/travel, representation/)
    expect(c.description).toMatch(/not for the employee's own board and lodging/i)
  })

  it('BOARD_LODGING: the employee\'s own board and lodging, a fringe benefit for managerial or supervisory staff', () => {
    expect(payCodeOf('BOARD_LODGING')).toMatchObject({
      for_allowances: true, for_one_time: true, bir_bucket: 'other_taxable', income_class: 'regular', tax_treatment: 'taxable',
      sss_include: true, fringe_benefit: true,
    })
  })

  it('rank-and-file: taxable pay, regular when paid each period', () => {
    const s = pay({})
    expect(line(s)).toMatchObject({ amount: 3000, taxable: true, incomeClass: 'regular' })
    expect(line(s).fbt).toBeUndefined()
    expect(s.taxableRegular).toBe(33000 - (s.sssEe + s.sssMpfEe + s.philhealthEe + s.pagibigEe))
  })

  it('managerial or supervisory: flagged for FBT review, not withheld on', () => {
    const s = pay({ managerial: true })
    expect(line(s)).toMatchObject({ amount: 3000, taxable: false, fbt: true })
    expect(s.taxableRegular).toBe(30000 - (s.sssEe + s.sssMpfEe + s.philhealthEe + s.pagibigEe))
    expect(s.grossPay).toBe(33000)
    expect(s.trace.warnings.join(' ')).toMatch(/For FBT review: ₱3,000 of board and lodging .* managerial or supervisory employee is a fringe benefit/)
  })

  it('a fringe benefit is not compensation on the 2316', () => {
    const s = summarizeYear([{
      payMonth: '2026-06-01', isMwe: false, contributionsEe: 0, unionDues: 0, withholdingTax: 0,
      earnings: [{ amount: 30000, bir: 'basic', taxable: true }, { amount: 3000, bir: 'other_taxable', taxable: false, fbt: true }],
    }], BIR_ANNUAL_2023)
    expect(s.gross).toBe(30000)
    expect(s.totalTaxablePresent).toBe(30000)
    expect(s.totalNonTaxable).toBe(0)
  })
})
