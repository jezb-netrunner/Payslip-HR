// Owner's answer to the T12 question (2026-10-25): before the first payroll
// on the computed MWE status, list the employees whose status changes — the
// status admins last set (the old checkbox) against the status at today's
// rate and minimum wage — with what the year-end adjustment will do to the
// year's tax so far, so admins can warn those who will owe catch-up tax.
import { describe, expect, it } from 'vitest'
import type { AnnualPayslipFact } from './annual'
import { BIR_ANNUAL_2023 } from './defaults'
import { retestMweFact } from './minimumWage'
import { mweReview } from './mweReview'

const month = (m: number, isMwe: boolean, basic: number, commission = 0): AnnualPayslipFact => ({
  payMonth: `2026-${String(m).padStart(2, '0')}-01`,
  isMwe,
  earnings: [
    { amount: basic, bir: 'basic', taxable: !isMwe, incomeClass: 'regular' },
    ...(commission ? [{ amount: commission, bir: 'other_taxable' as const, taxable: true, incomeClass: 'supplementary' as const }] : []),
  ],
  contributionsEe: 0,
  unionDues: 0,
  withholdingTax: 0,
})
// January to September, a 200,000 commission in January
const year = (isMwe: boolean, basic: number) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => month(m, isMwe, basic, m === 1 ? 200000 : 0))
const emp = (id: string, last: string, before: boolean, isMwe: boolean, daily: number) => ({
  id, first_name: id.toUpperCase(), last_name: last, is_minimum_wage_earner: before, status: { isMwe, daily },
})

describe('owner 2026-10-25: the MWE status review', () => {
  // ticked as an MWE, paid 700 a day above the 695 minimum: the year's
  // payslips paid as MWE pay are taxed at the year-end adjustment
  const wasMwe = year(true, 18200)
  // not ticked, paid 690 a day: the year's basic pay becomes exempt
  const wasNot = year(false, 18000)
  const rows = mweReview({
    employees: [emp('a', 'Abad', true, false, 700), emp('b', 'Bello', false, true, 690), emp('c', 'Cruz', true, true, 600), emp('d', 'Diaz', false, false, 800)],
    year: new Map([
      ['a', { asPaid: wasMwe, retested: wasMwe.map((f) => retestMweFact(f, false, false)) }],
      ['b', { asPaid: wasNot, retested: wasNot.map((f) => retestMweFact(f, true, false)) }],
      ['c', { asPaid: year(true, 15600), retested: year(true, 15600) }],
      // a past-dated wage order: one closed payslip re-tests as MWE pay
      ['d', { asPaid: [month(3, false, 20000)], retested: [retestMweFact(month(3, false, 20000), true, false)] }],
    ]),
    annual: BIR_ANNUAL_2023,
  })

  it('lists who changes status, and who the year-end adjustment re-tests, most tax owed first', () => {
    expect(rows.map((r) => [r.employeeId, r.name, r.before, r.now, r.retested])).toEqual([
      ['a', 'Abad, A', true, false, 9],
      ['d', 'Diaz, D', false, false, 1],
      ['b', 'Bello, B', false, true, 9],
    ])
  })

  it('the tax change for the year so far: catch-up tax (more) or a refund (less)', () => {
    // 163,800 basic + 200,000 commission: 15% of 113,800 over 250,000
    expect(rows.find((r) => r.employeeId === 'a')?.taxChange).toBe(17070)
    // 162,000 + 200,000 = 362,000 taxed (16,800), now only the commission (0% row)
    expect(rows.find((r) => r.employeeId === 'b')?.taxChange).toBe(-16800)
    expect(rows.find((r) => r.employeeId === 'd')?.taxChange).toBe(0)
  })

  it('no payslips yet this year: listed for the status change alone', () => {
    const [r] = mweReview({ employees: [emp('e', 'Enriquez', true, false, 720)], year: new Map(), annual: BIR_ANNUAL_2023 })
    expect(r).toMatchObject({ employeeId: 'e', before: true, now: false, retested: 0, taxChange: 0, daily: 720 })
  })
})
