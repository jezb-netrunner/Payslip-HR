// Spec T11 (PENDING P5): Pag-IBIG's monthly compensation is a setting — its
// components (basic pay, mandated COLA, other regular allowances) and its
// ceiling. The defaults keep today's rule: basic pay plus the regular
// allowances, up to ₱10,000. Only the compulsory employee share is
// excluded from taxable pay; a voluntary amount above it is not.
import { describe, expect, it } from 'vitest'
import { DEFAULT_PAYROLL_RULES, DEFAULT_TABLES } from './defaults'
import { computePayslip, type MonthContributionsInput } from './engine'
import type { AllowanceInput, PayrollEmployeeInput, PayrollRules, PayrollSettingsInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'monthly',
  minimumWageDaily: 300,
}
const employee: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Paz Ibig',
  payType: 'monthly',
  monthlyRate: 8000,
  dailyRate: 0,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const zero = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }
const closing: MonthContributionsInput = { already: zero, compensationAlready: 0, closes: true, opens: true }
const cola: AllowanceInput = { label: 'COLA', amount: 1000, category: 'cola', basis: 'monthly', payCode: 'COLA' }
const transport: AllowanceInput = { label: 'Transportation', amount: 500, category: 'transportation', basis: 'monthly', payCode: 'TRANSPORTATION' }

const pay = (over: Partial<PayrollEmployeeInput>, rules: Partial<PayrollRules> = {}) =>
  computePayslip({
    employee: { ...employee, allowances: [cola, transport], ...over },
    settings,
    period: { start: '2026-06-01', end: '2026-06-30', index: 1, count: 1 },
    tables: DEFAULT_TABLES,
    days: [],
    runType: 'regular',
    monthContributions: closing,
    rules: { ...DEFAULT_PAYROLL_RULES, ...rules },
  })
const base = (p: { basic: boolean; cola: boolean; otherAllowances: boolean }) => ({ pagibigBase: p })

describe('T11 Pag-IBIG base and ceiling (P5)', () => {
  it('the defaults are today\'s rule: basic pay plus the regular allowances, up to ₱10,000', () => {
    expect(DEFAULT_PAYROLL_RULES.pagibigBase).toEqual({ basic: true, cola: true, otherAllowances: true })
    expect(DEFAULT_PAYROLL_RULES.pagibigCeiling).toBeNull()
    // 8,000 + 1,000 + 500 = 9,500 at 2%
    expect([pay({}).pagibigEe, pay({}).pagibigEr]).toEqual([190, 190])
    expect(pay({ monthlyRate: 20000 }).pagibigEe).toBe(200)
  })

  it('each component is a checkbox', () => {
    expect(pay({}, base({ basic: true, cola: false, otherAllowances: true })).pagibigEe).toBe(170)
    expect(pay({}, base({ basic: true, cola: true, otherAllowances: false })).pagibigEe).toBe(180)
    expect(pay({}, base({ basic: true, cola: false, otherAllowances: false })).pagibigEe).toBe(160)
    expect(pay({}, base({ basic: false, cola: true, otherAllowances: false })).pagibigEe).toBe(10)
  })

  it('the ceiling is a number; unset, it is the statutory table\'s maximum fund salary', () => {
    expect(pay({ monthlyRate: 20000 }, { pagibigCeiling: 15000 }).pagibigEe).toBe(300)
    expect(pay({ monthlyRate: 20000 }, { pagibigCeiling: 15000 }).pagibigEr).toBe(300)
    expect(pay({ monthlyRate: 20000 }, { pagibigCeiling: null }).pagibigEe).toBe(DEFAULT_TABLES.pagibig.max_fund_salary * 0.02)
  })

  it('tax link: only the compulsory employee share is excluded, a voluntary amount above it is not', () => {
    const s = pay({ monthlyRate: 20000, allowances: [], extraDeductions: [{ label: 'Pag-IBIG voluntary contribution', category: 'other', amount: 500 }] })
    expect(s.pagibigEe).toBe(200)
    expect(s.taxableRegular).toBe(20000 - (s.sssEe + s.sssMpfEe + s.philhealthEe + 200))
  })
})
