// Spec T10: the BIR Form 2316 figures — a minimum wage earner's exempt pay
// (statutory minimum wage, holiday, overtime, night shift differential and
// hazard pay) apart from taxable compensation, the previous employer's
// data, and the period ending on the last day for an employee who leaves
// (the 2316 issued at final pay).
import { describe, expect, it } from 'vitest'
import type { Employee, EmployeeTaxYear, Entity } from '../lib/db'
import { buildAlphalist } from './alphalist'
import type { AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023 } from './defaults'
import { form2316Parts, type Form2316Part } from './form2316'

const entity = {
  name: 'Acme Bakery', tin: '000-111-222', tin_branch_code: '00000', registered_address: 'Quezon City', zip_code: '1100',
  working_days_divisor: 313, minimum_wage_region: 'NCR',
} as Entity

const emp = (id: string, extra: Partial<Employee> = {}): Employee =>
  ({
    id, first_name: id.toUpperCase(), last_name: 'Cruz', middle_name: 'Santos', tin: '123-456-789', birth_date: '1990-01-01',
    address: 'Manila', zip_code: '1000', nationality: 'Filipino', hire_date: '2024-01-01', separation_date: null,
    separation_reason: null, employment_status: 'regular', pay_type: 'daily', daily_rate: 755, monthly_rate: 0, days_per_year: null,
    ...extra,
  }) as Employee

const mweMonth = (m: number): AnnualPayslipFact => ({
  payMonth: `2026-${String(m).padStart(2, '0')}-01`,
  isMwe: true,
  earnings: [
    { amount: 19630, bir: 'basic' },
    { amount: 1510, bir: 'holiday' },
    { amount: 943.75, bir: 'overtime' },
    { amount: 75.5, bir: 'night_diff' },
    { amount: 1000, bir: 'hazard', taxable: false },
    // the add-on of rest-day pay above the minimum wage day: taxable S (spec T5)
    { amount: 226.5, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary' },
  ],
  contributionsEe: 0,
  unionDues: 0,
  withholdingTax: 0,
})
const regMonth = (m: number): AnnualPayslipFact => ({
  payMonth: `2026-${String(m).padStart(2, '0')}-01`,
  isMwe: false,
  earnings: [{ amount: 40000, bir: 'basic', taxable: true }],
  contributionsEe: 0,
  unionDues: 0,
  withholdingTax: 2250,
})

const rows = buildAlphalist({
  year: 2026,
  entity,
  employees: [
    emp('mwe', { hazard_criteria_met: true, hazard_dole_cert_ref: 'DOLE-NCR-HZ-2026-014' }),
    emp('reg', { pay_type: 'monthly', monthly_rate: 40000, daily_rate: 0 }),
    emp('left', { pay_type: 'monthly', monthly_rate: 40000, daily_rate: 0, separation_date: '2026-06-30', separation_reason: 'resignation' }),
  ],
  payslips: [
    ...[1, 2, 3].map((m) => ({ employee_id: 'mwe', fact: mweMonth(m) })),
    ...[3, 4, 5].map((m) => ({ employee_id: 'reg', fact: regMonth(m) })),
    ...[1, 2, 3, 4, 5, 6].map((m) => ({ employee_id: 'left', fact: regMonth(m) })),
  ],
  taxYears: [{
    employee_id: 'reg', year: 2026, has_previous_employer: true, prev_employer_tin: '111-222-333', prev_employer_name: 'Old Co',
    prev_employer_address: 'Makati', prev_employer_zip: '1200', prev_employment_from: '2026-01-02', prev_employment_to: '2026-02-27',
    prev_taxable_basic: 50000, prev_tax_withheld: 1000, substituted_filing: 'auto',
  } as EmployeeTaxYear],
  annual: BIR_ANNUAL_2023,
})
const row = (id: string) => rows.find((r) => r.employee.id === id)!
const part = (parts: Form2316Part[], title: string) => parts.find((p) => p.title.startsWith(title))!
const value = (parts: Form2316Part[], title: string, label: string) => part(parts, title).lines.find((l) => l.label.startsWith(label))?.value
const sum = (p: Form2316Part) => p.lines.filter((l) => !l.total && typeof l.value === 'number').reduce((s, l) => s + (l.value as number), 0)

describe('T10 BIR Form 2316 figures', () => {
  it('a minimum wage earner: SMW, holiday, overtime, night shift differential and hazard pay apart from taxable compensation', () => {
    const parts = form2316Parts(row('mwe'), entity, 2026)
    expect(value(parts, 'Part I', 'Minimum wage earner')).toBe('Yes')
    expect(value(parts, 'Part I', 'Statutory minimum wage per day')).toBe(755)
    expect(value(parts, 'Part I', 'Statutory minimum wage per month')).toBe(19692.92)
    const exempt = part(parts, 'Part IV-B A')
    expect(exempt.lines.slice(0, 5).map((l) => [l.label, l.value])).toEqual([
      ['Basic salary or statutory minimum wage (MWE)', 58890],
      ['Holiday pay (MWE)', 4530],
      ['Overtime pay (MWE)', 2831.25],
      ['Night shift differential (MWE)', 226.5],
      ['Hazard pay (MWE)', 3000],
    ])
    // only the rest-day add-on is taxable
    const taxable = [part(parts, 'Part IV-B B (regular)'), part(parts, 'Part IV-B B (supplementary)')]
    expect(taxable.map(sum).reduce((a, b) => a + b, 0)).toBeCloseTo(679.5, 2)
    expect(value(parts, 'Part IV-B B (supplementary)', 'Others (supplementary)')).toBe(679.5)
    // gross = non-taxable + taxable
    expect(value(parts, 'Part IV-A', 'Gross compensation income from present employer')).toBeCloseTo(sum(exempt) + 679.5, 2)
  })

  it('the previous employer\'s TIN, name, address and ZIP, and the year\'s figures with it', () => {
    const parts = form2316Parts(row('reg'), entity, 2026)
    expect(part(parts, 'Part III').lines.map((l) => [l.label, l.value])).toEqual([
      ['TIN', '111-222-333'],
      ["Employer's name", 'Old Co'],
      ['Registered address', 'Makati'],
      ['ZIP code', '1200'],
    ])
    expect(value(parts, 'Part IV-A', 'Add: taxable compensation income from previous employer')).toBe(50000)
    expect(value(parts, 'Part IV-A', 'Taxes withheld — previous employer')).toBe(1000)
    expect(value(parts, 'Part I', 'Minimum wage earner')).toBe('No')
  })

  it('no previous employer: Part III says so', () => {
    expect(part(form2316Parts(row('left'), entity, 2026), 'Part III').lines).toEqual([{ label: 'Previous employer', value: 'None this year' }])
  })

  it('the present employer, and the period of an employee who left ending on the last day (2316 at final pay)', () => {
    const parts = form2316Parts(row('left'), entity, 2026)
    expect(part(parts, 'Part II').lines.map((l) => l.value)).toEqual(['000-111-222-00000', 'Acme Bakery', 'Quezon City', '1100'])
    expect(value(parts, 'Part I', 'For the period')).toBe('2026-01-01 to 2026-06-30')
    expect(value(parts, 'Part I', "Employee's name")).toBe('Cruz, LEFT Santos')
  })
})
