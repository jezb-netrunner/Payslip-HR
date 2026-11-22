import { describe, expect, it } from 'vitest'
import { ACCOUNTS, payrollJournal, type JournalSlip } from './journal'

const zero = { sss_er: 0, sss_mpf_er: 0, sss_ec_er: 0, philhealth_er: 0, pagibig_er: 0, rounding_adjustment: 0, rounding_carry_in: 0, rounding_carry_out: 0 }

describe('payroll journal entry', () => {
  it('balances an ordinary payslip and splits each payable into employee and employer shares', () => {
    const slip: JournalSlip = {
      ...zero,
      payment_method: 'bank_transfer',
      earnings: [
        { code: 'basic', label: 'Basic Pay', amount: 15000, bir: 'basic' },
        { code: 'absence', label: 'Absences', amount: -1379.31, bir: 'basic' },
        { code: 'ot', label: 'Overtime', amount: 628.59, bir: 'overtime' },
        { code: 'allowance', label: 'Rice', amount: 1000, bir: 'de_minimis' },
      ],
      deductions: [
        { code: 'sss', label: 'SSS', amount: 750 },
        { code: 'philhealth', label: 'PhilHealth', amount: 375 },
        { code: 'pagibig', label: 'Pag-IBIG', amount: 100 },
        { code: 'wht', label: 'Withholding Tax', amount: 432.45 },
        { code: 'other:cash_advance', label: 'Cash advance', amount: 1000 },
        { code: 'other:sss_loan', label: 'SSS loan', amount: 500 },
      ],
      sss_er: 1500, sss_ec_er: 30, philhealth_er: 375, pagibig_er: 100,
      net_pay: 12091.83,
    }
    const j = payrollJournal([slip])
    expect(j.balanced).toBe(true)
    const line = (a: string) => j.lines.find((l) => l.account === a)
    expect(line(ACCOUNTS.salaries)).toEqual({ account: ACCOUNTS.salaries, debit: 14249.28, credit: 0 })
    expect(line(ACCOUNTS.erSss)?.debit).toBe(1530)
    expect(line(ACCOUNTS.sss)?.credit).toBe(2280)
    expect(line(ACCOUNTS.philhealth)?.credit).toBe(750)
    expect(line(ACCOUNTS.tax)?.credit).toBe(432.45)
    expect(line(ACCOUNTS.advances)?.credit).toBe(1000)
    expect(line(ACCOUNTS.sssLoans)?.credit).toBe(500)
    expect(line(ACCOUNTS.netBank)?.credit).toBe(12091.83)
    // debits are listed first
    expect(j.lines.findIndex((l) => l.credit > 0)).toBeGreaterThan(j.lines.findLastIndex((l) => l.debit > 0))
  })

  it('turns refunds and advances into the right side, and keeps rounding and carried centavos apart', () => {
    const slip: JournalSlip = {
      ...zero,
      payment_method: 'cash',
      earnings: [{ code: 'basic', label: 'Basic', amount: 300, bir: 'basic' }],
      deductions: [
        { code: 'sss', label: 'SSS refund', amount: -50 },
        { code: 'philhealth', label: 'PhilHealth', amount: 375 },
        { code: 'ee_collect', label: 'Employee share to collect', amount: -75 },
        { code: 'wht', label: 'Tax refund', amount: -120.4 },
      ],
      philhealth_er: 375,
      // net exact 170.40; 0.35 carried in, rounded up 0.25, 0 carried out
      rounding_adjustment: 0.6, rounding_carry_in: 0.35,
      net_pay: 171,
    }
    const j = payrollJournal([slip])
    expect(j.balanced).toBe(true)
    const line = (a: string) => j.lines.find((l) => l.account === a)
    expect(line(ACCOUNTS.employeeReceivable)?.debit).toBe(75)
    expect(line(ACCOUNTS.tax)?.debit).toBe(120.4)
    expect(line(ACCOUNTS.sss)?.debit).toBe(50)
    expect(line(ACCOUNTS.carried)?.debit).toBe(0.35)
    expect(line(ACCOUNTS.rounding)?.debit).toBe(0.25)
    expect(line(ACCOUNTS.netCash)?.credit).toBe(171)
  })

  it('books the SSS maternity benefit advanced as a receivable, not an expense', () => {
    const j = payrollJournal([
      {
        ...zero,
        payment_method: 'bank_transfer',
        earnings: [
          { code: 'adjustment', label: 'SSS maternity benefit', amount: 70000, bir: 'other_non_taxable', benefit: 'sss_maternity' },
          { code: 'adjustment', label: 'Salary differential', amount: 5000, bir: 'other_non_taxable', benefit: 'maternity_differential' },
        ],
        deductions: [{ code: 'maternity_contributions', label: 'Contributions for the leave months', amount: 2450 }],
        net_pay: 72550,
      },
    ])
    expect(j.balanced).toBe(true)
    expect(j.lines.find((l) => l.account === ACCOUNTS.sssMaternity)?.debit).toBe(70000)
    expect(j.lines.find((l) => l.account === ACCOUNTS.maternityClearing)?.credit).toBe(2450)
  })
})
