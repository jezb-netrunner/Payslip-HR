// Spec T12: the statutory minimum wage (SMW) by region, sector and date;
// MWE status per pay period (basic rate at or below the SMW; below it also
// warns "Below minimum wage"); a past-dated SMW lists the employees it
// affects and the year-end adjustment re-tests closed payslips; the
// WAGE_ORDER_TOPUP pay code is SMW for an MWE and R for others.
import { describe, expect, it } from 'vitest'
import { summarizeYear, type AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023 } from './defaults'
import { dailyRateOf, minimumWageOn, mweStatusOf, retestMweFact, retroactiveImpact, type MinimumWageRow } from './minimumWage'
import { lineIncomeClass, payCodeOf } from './payCodes'
import { isTaxableBucket } from './annual'

const row = (over: Partial<MinimumWageRow>): MinimumWageRow => ({
  region: 'NCR', sector: '', daily_rate: 645, effective_from: '2025-07-17', effective_to: null, wage_order_ref: 'NCR-26', ...over,
})
const table: MinimumWageRow[] = [
  row({}),
  row({ daily_rate: 695, effective_from: '2026-07-17', wage_order_ref: 'NCR-27' }),
  row({ sector: 'Agriculture', daily_rate: 608, effective_from: '2025-07-17', wage_order_ref: 'NCR-26' }),
  row({ region: 'R7', daily_rate: 540, effective_from: '2025-10-01', effective_to: '2026-03-31', wage_order_ref: 'ROVII-25' }),
]

describe('T12 the SMW in force', () => {
  it('the newest rate in force on the date, for the region', () => {
    expect(minimumWageOn(table, 'NCR', '', '2026-07-16')?.daily_rate).toBe(645)
    expect(minimumWageOn(table, 'NCR', '', '2026-07-17')?.daily_rate).toBe(695)
    expect(minimumWageOn(table, 'NCR', '', '2025-01-01')).toBeNull()
  })

  it('a sector\'s own rate first, else the region\'s general rate', () => {
    expect(minimumWageOn(table, 'NCR', 'Agriculture', '2026-08-01')?.daily_rate).toBe(608)
    expect(minimumWageOn(table, 'NCR', 'Retail, 15 or fewer workers', '2026-08-01')?.daily_rate).toBe(695)
  })

  it('a rate with an end date stops applying after it', () => {
    expect(minimumWageOn(table, 'R7', '', '2026-03-31')?.daily_rate).toBe(540)
    expect(minimumWageOn(table, 'R7', '', '2026-04-01')).toBeNull()
  })
})

describe('T12 MWE status', () => {
  it('the daily rate: daily-paid as is, monthly-paid by the days-per-year factor', () => {
    expect(dailyRateOf({ pay_type: 'daily', daily_rate: 695, monthly_rate: 0 }, 313)).toBe(695)
    expect(dailyRateOf({ pay_type: 'monthly', daily_rate: 0, monthly_rate: 18127.92 }, 313)).toBe(695)
  })

  it('at or below the SMW: MWE; below it: also "Below minimum wage"', () => {
    expect(mweStatusOf(695, 695)).toEqual({ isMwe: true, below: false })
    expect(mweStatusOf(690, 695)).toEqual({ isMwe: true, below: true })
    expect(mweStatusOf(695.01, 695)).toEqual({ isMwe: false, below: false })
    expect(mweStatusOf(500, null)).toEqual({ isMwe: false, below: false })
  })
})

describe('T12 WAGE_ORDER_TOPUP', () => {
  it('for an MWE it is SMW (exempt), for others R', () => {
    const c = payCodeOf('WAGE_ORDER_TOPUP')
    expect(c).toMatchObject({ bir_bucket: 'basic', tax_treatment: 'mwe_exempt', for_one_time: true, sss_include: true })
    expect(isTaxableBucket(c.bir_bucket, true)).toBe(false)
    expect(isTaxableBucket(c.bir_bucket, false)).toBe(true)
    expect(lineIncomeClass(c, 'one_time')).toBe('regular')
  })
})

describe('T12 a past-dated SMW', () => {
  const entities = [
    { id: 'c1', name: 'Acme', minimum_wage_region: 'NCR', minimum_wage_sector: '', working_days_divisor: 313 },
    { id: 'c2', name: 'Farm', minimum_wage_region: 'NCR', minimum_wage_sector: 'Agriculture', working_days_divisor: 313 },
    { id: 'c3', name: 'Cebu', minimum_wage_region: 'R7', minimum_wage_sector: '', working_days_divisor: 313 },
  ]
  const emp = (id: string, entity_id: string, daily_rate: number) => ({
    id, entity_id, first_name: id, last_name: 'X', pay_type: 'daily' as const, daily_rate, monthly_rate: 0, days_per_year: null, separation_date: null,
  })
  const employees = [emp('at645', 'c1', 645), emp('at700', 'c1', 700), emp('at800', 'c1', 800), emp('farm', 'c2', 608), emp('cebu', 'c3', 500)]

  it('lists the employees whose status changes, from the effective date', () => {
    const added = row({ daily_rate: 720, effective_from: '2026-07-17', wage_order_ref: 'NCR-27 (ruling)' })
    const before = table.filter((r) => r.wage_order_ref !== 'NCR-27')
    const impact = retroactiveImpact({ before, after: [...before, added], changed: added, entities, employees, asOf: '2026-10-25' })
    expect(impact.map((i) => [i.employeeId, i.change, i.before, i.after])).toEqual([
      ['at645', 'below_minimum', 645, 720],
      ['at700', 'becomes_mwe', 645, 720],
    ])
  })

  it('a lower correction: an MWE above the new rate is no longer one', () => {
    const changed = row({ daily_rate: 640, effective_from: '2026-07-17', wage_order_ref: 'NCR-27' })
    const impact = retroactiveImpact({ before: table, after: [table[0], changed, ...table.slice(2)], changed, entities, employees, asOf: '2026-10-25' })
    expect(impact.map((i) => [i.employeeId, i.change])).toEqual([['at645', 'no_longer_mwe']])
  })

  it('the year-end adjustment re-tests a closed payslip: its exempt or taxable lines follow the new status', () => {
    const closed: AnnualPayslipFact = {
      payMonth: '2026-08-01',
      isMwe: false,
      earnings: [{ amount: 18200, bir: 'basic', taxable: true }, { amount: 900, bir: 'overtime', taxable: true }, { amount: 500, bir: 'hazard', taxable: true }],
      contributionsEe: 0,
      unionDues: 0,
      withholdingTax: 0,
    }
    const now = retestMweFact(closed, true, false)
    expect(now.isMwe).toBe(true)
    expect(now.earnings.map((l) => l.taxable)).toEqual([false, false, true])
    const s = summarizeYear([now], BIR_ANNUAL_2023)
    expect([s.mweBasic, s.mweOvertime, s.taxableHazard]).toEqual([18200, 900, 500])
    // with the hazard criteria met, hazard pay is exempt too
    expect(retestMweFact(closed, true, true).earnings[2].taxable).toBe(false)
    // unchanged status: the fact as it was
    expect(retestMweFact(closed, false, false)).toBe(closed)
  })
})

// Owner's answer to the T12 question (2026-10-25): MWE status follows the pay
// rate; the apprentice rule (an apprentice or learner paid 75% of the
// minimum is an MWE) is PENDING — a setting, on by default, until a text
// supports it.
describe('owner 2026-10-25: the apprentice rule is PENDING (on by default)', () => {
  it('an apprentice or learner at 75% of the minimum: an MWE while the rule is on, not when it is off', () => {
    expect(mweStatusOf(521.25, 695, { apprentice: true })).toEqual({ isMwe: true, below: false })
    expect(mweStatusOf(521.25, 695, { apprentice: true, apprenticeMwe: true })).toEqual({ isMwe: true, below: false })
    expect(mweStatusOf(521.25, 695, { apprentice: true, apprenticeMwe: false })).toEqual({ isMwe: false, below: false })
  })

  it('paid the full minimum: an MWE either way; below 75% of it: below the minimum wage', () => {
    expect(mweStatusOf(695, 695, { apprentice: true, apprenticeMwe: false })).toEqual({ isMwe: true, below: false })
    expect(mweStatusOf(500, 695, { apprentice: true })).toEqual({ isMwe: true, below: true })
    expect(mweStatusOf(500, 695, { apprentice: true, apprenticeMwe: false })).toEqual({ isMwe: false, below: true })
  })

  it('other employees: the rule does not apply', () => {
    expect(mweStatusOf(690, 695, { apprenticeMwe: false })).toEqual({ isMwe: true, below: true })
  })

  it('a past-dated SMW: an apprentice\'s floor is 75% of it, and the rule decides the status', () => {
    const entities = [{ id: 'c1', name: 'Acme', minimum_wage_region: 'NCR', minimum_wage_sector: '', working_days_divisor: 313 }]
    const appr = (id: string, daily_rate: number) => ({
      id, entity_id: 'c1', first_name: id, last_name: 'X', pay_type: 'daily' as const, daily_rate, monthly_rate: 0, days_per_year: null,
      separation_date: null, employment_status: 'apprentice',
    })
    const added = row({ daily_rate: 720, effective_from: '2026-07-17', wage_order_ref: 'NCR-27 (ruling)' })
    const before = table.filter((r) => r.wage_order_ref !== 'NCR-27')
    const params = { before, after: [...before, added], changed: added, entities, employees: [appr('a500', 500), appr('a700', 700)], asOf: '2026-10-25' }
    // 500 is now below 75% of 720 (540); 700 is now at or below the minimum
    expect(retroactiveImpact(params).map((i) => [i.employeeId, i.change])).toEqual([['a500', 'below_minimum'], ['a700', 'becomes_mwe']])
    expect(retroactiveImpact({ ...params, apprenticeMwe: false }).map((i) => [i.employeeId, i.change])).toEqual([['a500', 'below_minimum']])
  })
})
