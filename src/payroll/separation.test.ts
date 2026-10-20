import { describe, expect, it } from 'vitest'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip, contributionShare, type ContributionSet } from './engine'
import type { PayrollEmployeeInput, PayrollSettingsInput, PeriodInput } from './types'

// Monthly-rated ₱26,000 employee paid weekly (5 payrolls in October 2026).
const settings = (timing: PayrollSettingsInput['contributionTiming']): PayrollSettingsInput => ({
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: timing,
  payFrequency: 'weekly',
  minimumWageDaily: 755,
})

const emp: PayrollEmployeeInput = {
  id: 'x',
  name: 'Xan',
  payType: 'monthly',
  monthlyRate: 26000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 },
  allowances: [{ label: 'Rice', amount: 2000, category: 'de_minimis', basis: 'monthly' }],
  extraDeductions: [],
}

const NONE: ContributionSet = {
  sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0,
  sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0,
}

function slipAt(index: number, timing: PayrollSettingsInput['contributionTiming'], mc?: { already?: ContributionSet; closes: boolean; opens: boolean }) {
  const period: PeriodInput = { start: '2026-10-12', end: '2026-10-18', index, count: 5 }
  return computePayslip({
    employee: emp,
    settings: settings(timing),
    period,
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'regular',
    monthContributions: mc ? { already: mc.already ?? NONE, closes: mc.closes, opens: mc.opens } : undefined,
  })
}

describe('contributions around separations and hires', () => {
  // the month's full employee SSS share, for reference
  const fullMonth = slipAt(5, 'last_period').sssEe

  it("collects the whole month on a separating employee's last payroll under 'last_period'", () => {
    expect(slipAt(3, 'last_period').sssEe).toBe(0) // plain slot rule: nothing until slot 5
    expect(slipAt(3, 'last_period', { closes: true, opens: false }).sssEe).toBe(fullMonth)
  })

  it("collects what the month still owes under 'split'", () => {
    const share = contributionShare(fullMonth, 'split', { start: '', end: '', index: 1, count: 5 })
    const already = { ...NONE, sssEe: share * 2 }
    expect(slipAt(3, 'split', { already, closes: true, opens: false }).sssEe).toBe(Math.round((fullMonth - share * 2) * 100) / 100)
  })

  it("deducts the month on a mid-month hire's first payroll under 'first_period'", () => {
    expect(slipAt(2, 'first_period').sssEe).toBe(0)
    expect(slipAt(2, 'first_period', { closes: false, opens: true }).sssEe).toBe(fullMonth)
    // ...and nothing more later that month
    expect(slipAt(5, 'first_period', { already: { ...NONE, sssEe: fullMonth }, closes: true, opens: false }).sssEe).toBe(0)
  })
})

describe('final pay released after the last day', () => {
  const slip = computePayslip({
    employee: emp,
    settings: settings('split'),
    period: { start: '2026-11-02', end: '2026-11-08', index: 1, count: 4 },
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'final_pay',
    extrasOnly: true,
  })

  it('pays no basic, allowances or contributions', () => {
    expect(slip.grossPay).toBe(0)
    expect(slip.sssEe + slip.philhealthEe + slip.pagibigEe + slip.sssEr).toBe(0)
  })

  it('still pays one-time items', () => {
    const withExtra = computePayslip({
      employee: { ...emp, oneTimeEarnings: [{ id: 'a', label: 'SIL conversion', amount: 3000, category: 'other_taxable' }] },
      settings: settings('split'),
      period: { start: '2026-11-02', end: '2026-11-08', index: 1, count: 4 },
      tables: DEFAULT_TABLES,
      days: [],
      runType: 'final_pay',
      extrasOnly: true,
    })
    expect(withExtra.grossPay).toBe(3000)
    expect(withExtra.earnings.map((l) => l.label)).toEqual(['SIL conversion'])
  })
})
