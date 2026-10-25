// Owner's answer to the T7 question (2026-10-25): "SIL only" stays the
// default leave policy, and when an admin changes a client's policy during
// the year the year-end adjustment reclassifies that year's leave cash
// conversions under the policy in force: vacation leave in place of SIL —
// de minimis up to the item (a) days a year (in pay-date order), the rest
// to the ₱90k bucket; SIL only — taxable supplementary compensation.
import { describe, expect, it } from 'vitest'
import { summarizeYear, type AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023, DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { reclassifyLeaveConversions } from './leaveConversion'
import type { PayrollEmployeeInput, PayrollSettingsInput } from './types'

const fact = (payDate: string, earnings: AnnualPayslipFact['earnings']): AnnualPayslipFact => ({
  payMonth: `${payDate.slice(0, 7)}-01`, payDate, isMwe: false, earnings, contributionsEe: 0, unionDues: 0, withholdingTax: 0,
})
const basic = { amount: 21750, bir: 'basic' as const, taxable: true, incomeClass: 'regular' as const }
// converted while the client was "SIL only": taxable S
const silMarch = fact('2026-03-31', [basic, { amount: 5000, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary', payCode: 'LEAVE_CONVERSION', days: 5 }])
const silJune = fact('2026-06-30', [basic, { amount: 10000, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary', payCode: 'LEAVE_CONVERSION', days: 10 }])
const conversions = (f: AnnualPayslipFact) => f.earnings.filter((l) => l.payCode === 'LEAVE_CONVERSION').map((l) => [l.bir, l.amount, l.days])

describe('owner 2026-10-25: the YEA reclassifies the year\'s leave conversions', () => {
  it('now vacation leave in place of SIL: 12 days de minimis in pay-date order, the rest to the ₱90k bucket', () => {
    const { facts, changed } = reclassifyLeaveConversions([silJune, silMarch], 'vl_in_place_of_sil', 12)
    expect(changed).toBe(2)
    const [june, march] = facts
    expect(conversions(march)).toEqual([['de_minimis', 5000, 5]])
    expect(conversions(june)).toEqual([['de_minimis', 7000, 7], ['other_benefits', 3000, 3]])
    // the other lines stay as they were
    expect(june.earnings[0]).toBe(basic)
    const s = summarizeYear(facts, BIR_ANNUAL_2023)
    expect([s.deMinimis, s.thirteenthOtherBenefits, s.taxableOtherSupplementary]).toEqual([12000, 3000, 0])
  })

  it('now SIL only: every conversion is taxable supplementary compensation', () => {
    const vl = reclassifyLeaveConversions([silMarch, silJune], 'vl_in_place_of_sil', 12).facts
    const { facts, changed } = reclassifyLeaveConversions(vl, 'sil_only', 12)
    expect(changed).toBe(2)
    expect(facts.map(conversions)).toEqual([[['other_taxable', 5000, 5]], [['other_taxable', 10000, 10]]])
    expect(facts[1].earnings.find((l) => l.payCode === 'LEAVE_CONVERSION')).toMatchObject({ taxable: true, incomeClass: 'supplementary' })
  })

  it('the policy unchanged: the same facts', () => {
    const { facts, changed } = reclassifyLeaveConversions([silMarch, silJune], 'sil_only', 12)
    expect(changed).toBe(0)
    expect(facts[0]).toBe(silMarch)
  })

  it('no ceiling on file: all of it de minimis under vacation leave (as payroll did)', () => {
    expect(conversions(reclassifyLeaveConversions([silJune], 'vl_in_place_of_sil', null).facts[0])).toEqual([['de_minimis', 10000, 10]])
  })

  it('a conversion line without its days is left as it was', () => {
    const old = fact('2026-02-28', [{ amount: 3000, bir: 'other_taxable', taxable: true, payCode: 'LEAVE_CONVERSION' }])
    expect(reclassifyLeaveConversions([old], 'vl_in_place_of_sil', 12)).toEqual({ facts: [old], changed: 0 })
  })
})

describe('owner 2026-10-25: the December year-end adjustment', () => {
  const settings: PayrollSettingsInput = {
    standardHoursPerDay: 8, workingDaysDivisor: 261, gracePeriodMinutes: 0, nightDiffRate: 0.1, contributionTiming: 'split', payFrequency: 'monthly', minimumWageDaily: 500,
  }
  const employee: PayrollEmployeeInput = {
    id: 'e1', name: 'Vi Leave', payType: 'monthly', monthlyRate: 21750, dailyRate: 0, isMinimumWageEarner: false,
    schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 }, allowances: [], extraDeductions: [],
  }
  const december = (leavePolicy: 'vl_in_place_of_sil' | 'sil_only') =>
    computePayslip({
      employee, settings, period: { start: '2026-12-01', end: '2026-12-31', index: 1, count: 1 }, tables: DEFAULT_TABLES, days: [], runType: 'regular',
      leavePolicy,
      // a large bonus earlier in the year so the conversions' tax shows
      annualization: {
        payMonth: '2026-12-01',
        ytd: [silMarch, silJune, { ...fact('2026-05-31', [{ amount: 400000, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary' }]), withholdingTax: 30000 }],
      },
    })

  it('a client now on vacation leave in place of SIL: the conversions\' tax comes back', () => {
    const now = december('vl_in_place_of_sil')
    const before = december('sil_only')
    // 15,000 of conversions out of taxable pay: 20% less tax (35,181.25 due instead of 38,181.25)
    expect(before.withholdingTax - now.withholdingTax).toBe(3000)
    expect(now.trace.notes.join(' ')).toMatch(/classifies 2 earlier payslips' leave cash conversions under the client's leave policy now/)
    expect(before.trace.notes.join(' ')).not.toMatch(/leave cash conversions/)
  })
})
