// Spec T7: de minimis benefits are exempt only up to their ceilings (RR
// 29-2025), tracked per item over the ceiling's month, semester or year; the
// excess joins the ₱90k bucket. Leave cash conversion: under
// vl_in_place_of_sil, up to 12 days a year are de minimis (the rest to the
// ₱90k bucket); under sil_only it is SIL conversion, taxable S.
import { describe, expect, it } from 'vitest'
import { computeAttendance } from './attendance'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip } from './engine'
import { payCodeOf } from './payCodes'
import type { AllowanceInput, OneTimeEarningInput, PayrollEmployeeInput, PayrollSettingsInput, PayslipComputation } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'monthly',
  minimumWageDaily: 500,
}
// daily rate 21,750 × 12 / 261 = 1,000
const employee: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Dee Minimis',
  payType: 'monthly',
  monthlyRate: 21750,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const june = { start: '2026-06-01', end: '2026-06-30', index: 1, count: 1 }

type Extra = Omit<Partial<Parameters<typeof computePayslip>[0]>, 'employee'>
const pay = (over: Partial<PayrollEmployeeInput>, extra: Extra = {}) =>
  computePayslip({ employee: { ...employee, ...over }, settings, period: june, tables: DEFAULT_TABLES, days: [], runType: 'regular', ...extra })
const linesOf = (s: PayslipComputation, code: string) => s.earnings.filter((l) => l.payCode === code).map((l) => [l.bir, l.amount])

const conversion = (days: number): OneTimeEarningInput => ({ label: `Leave conversion (${days} days)`, amount: days * 1000, category: 'de_minimis', payCode: 'LEAVE_CONVERSION', days })
const allowance = (code: string, amount: number): AllowanceInput => ({ label: payCodeOf(code).label, amount, category: 'de_minimis', basis: 'monthly', payCode: code })
const oneTime = (code: string, amount: number): OneTimeEarningInput => ({ label: payCodeOf(code).label, amount, category: 'de_minimis', payCode: code })

describe('T7 leave cash conversion', () => {
  it('D1: vl_in_place_of_sil, 15 unused VL days × 1,000: de minimis 12,000 and 3,000 to the ₱90k bucket', () => {
    const s = pay({ oneTimeEarnings: [conversion(15)] }, { leavePolicy: 'vl_in_place_of_sil' })
    expect(linesOf(s, 'LEAVE_CONVERSION')).toEqual([['de_minimis', 12000], ['other_benefits', 3000]])
    expect(s.earnings.find((l) => l.bir === 'de_minimis')?.days).toBe(12)
    // within what is left of the ₱90,000: not taxed now
    expect(s.taxableSupplementary).toBe(0)
  })

  it('the 12 days are per year: 10 converted earlier leave 2', () => {
    const s = pay({ oneTimeEarnings: [conversion(5)] }, { leavePolicy: 'vl_in_place_of_sil', deMinimisUsed: { a: 10 } })
    expect(linesOf(s, 'LEAVE_CONVERSION')).toEqual([['de_minimis', 2000], ['other_benefits', 3000]])
  })

  it('D2: sil_only, 5 SIL days × 1,000: all 5,000 is S', () => {
    const s = pay({ oneTimeEarnings: [conversion(5)] }, { leavePolicy: 'sil_only' })
    expect(s.earnings.filter((l) => l.payCode === 'LEAVE_CONVERSION').map((l) => [l.bir, l.amount, l.taxable, l.incomeClass])).toEqual([
      ['other_taxable', 5000, true, 'supplementary'],
    ])
    expect(s.taxableSupplementary).toBe(5000)
  })

  it('without a leave policy the client is taken as SIL only', () => {
    expect(linesOf(pay({ oneTimeEarnings: [conversion(5)] }), 'LEAVE_CONVERSION')).toEqual([['other_taxable', 5000]])
  })
})

describe('T7 de minimis ceilings per item', () => {
  it('D3: a rice subsidy of 3,000 in a month: de minimis 2,500 and 500 to the ₱90k bucket', () => {
    const s = pay({ allowances: [allowance('DM_RICE', 3000)] })
    expect(linesOf(s, 'DM_RICE')).toEqual([['de_minimis', 2500], ['other_benefits', 500]])
  })

  it('a monthly ceiling counts what the month already paid', () => {
    const s = pay({ allowances: [allowance('DM_RICE', 1500)] }, { deMinimisUsed: { d: 1500 } })
    expect(linesOf(s, 'DM_RICE')).toEqual([['de_minimis', 1000], ['other_benefits', 500]])
  })

  it('a semester ceiling (c) and a yearly one (i)', () => {
    const s = pay({ oneTimeEarnings: [oneTime('DM_MEDICAL_DEPENDENTS', 1000), oneTime('DM_GIFTS', 8000)] }, { deMinimisUsed: { c: 1500 } })
    expect(linesOf(s, 'DM_MEDICAL_DEPENDENTS')).toEqual([['de_minimis', 500], ['other_benefits', 500]])
    expect(linesOf(s, 'DM_GIFTS')).toEqual([['de_minimis', 6000], ['other_benefits', 2000]])
  })

  it('two lines of one item share its ceiling', () => {
    const s = pay({ allowances: [allowance('DM_LAUNDRY', 300)], oneTimeEarnings: [oneTime('DM_LAUNDRY', 300)] })
    expect(linesOf(s, 'DM_LAUNDRY')).toEqual([['de_minimis', 300], ['de_minimis', 100], ['other_benefits', 200]])
  })

  it('(j) the meal allowance: 30% of the minimum wage per day of overtime or night work', () => {
    // two days with 2 hours' overtime (Manila 09:00–20:00), SMW 500: 2 × 150 = 300
    const days = computeAttendance({
      periodStart: june.start,
      periodEnd: june.end,
      schedule: employee.schedule,
      standardHoursPerDay: 8,
      gracePeriodMinutes: 0,
      entries: ['2026-06-01', '2026-06-02'].map((d) => ({ work_date: d, clock_in: `${d}T01:00:00Z`, clock_out: `${d}T12:00:00Z` })),
      holidays: [],
      approvedLeaves: [],
    })
    const s = pay({ oneTimeEarnings: [oneTime('DM_MEAL', 500)] }, { days })
    expect(linesOf(s, 'DM_MEAL')).toEqual([['de_minimis', 300], ['other_benefits', 200]])
  })

  it('D4: no ceilings on file for the pay date (before 2026-01-07): not checked, and said so', () => {
    const s = pay({ allowances: [allowance('DM_RICE', 3000)] }, { tables: { ...DEFAULT_TABLES, de_minimis: undefined } })
    expect(linesOf(s, 'DM_RICE')).toEqual([['de_minimis', 3000]])
    expect(s.trace.warnings.join(' ')).toMatch(/No de minimis ceilings on file for this pay date/)
  })

  it('a de minimis line saved before the items (generic code): not checked, and said so', () => {
    const s = pay({ allowances: [allowance('DE_MINIMIS', 3000)] })
    expect(linesOf(s, 'DE_MINIMIS')).toEqual([['de_minimis', 3000]])
    expect(s.trace.warnings.join(' ')).toMatch(/no de minimis item/)
  })

  it('the excess counts toward the ₱90k: past what is left of it, it is S', () => {
    const s = pay({ allowances: [allowance('DM_RICE', 3000)] }, { benefitsExemptLeft: 200 })
    expect(s.taxableSupplementary).toBe(300)
  })
})
