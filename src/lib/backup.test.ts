import { describe, expect, it } from 'vitest'
import { backupSheets, BACKUP_SHEETS, manilaDateTime, type BackupData } from './backup'
import { makeStamp } from './reportStamp'
import type { Employee, Payslip, PayrollRun, PayrollVoid } from './db'

const company = { id: 'e1', name: 'Acme Trading Corporation', registered_address: 'Makati City', tin: '123456789', tin_branch_code: '00000', vat_registered: false }
const stampFor = (title: string) => makeStamp(title, company, { full_name: 'Liza Santos', email: 'liza@acme.ph' }, new Date('2026-10-29T01:15:00Z'))

const run = {
  id: 'r1', control_no: 'PR-000007', run_type: 'regular', pay_frequency: 'semi_monthly', period_start: '2026-10-01', period_end: '2026-10-15',
  pay_date: '2026-10-20', period_month: '2026-10-01', period_index: 1, periods_in_month: 2, status: 'finalized',
  finalized_at: '2026-10-19T08:30:00Z', notes: '', totals: { employees: 1, gross: 10000, net: 8800, withholding_tax: 200 },
} as unknown as PayrollRun
const ana = { id: 'emp1', employee_no: '00012', last_name: 'Reyes', first_name: 'Ana', middle_name: 'Lopez', tin: '000123456' } as unknown as Employee
const slip = {
  id: 's1', payroll_run_id: 'r1', employee_id: 'emp1', control_no: 'PS-000031', pay_date: '2026-10-20', period_start: '2026-10-01', period_end: '2026-10-15',
  employee_snapshot: { name: 'Ana Lopez Reyes', employee_no: '00012', position: 'Clerk' },
  earnings: [{ code: 'basic', label: 'Basic Pay', amount: 10000, hours: 88, taxable: true, bir: 'basic' }],
  deductions: [{ code: 'sss', label: 'SSS', amount: 500 }, { code: 'wtax', label: 'Withholding tax', amount: 200 }, { code: 'ph', label: 'PhilHealth', amount: 250 }, { code: 'pi', label: 'Pag-IBIG', amount: 250 }],
  gross_pay: 10000, total_deductions: 1200, net_pay: 8800, withholding_tax: 200,
} as unknown as Payslip
const voided = {
  id: 'v1', payroll_run_id: 'r1', run_control_no: 'PR-000005', run_snapshot: { ...run, control_no: 'PR-000005' }, reason: 'Wrong overtime',
  voided_by_email: 'liza@acme.ph', voided_at: '2026-10-19T02:00:00Z', payslips: [{ ...slip, control_no: 'PS-000020', net_pay: 8700, gross_pay: 9900 }],
} as unknown as PayrollVoid

const data: BackupData = {
  period: '2026', runs: [run], payslips: [slip], employees: [ana], payRates: [], adjustments: [], deductions: [], repayments: [],
  remittances: [], consultants: [], billings: [], voids: [voided], timeEntries: [
    { id: 't1', employee_id: 'emp1', entity_id: 'e1', work_date: '2026-10-01', clock_in: '2026-10-01T00:02:00Z', clock_out: '2026-10-01T09:05:00Z', source: 'admin', status: 'closed', flags: [], admin_notes: null, manually_edited: false },
  ], leaves: [], audit: [],
}

describe('payroll records backup', () => {
  const sheets = backupSheets(data, stampFor)
  const byName = new Map(sheets.map((s) => [s.name, s]))

  it('has an About sheet listing every sheet with its row count', () => {
    expect(sheets.map((s) => s.name)).toEqual(['About', ...BACKUP_SHEETS.map(([n]) => n)])
    const about = byName.get('About')!
    expect(about.rows.find((r) => r[0] === 'Payslip lines')?.[1]).toBe(5)
    expect(about.rows.find((r) => r[0] === 'Voided payslips')?.[1]).toBe(1)
  })

  it('identifies every sheet: company, VAT status and TIN, title and period, who and when, software', () => {
    const h = byName.get('Payslips')!.heading!
    expect(h[0]).toEqual(['Acme Trading Corporation'])
    expect(h).toContainEqual(['NON-VAT REG TIN 123-456-789-00000'])
    expect(h).toContainEqual(['Payslips, 2026'])
    expect(h.flat().join(' ')).toContain('by Liza Santos (liza@acme.ph)')
    expect(h.flat().join(' ')).toMatch(/Payslip HR v\d/)
  })

  it('writes payslips with their control numbers and one row per line', () => {
    const p = byName.get('Payslips')!
    expect(p.rows[0].slice(0, 5)).toEqual(['PS-000031', 'PR-000007', 'finalized', '00012', 'Ana Lopez Reyes'])
    const lines = byName.get('Payslip lines')!
    expect(lines.rows.map((r) => [r[5], r[7], r[11]])).toEqual([
      ['Earning', 'Basic Pay', 10000],
      ['Deduction', 'SSS', 500],
      ['Deduction', 'Withholding tax', 200],
      ['Deduction', 'PhilHealth', 250],
      ['Deduction', 'Pag-IBIG', 250],
    ])
  })

  it('keeps voided versions with the reason and their own numbers', () => {
    expect(byName.get('Voided payrolls')!.rows[0]).toEqual(['PR-000005', '2026-10-01', '2026-10-15', '2026-10-20', '2026-10-19 10:00', 'liza@acme.ph', 'Wrong overtime', 1, 9900, 8700])
    expect(byName.get('Voided payslips')!.rows[0].slice(0, 3)).toEqual(['PR-000005', 'PS-000020', '00012'])
  })

  it('shows times in Philippine time and names as last, first middle', () => {
    expect(byName.get('Time in-out')!.rows[0].slice(0, 5)).toEqual(['00012', 'Reyes, Ana Lopez', '2026-10-01', '2026-10-01 08:02', '2026-10-01 17:05'])
    expect(manilaDateTime(null)).toBe('')
  })
})
