// Spec T10 with the owner's answers (2026-10-25): BIR Form 2316 September
// 2021 (ENCS) (RMC 34-2022), its item numbers printed. A minimum wage
// earner's exempt pay (items 29–33) apart from taxable compensation, the
// previous employer's data (Part III), the period ending on the last day
// for an employee who leaves (the 2316 at final pay), and: taxable pay for
// the year (this and any previous employer) of ₱250,000 or less is
// reported as non-taxable — basic salary in item 29, the rest in item 37 —
// with tax due 0.
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
    id, first_name: id.toUpperCase(), last_name: 'Cruz', middle_name: 'Santos', suffix: null, tin: '123-456-789', birth_date: '1990-01-01',
    address: 'Manila', zip_code: '1000', nationality: 'Filipino', hire_date: '2024-01-01', separation_date: null,
    separation_reason: null, employment_status: 'regular', pay_type: 'daily', daily_rate: 755, monthly_rate: 0, days_per_year: null,
    phone: '0917 000 0000', rdo_code: '039', local_address: 'Antipolo', local_zip_code: '1870', foreign_address: null,
    ...extra,
  }) as Employee

const fact = (m: number, isMwe: boolean, earnings: AnnualPayslipFact['earnings'], withholdingTax = 0): AnnualPayslipFact => ({
  payMonth: `2026-${String(m).padStart(2, '0')}-01`, isMwe, earnings, contributionsEe: 0, unionDues: 0, withholdingTax,
})
const mweMonth = (m: number) =>
  fact(m, true, [
    { amount: 19630, bir: 'basic' },
    { amount: 1510, bir: 'holiday' },
    { amount: 943.75, bir: 'overtime' },
    { amount: 75.5, bir: 'night_diff' },
    { amount: 1000, bir: 'hazard', taxable: false },
    // the add-on of rest-day pay above the minimum wage day: taxable S (spec T5)
    { amount: 226.5, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary' },
  ])
const commission = fact(4, true, [{ amount: 300000, bir: 'other_taxable', taxable: true, incomeClass: 'supplementary', payCode: 'COMMISSION' }])
const monthOf = (m: number, basic: number, wht: number) => fact(m, false, [{ amount: basic, bir: 'basic', taxable: true, incomeClass: 'regular' }], wht)

const rows = buildAlphalist({
  year: 2026,
  entity,
  employees: [
    emp('mwe', { hazard_criteria_met: true, hazard_dole_cert_ref: 'DOLE-NCR-HZ-2026-014' }),
    emp('reg', { pay_type: 'monthly', monthly_rate: 40000, daily_rate: 0 }),
    emp('left', { pay_type: 'monthly', monthly_rate: 50000, daily_rate: 0, separation_date: '2026-06-30', separation_reason: 'resignation' }),
    emp('low', { pay_type: 'monthly', monthly_rate: 10000, daily_rate: 0, foreign_address: '12 Rue X, Paris' }),
  ],
  payslips: [
    ...[1, 2, 3].map((m) => ({ employee_id: 'mwe', fact: mweMonth(m) })),
    { employee_id: 'mwe', fact: commission },
    ...[3, 4, 5].map((m) => ({ employee_id: 'reg', fact: monthOf(m, 40000, 0) })),
    ...[1, 2, 3, 4, 5, 6].map((m) => ({ employee_id: 'left', fact: monthOf(m, 50000, 3500) })),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => ({ employee_id: 'low', fact: monthOf(m, 10000, 0) })),
    { employee_id: 'low', fact: fact(12, false, [{ amount: 5000, bir: 'overtime', taxable: true, incomeClass: 'supplementary' }]) },
  ],
  taxYears: [
    {
      employee_id: 'reg', year: 2026, has_previous_employer: true, prev_employer_tin: '111-222-333', prev_employer_name: 'Old Co',
      prev_employer_address: 'Makati', prev_employer_zip: '1200', prev_employment_from: '2026-01-02', prev_employment_to: '2026-02-27',
      prev_taxable_basic: 50000, prev_tax_withheld: 1000, substituted_filing: 'auto', employer_type: 'main',
    } as EmployeeTaxYear,
    { employee_id: 'left', year: 2026, has_previous_employer: false, substituted_filing: 'auto', employer_type: 'secondary' } as EmployeeTaxYear,
  ],
  annual: BIR_ANNUAL_2023,
})
const row = (id: string) => rows.find((r) => r.employee.id === id)!
const lines = (parts: Form2316Part[]) => parts.flatMap((p) => p.lines)
const item = (parts: Form2316Part[], n: string) => {
  const l = lines(parts).find((x) => x.item === n)
  if (!l) throw new Error(`no item ${n}`)
  return l
}
const val = (parts: Form2316Part[], n: string) => item(parts, n).value

describe('T10 BIR Form 2316 (September 2021 ENCS), item by item', () => {
  it('every item of the form, in its order', () => {
    expect(lines(form2316Parts(row('reg'), entity, 2026)).map((l) => l.item)).toEqual([
      '1', '2', '3', '4', '5', '6', '6A', '6B', '6C', '6D', '7', '8', '9', '10', '11',
      '12', '13', '14', '14A', '15',
      '16', '17', '18', '18A',
      '19', '20', '21', '22', '23', '24', '25A', '25B', '26', '27', '28',
      '29', '30', '31', '32', '33', '34', '35', '36', '37', '38',
      '39', '40', '41', '42', '43', '44A', '44B',
      '45', '46', '47', '48', '49', '50', '51A', '51B', '52',
      '53', '54', '55', '56',
    ])
  })

  it('Part I: the employee, items 1 to 11', () => {
    const p = form2316Parts(row('low'), entity, 2026)
    expect(['1', '2', '3', '4', '5', '6', '6A', '6B', '6C', '6D', '7', '8'].map((n) => val(p, n))).toEqual([
      '2026', '2026-01-01 to 2026-12-31', '123-456-789', 'Cruz, LOW Santos', '039', 'Manila', '1000', 'Antipolo', '1870', '12 Rue X, Paris',
      '1990-01-01', '0917 000 0000',
    ])
    expect(val(p, '11')).toBe('No')
    const m = form2316Parts(row('mwe'), entity, 2026)
    expect([val(m, '9'), val(m, '10'), val(m, '11')]).toEqual([755, 19692.92, 'Yes'])
  })

  it('Part II: the present employer, main or secondary (item 15)', () => {
    const p = form2316Parts(row('reg'), entity, 2026)
    expect(['12', '13', '14', '14A', '15'].map((n) => val(p, n))).toEqual(['000-111-222-00000', 'Acme Bakery', 'Quezon City', '1100', 'Main employer'])
    expect(val(form2316Parts(row('left'), entity, 2026), '15')).toBe('Secondary employer')
  })

  it('Part III: the previous employer, items 16 to 18A (blank without one)', () => {
    expect(['16', '17', '18', '18A'].map((n) => val(form2316Parts(row('reg'), entity, 2026), n))).toEqual(['111-222-333', 'Old Co', 'Makati', '1200'])
    expect(['16', '17', '18', '18A'].map((n) => val(form2316Parts(row('left'), entity, 2026), n))).toEqual(['', '', '', ''])
  })

  it('a minimum wage earner: items 29–33 apart from taxable compensation; commission is item 45', () => {
    const p = form2316Parts(row('mwe'), entity, 2026)
    expect(['29', '30', '31', '32', '33'].map((n) => val(p, n))).toEqual([58890, 4530, 2831.25, 226.5, 3000])
    expect([val(p, '45'), val(p, '46'), val(p, '47'), val(p, '51A'), val(p, '51B'), val(p, '52')]).toEqual([300000, 0, 0, 679.5, 0, 300679.5])
    expect(val(p, '38')).toBe(69477.75)
    // 19 = 38 + 52, 21 from 52
    expect(val(p, '19')).toBe(370157.25)
    expect(val(p, '21')).toBe(300679.5)
  })

  it('Part IV-A: the previous employer\'s taxable pay and tax, the totals', () => {
    const p = form2316Parts(row('reg'), entity, 2026)
    expect([val(p, '22'), val(p, '25B')]).toEqual([50000, 1000])
    expect([val(p, '26'), val(p, '28')]).toEqual([1000, 1000])
  })

  it('₱250,000 or less for the year (this and any previous employer): basic salary in item 29, the rest in item 37, tax due 0', () => {
    // 120,000 here and 50,000 at the previous employer
    const reg = form2316Parts(row('reg'), entity, 2026)
    expect([val(reg, '29'), val(reg, '37'), val(reg, '38'), val(reg, '39'), val(reg, '52'), val(reg, '21')]).toEqual([120000, 0, 120000, 0, 0, 0])
    expect([val(reg, '22'), val(reg, '23'), val(reg, '24')]).toEqual([50000, 50000, 0])
    const low = form2316Parts(row('low'), entity, 2026)
    expect([val(low, '29'), val(low, '37'), val(low, '50'), val(low, '52')]).toEqual([120000, 5000, 0, 0])
    // above it: as computed
    const left = form2316Parts(row('left'), entity, 2026)
    expect([val(left, '29'), val(left, '39'), val(left, '52')]).toEqual([0, 300000, 300000])
  })

  it('the caps the labels name come from the annual tax table', () => {
    const p = form2316Parts(row('reg'), entity, 2026)
    expect(item(p, '29').label).toMatch(/exempt ₱250,000 & below/)
    expect(item(p, '34').label).toMatch(/maximum of ₱90,000/)
  })

  it('signatures: items 53 to 56, the last two for substituted filing', () => {
    const p = form2316Parts(row('low'), entity, 2026)
    expect(['53', '54', '55', '56'].map((n) => item(p, n).signature)).toEqual([true, true, true, true])
    expect(item(p, '55').label).toMatch(/substituted filing/i)
  })
})
