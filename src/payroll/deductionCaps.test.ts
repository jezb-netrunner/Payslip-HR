// A payroll never collects more than it pays: employee contributions, tax
// and other deductions stop at the pay, and what did not fit is deferred,
// kept in a balance, or recorded as a receivable. Net pay is never negative.

import { describe, expect, it } from 'vitest'
import { DEFAULT_TABLES } from './defaults'
import { computePayslip, type ComputePayslipParams, type ContributionSet } from './engine'
import type { DayComputation, PayrollEmployeeInput, PayrollSettingsInput, PeriodInput } from './types'

const settings: PayrollSettingsInput = {
  standardHoursPerDay: 8,
  workingDaysDivisor: 261,
  gracePeriodMinutes: 0,
  nightDiffRate: 0.1,
  contributionTiming: 'split',
  payFrequency: 'semi_monthly',
  minimumWageDaily: 755,
}
const daily: PayrollEmployeeInput = {
  id: 'e1',
  name: 'Nena Cruz',
  payType: 'daily',
  monthlyRate: 0,
  dailyRate: 800,
  isMinimumWageEarner: false,
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', break_minutes: 60 },
  allowances: [],
  extraDeductions: [],
}
const first: PeriodInput = { start: '2026-10-01', end: '2026-10-15', index: 1, count: 2 }
const second: PeriodInput = { start: '2026-10-16', end: '2026-10-31', index: 2, count: 2 }
const NONE: ContributionSet = { sssEe: 0, sssMpfEe: 0, philhealthEe: 0, pagibigEe: 0, sssEr: 0, sssMpfEr: 0, sssEcEr: 0, philhealthEr: 0, pagibigEr: 0 }

/** `n` ordinary days worked in full. */
function worked(n: number, from = '2026-10-01'): DayComputation[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `${from.slice(0, 8)}${String(Number(from.slice(8)) + i).padStart(2, '0')}`,
    dayType: 'regular' as const,
    scheduled: true,
    workedMinutes: 480,
    payableMinutes: 480,
    expectedMinutes: 480,
    otMinutes: 0,
    nightDiffMinutes: 0,
    ndOtMinutes: 0,
    lateMinutes: 0,
    undertimeMinutes: 0,
    absent: false,
    onPaidLeave: false,
    onUnpaidLeave: false,
  }))
}
const run = (over: Partial<ComputePayslipParams>) =>
  computePayslip({ employee: daily, settings, period: first, tables: DEFAULT_TABLES, days: worked(1), runType: 'regular', ...over })
const sum = (lines: { amount: number }[]) => Math.round(lines.reduce((t, l) => t + l.amount, 0) * 100) / 100

describe('employee contributions never exceed the pay', () => {
  it('a short first payroll of the month defers what it cannot bear to a later payroll', () => {
    // one day's pay (800) against half a month of shares on the rate: SSS 437.50, PhilHealth 217.50, Pag-IBIG 100
    const one = run({ days: worked(1), monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true } })
    expect(one.grossPay).toBe(800)
    expect(one.sssEe + one.sssMpfEe + one.philhealthEe + one.pagibigEe).toBeLessThanOrEqual(800)
    expect(one.netPay).toBeGreaterThanOrEqual(0)
    // a payroll that pays nothing takes nothing
    const none = run({ days: [], monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true } })
    expect(none.grossPay).toBe(0)
    expect(none.totalDeductions).toBe(0)
    expect(none.netPay).toBe(0)
    expect(none.trace.warnings.some((w) => w.includes('negative'))).toBe(false)
  })

  it('says so when it defers, and the closing payroll takes what the month still owes', () => {
    // two hours of pay (200) cannot carry the half-month shares
    const short = run({
      days: worked(1).map((d) => ({ ...d, workedMinutes: 120, payableMinutes: 120, undertimeMinutes: 360 })),
      monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true },
    })
    expect(short.grossPay).toBe(200)
    const taken = Math.round((short.sssEe + short.sssMpfEe + short.philhealthEe + short.pagibigEe) * 100) / 100
    expect(taken).toBe(200)
    expect(short.netPay).toBe(0)
    expect(short.trace.notes.some((n) => n.includes('waits for a later payroll of the month'))).toBe(true)
    // the month's last payroll: 11 days (8,800); it settles the month less what the first one took
    const already: ContributionSet = { ...NONE, sssEe: short.sssEe, sssMpfEe: short.sssMpfEe, philhealthEe: short.philhealthEe, pagibigEe: short.pagibigEe, sssEr: short.sssEr, sssMpfEr: short.sssMpfEr, sssEcEr: short.sssEcEr, philhealthEr: short.philhealthEr, pagibigEr: short.pagibigEr }
    const closing = run({ period: second, days: worked(11, '2026-10-16'), monthContributions: { already, compensationAlready: 200, closes: true, opens: false } })
    const month = Math.round((taken + closing.sssEe + closing.sssMpfEe + closing.philhealthEe + closing.pagibigEe) * 100) / 100
    // SSS on the month's 9,000 (MSC 9,000: 450), PhilHealth on the rate 17,400 (435), Pag-IBIG 200
    expect(month).toBe(450 + 435 + 200)
    expect(closing.netPay).toBeGreaterThan(0)
  })

  it('the closing payroll remits the share in full and records what the pay could not carry as a receivable', () => {
    // the month's last payroll pays one day (800): PhilHealth 435 + Pag-IBIG 200 + SSS on 800 (MSC 5,000: 250) = 885
    const closing = run({ period: second, days: worked(1, '2026-10-16'), monthContributions: { already: NONE, compensationAlready: 0, closes: true, opens: true } })
    const shares = Math.round((closing.sssEe + closing.sssMpfEe + closing.philhealthEe + closing.pagibigEe) * 100) / 100
    expect(shares).toBe(885)
    const collect = closing.deductions.find((l) => l.code === 'ee_collect')
    expect(collect?.amount).toBe(-85)
    expect(closing.netPay).toBe(0)
    expect(sum(closing.deductions)).toBe(closing.totalDeductions)
    expect(closing.trace.warnings.some((w) => w.startsWith('Employee share to collect'))).toBe(true)
  })
})

describe('loans and other deductions stop at the pay left', () => {
  const loan = { id: 'loan-1', label: 'Company loan', category: 'company_loan', amount: 5000, balance: 20000 }
  const hmo = { id: 'hmo-1', label: 'HMO dependents', category: 'hmo', amount: 900 }

  it('takes what is left after contributions and tax, in order, and names the rest', () => {
    const slip = run({ employee: { ...daily, extraDeductions: [loan, hmo] }, days: worked(5), monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true } })
    // 4,000 gross, 755 of shares, no tax: 3,245 left for the loan, nothing for the HMO
    expect(slip.grossPay).toBe(4000)
    expect(slip.deductions.find((l) => l.meta === 'loan-1')?.amount).toBe(3245)
    expect(slip.deductions.some((l) => l.meta === 'hmo-1')).toBe(false)
    expect(slip.otherDeductionsTotal).toBe(3245)
    expect(slip.netPay).toBe(0)
    expect(slip.trace.warnings.some((w) => w.startsWith('Company loan: ₱1,755.00 could not be deducted') && w.includes('stays in the balance'))).toBe(true)
    expect(slip.trace.warnings.some((w) => w.startsWith('HMO dependents: ₱900.00 could not be deducted') && w.includes('later payroll'))).toBe(true)
    expect(slip.trace.warnings.some((w) => w.includes('Net pay is negative'))).toBe(false)
  })

  it('deducts in full when the pay carries it', () => {
    const slip = run({ employee: { ...daily, extraDeductions: [{ ...loan, amount: 1000 }, hmo] }, days: worked(5), monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true } })
    expect(slip.deductions.find((l) => l.meta === 'loan-1')?.amount).toBe(1000)
    expect(slip.deductions.find((l) => l.meta === 'hmo-1')?.amount).toBe(900)
    expect(slip.netPay).toBe(4000 - 755 - 1900)
  })
})

describe('withholding tax never exceeds the pay left after contributions', () => {
  it('a cumulative-average catch-up on a small payroll withholds what the pay carries', () => {
    // the year so far owes far more tax than was withheld; this payroll pays one day
    const slip = run({
      days: worked(1),
      monthContributions: { already: NONE, compensationAlready: 0, closes: false, opens: true },
      taxYear: { taxableBefore: 900000, withheldBefore: 0, periods: 19, cumulative: true },
    })
    expect(slip.withholdingTax).toBeLessThanOrEqual(slip.grossPay)
    expect(slip.netPay).toBe(0)
    expect(slip.trace.notes.some((n) => n.startsWith('Withholding tax due'))).toBe(true)
  })
})
