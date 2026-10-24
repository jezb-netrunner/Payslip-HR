import { describe, expect, it } from 'vitest'
import { advanceLedger, advanceStatus, installmentText, nextInstallment, payrollsToRepay, repaymentText } from './advances'

const adv = { id: 'a1', total_amount: 3000, balance: 1300, released_on: '2026-10-05', created_at: '2026-10-05T02:00:00Z' }
const slip = (runId: string, payDate: string, amount: number, finalized = true, meta = 'a1') => ({
  payroll_run_id: runId,
  pay_date: payDate,
  period_start: `${payDate.slice(0, 7)}-01`,
  period_end: `${payDate.slice(0, 7)}-15`,
  finalized,
  deductions: [
    { code: 'sss', label: 'SSS Contribution', amount: 500 },
    { code: 'other:cash_advance', label: 'Cash advance', amount, meta },
  ],
})

describe('cash advance ledger', () => {
  it('runs the balance down through payrolls and repayments in date order', () => {
    const l = advanceLedger(
      adv,
      [slip('r2', '2026-11-05', 1000), slip('r1', '2026-10-20', 500), slip('r3', '2026-11-20', 1000, false), slip('rx', '2026-10-20', 999, true, 'other')],
      [{ id: 'p1', paid_on: '2026-10-25', amount: 200, notes: 'cash' }],
    )
    expect(l.entries.map((e) => [e.kind, e.amount, e.balance])).toEqual([
      ['released', 3000, 3000],
      ['payroll', -500, 2500],
      ['repayment', -200, 2300],
      ['payroll', -1000, 1300],
      ['scheduled', -1000, null],
    ])
    expect(l.paid).toBe(1700)
    expect(l.unexplained).toBe(0)
  })

  it('flags a balance that differs from the ledger', () => {
    expect(advanceLedger({ ...adv, balance: 2000 }, [slip('r1', '2026-10-20', 500)], []).unexplained).toBe(-500)
  })
})

describe('cash advance helpers', () => {
  it('counts payrolls to repay, rounding up', () => {
    expect(payrollsToRepay(3000, 1000)).toBe(3)
    expect(payrollsToRepay(3000, 700)).toBe(5)
    expect(payrollsToRepay(0.3, 0.1)).toBe(3)
    expect(payrollsToRepay(3000, 0)).toBe(0)
  })

  it('names the status', () => {
    expect(advanceStatus({ balance: 0, active: false, start_date: null }, '2026-10-23')).toBe('paid')
    expect(advanceStatus({ balance: 100, active: false, start_date: null }, '2026-10-23')).toBe('paused')
    expect(advanceStatus({ balance: 100, active: true, start_date: '2026-11-01' }, '2026-10-23')).toBe('scheduled')
    expect(advanceStatus({ balance: 100, active: true, start_date: '2026-10-01' }, '2026-10-23')).toBe('active')
  })

  it('adds up the next installments, capped at each balance', () => {
    expect(nextInstallment([
      { balance: 300, amount_per_period: 500, active: true },
      { balance: 2000, amount_per_period: 500, active: true },
      { balance: 900, amount_per_period: 500, active: false },
      { balance: 0, amount_per_period: 500, active: true },
    ])).toBe(800)
  })
})

describe('advances without a fixed installment', () => {
  const adv = (amount_per_period: number, balance = 1000, active = true) => ({ amount_per_period, balance, active })
  it('reads as agreed each payroll', () => {
    expect(installmentText(0)).toBe('amount agreed each payroll')
    expect(installmentText(500)).toBe('₱500.00 per payroll')
    expect(payrollsToRepay(1000, 0)).toBe(0)
  })
  it('sums only the fixed installments and says when others are agreed', () => {
    expect(nextInstallment([adv(0), adv(300)])).toBe(300)
    expect(repaymentText([adv(0), adv(300)])).toBe('₱300.00 per payroll + amounts agreed each payroll')
    expect(repaymentText([adv(0)])).toBe('amount agreed each payroll')
    expect(repaymentText([adv(300), adv(0, 1000, false)])).toBe('₱300.00 per payroll')
  })
})
