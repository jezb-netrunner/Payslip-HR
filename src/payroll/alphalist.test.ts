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
  payMonth: `2026-${String(m).padStart(2, '0')}-01`,
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
    taxYears: [{
      employee_id: 'reg', year: 2026, has_previous_employer: true, prev_employer_tin: '111-222-333', prev_employer_name: 'Old Co',
      prev_employment_from: '2026-01-02', prev_employment_to: '2026-02-27', prev_employment_status: 'contractual',
      prev_separation_reason: 'end_of_contract', prev_tax_withheld: 0, substituted_filing: 'auto',
    } as EmployeeTaxYear],
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

  it('reports an employee who left last year but was paid this year as separated', () => {
    const [r] = buildAlphalist({
      year: 2027,
      entity,
      employees: [emp('dec', { separation_date: '2026-12-31', separation_reason: 'resignation' })],
      payslips: [{ employee_id: 'dec', fact: { ...fact(1, true, 9000), payMonth: '2027-01-01' } }],
      taxYears: [],
      annual: BIR_ANNUAL_2023,
    })
    expect([r.from, r.to, r.separationCode, r.substitutedFiling]).toEqual(['2026-01-01', '2026-12-31', 'T', false])
    expect(r.issues.join(' ')).toContain('Separated 2026-12-31')
  })

  it("carries the previous employer's section: status, period and reason codes", () => {
    const reg = rows.find((r) => r.employee.id === 'reg')!
    expect([reg.prevStatusCode, reg.prevFrom, reg.prevTo, reg.prevSeparationCode]).toEqual(['CP', '2026-01-02', '2026-02-27', 'T'])
    const [header, ...body] = alphalistCsv(rows, 1)
    const line = body.find((l) => l[3] === 'REG')!
    const col = (name: string) => line[header.indexOf(name)]
    expect([col('Previous Employer TIN'), col('Prev Employment Status'), col('Prev Employed From'), col('Prev Reason of Separation')]).toEqual([
      '111-222-333',
      'CP',
      '2026-01-02',
      'T',
    ])
  })

  it("takes Schedule 2's minimum wage from the year-end payslips, not today's rate", () => {
    const [r] = buildAlphalist({
      year: 2026,
      entity,
      employees: [emp('mwe', { daily_rate: 800 })], // raised after year end
      payslips: [{ employee_id: 'mwe', fact: fact(12, true, 19630) }],
      taxYears: [],
      annual: BIR_ANNUAL_2023,
      yearEndRates: new Map([['mwe', { payType: 'daily', daily: 755, monthly: 0 }]]),
    })
    expect([r.smwPerDay, r.smwPerYear]).toEqual([755, 236315])
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

// Spec T10: for each minimum wage earner who received hazard pay, the
// alphalist export carries the period of employment, the hazard pay amount
// and the justification (the DOLE certification reference).
describe('T10 MWE hazard pay in the alphalist', () => {
  const hazard = (m: number, amount: number): AnnualPayslipFact => ({
    ...fact(m, true, 19630),
    earnings: [{ amount: 19630, bir: 'basic' }, { amount, bir: 'hazard', taxable: false }],
  })
  const rows = buildAlphalist({
    year: 2026,
    entity,
    employees: [
      emp('haz', { hazard_criteria_met: true, hazard_dole_cert_ref: 'DOLE-NCR-HZ-2026-014', hire_date: '2026-02-01' }),
      emp('nocert'),
      emp('plain'),
    ],
    payslips: [
      ...[2, 3].map((m) => ({ employee_id: 'haz', fact: hazard(m, 1000) })),
      { employee_id: 'nocert', fact: hazard(1, 500) },
      { employee_id: 'plain', fact: fact(1, true, 19630) },
    ],
    taxYears: [],
    annual: BIR_ANNUAL_2023,
  })
  const csv = alphalistCsv(rows, 2)
  const col = (name: string) => csv[0].indexOf(name)
  const line = (first: string) => csv.find((r) => r[3] === first)!

  it('period of employment, amount and the DOLE certification reference', () => {
    const cols = ['MWE Hazard Pay: Employed From', 'MWE Hazard Pay: Employed To', 'MWE Hazard Pay Amount', 'MWE Hazard Pay Justification (DOLE certification)']
    expect(cols.map(col).every((i) => i > 0)).toBe(true)
    expect(cols.map((c) => line('HAZ')[col(c)])).toEqual(['2026-02-01', '2026-12-31', 2000, 'DOLE-NCR-HZ-2026-014'])
    // no hazard pay: blank
    expect(cols.map((c) => line('PLAIN')[col(c)])).toEqual(['', '', '', ''])
    expect(csv.every((r) => r.length === csv[0].length)).toBe(true)
  })

  it('exempt hazard pay without the DOLE certification reference is flagged', () => {
    expect(rows.find((r) => r.employee.id === 'nocert')?.issues).toContain('MWE hazard pay without a DOLE certification reference')
    expect(rows.find((r) => r.employee.id === 'haz')?.issues).toEqual([])
  })
})

// Owner 2026-10-25: taxable pay of ₱250,000 or less for the year (this and
// any previous employer) goes in the non-taxable column "Salaries (P250,000
// & below) & Other Forms of Compensation"; tax due 0 (alphalist Schedule 1,
// revised format: RMC 160-2022).
describe('owner 2026-10-25: ₱250,000 and below in the alphalist', () => {
  const month = (m: number, amount: number, bir: 'basic' | 'overtime' = 'basic'): AnnualPayslipFact => ({
    ...fact(m, false, 0), earnings: [{ amount, bir, taxable: true }],
  })
  const rows = buildAlphalist({
    year: 2026,
    entity,
    employees: [emp('low', { pay_type: 'monthly', monthly_rate: 10000, daily_rate: 0 }), emp('high', { pay_type: 'monthly', monthly_rate: 30000, daily_rate: 0 })],
    payslips: [
      ...Array.from({ length: 12 }, (_, i) => ({ employee_id: 'low', fact: month(i + 1, 10000) })),
      { employee_id: 'low', fact: month(12, 5000, 'overtime') },
      ...Array.from({ length: 12 }, (_, i) => ({ employee_id: 'high', fact: month(i + 1, 30000) })),
    ],
    taxYears: [],
    annual: BIR_ANNUAL_2023,
  })
  const csv = alphalistCsv(rows, 1)
  const col = (name: string) => {
    const i = csv[0].indexOf(name)
    if (i < 0) throw new Error(`no column ${name}`)
    return i
  }
  const line = (first: string) => csv.find((r) => r[3] === first)!

  it('all of it in the non-taxable salaries column, nothing taxable, tax due 0', () => {
    const low = line('LOW')
    expect(low[col('NT: Salaries (P250,000 & below) & Other Forms of Compensation')]).toBe(125000)
    expect([low[col('TX: Basic Salary')], low[col('TX: Overtime Pay')], low[col('Total Taxable (present)')]]).toEqual([0, 0, 0])
    expect([low[col('Total Non-Taxable')], low[col('Gross Compensation (present)')], low[col('Tax Due')]]).toEqual([125000, 125000, 0])
  })

  it('above it: as computed', () => {
    const high = line('HIGH')
    expect([high[col('TX: Basic Salary')], high[col('NT: Salaries (P250,000 & below) & Other Forms of Compensation')]]).toEqual([360000, 0])
  })
})
