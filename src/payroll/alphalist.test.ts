import { describe, expect, it } from 'vitest'
import type { Employee, EmployeeTaxYear, Entity } from '../lib/db'
import { alphalistCsv, buildAlphalist } from './alphalist'
import type { AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023 } from './defaults'

const entity = { working_days_divisor: 313, minimum_wage_region: 'NCR' } as Entity

function emp(id: string, extra: Partial<Employee> = {}): Employee {
  return {
    id,
    first_name: id.toUpperCase(),
    last_name: 'Cruz',
    middle_name: null,
    tin: '123-456-789',
    birth_date: '1990-01-01',
    address: 'Manila',
    zip_code: '1000',
    nationality: 'Filipino',
    hire_date: '2024-01-01',
    separation_date: null,
    separation_reason: null,
    employment_status: 'regular',
    pay_type: 'daily',
    daily_rate: 755,
    monthly_rate: 0,
    days_per_year: null,
    ...extra,
  } as Employee
}

const fact = (m: number, isMwe: boolean, basic: number, wht = 0): AnnualPayslipFact => ({
  periodMonth: `2026-${String(m).padStart(2, '0')}-01`,
  isMwe,
  earnings: [{ amount: basic, bir: 'basic' }],
  contributionsEe: 0,
  unionDues: 0,
  withholdingTax: wht,
})

describe('1604-C alphalist rows', () => {
  const rows = buildAlphalist({
    year: 2026,
    entity,
    employees: [
      emp('mwe'),
      emp('reg', { pay_type: 'monthly', monthly_rate: 40000, daily_rate: 0, hire_date: '2026-03-01', employment_status: 'probationary' }),
      emp('left', { separation_date: '2026-06-30', separation_reason: 'resignation', tin: null }),
      emp('none'),
    ],
    payslips: [
      ...[1, 2, 3].map((m) => ({ employee_id: 'mwe', fact: fact(m, true, 19630) })),
      // 40,000 × 10 months = 400,000 taxable -> due 22,500; 2,250/month withheld
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => ({ employee_id: 'reg', fact: fact(m, false, 40000, 2250) })),
      { employee_id: 'left', fact: fact(6, false, 10000) },
    ],
    taxYears: [{ employee_id: 'reg', year: 2026, has_previous_employer: true, prev_employer_tin: '111-222-333', prev_employer_name: 'Old Co', prev_tax_withheld: 0, substituted_filing: 'auto' } as EmployeeTaxYear],
    annual: BIR_ANNUAL_2023,
  })

  it('skips employees with no payslips and assigns schedules', () => {
    expect(rows.map((r) => [r.employee.id, r.schedule])).toEqual([
      ['left', 1],
      ['mwe', 2],
      ['reg', 1],
    ])
  })

  it('records employment dates, BIR codes and separation', () => {
    const reg = rows.find((r) => r.employee.id === 'reg')!
    expect([reg.from, reg.to, reg.statusCode, reg.separationCode]).toEqual(['2026-03-01', '2026-12-31', 'P', ''])
    const left = rows.find((r) => r.employee.id === 'left')!
    expect([left.from, left.to, left.separationCode]).toEqual(['2026-01-01', '2026-06-30', 'T'])
    expect(left.issues).toContain('No TIN')
  })

  it('derives the statutory minimum wage figures for Schedule 2', () => {
    const m = rows.find((r) => r.employee.id === 'mwe')!
    expect([m.smwPerDay, m.factor, m.smwPerYear, m.region]).toEqual([755, 313, 236315, 'NCR'])
    expect(m.summary.taxDue).toBe(0)
    expect(m.substitutedFiling).toBe(true)
  })

  it('does not mark substituted filing for employees with a previous employer', () => {
    const reg = rows.find((r) => r.employee.id === 'reg')!
    expect(reg.summary.taxDue).toBe(22500)
    expect(reg.summary.variance).toBe(0)
    expect(reg.substitutedFiling).toBe(false)
    expect(reg.prevEmployerTin).toBe('111-222-333')
  })

  it('exports one CSV per schedule with matching column counts', () => {
    const s1 = alphalistCsv(rows, 1)
    const s2 = alphalistCsv(rows, 2)
    expect(s1).toHaveLength(3) // header + 2
    expect(s2).toHaveLength(2)
    expect(s1.every((r) => r.length === s1[0].length)).toBe(true)
    expect(s2.every((r) => r.length === s2[0].length)).toBe(true)
  })
})
