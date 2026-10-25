// Spec T7 end to end: what each de minimis item already used in its month,
// semester or year comes from the finalized payslips (by pay date); leave
// conversion follows the client's leave policy; the ceilings apply to pay
// dated 2026-01-07 and later.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>
const linesOf = (slip: Row, code: string) =>
  (slip.earnings as Row[]).filter((l) => l.payCode === code).map((l) => [l.bir, l.amount])

async function run(ent: Row, over: Parameters<typeof addRun>[1], adjust?: (r: Row) => void) {
  const r = addRun(ent, over)
  adjust?.(r)
  await computeRun(r as never, ent as never)
  const slip = slipsOf(r.id as string)[0]
  finalize(r.id as string)
  return slip
}

describe('T7 flows: de minimis usage', () => {
  beforeEach(() => resetDb())

  it('a monthly rice subsidy paid semi-monthly: the second half carries the excess', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 30000 })
    addAttendance(emp, '2026-06-01', '2026-06-30')
    db.t.employee_allowances.push({
      id: newId(), employee_id: emp.id, label: 'Rice subsidy', amount: 3000, category: 'de_minimis', basis: 'monthly', active: true, pay_code: 'DM_RICE',
    })
    const a = await run(ent, { period_start: '2026-06-01', period_end: '2026-06-15', pay_date: '2026-06-20' })
    const b = await run(ent, { period_start: '2026-06-16', period_end: '2026-06-30', pay_date: '2026-07-05' })
    expect(linesOf(a, 'DM_RICE')).toEqual([['de_minimis', 1500]])
    // paid in July: a new month of the ceiling — but June's 1,500 was paid in June
    expect(linesOf(b, 'DM_RICE')).toEqual([['de_minimis', 1500]])
    const c = await run(ent, { period_start: '2026-07-01', period_end: '2026-07-15', pay_date: '2026-07-20' })
    // July's ceiling: 1,500 already paid on Jul 5
    expect(linesOf(c, 'DM_RICE')).toEqual([['de_minimis', 1000], ['other_benefits', 500]])
  })

  it('leave conversion follows the client\'s leave policy, and its 12 days are per year', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly', leave_policy: 'vl_in_place_of_sil' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 21750 })
    addAttendance(emp, '2026-03-01', '2026-06-30')
    const convert = (days: number) => (r: Row) =>
      db.t.payroll_adjustments.push({
        id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: `VL conversion (${days} days)`,
        amount: days * 1000, category: 'de_minimis', benefit: null, pay_code: 'LEAVE_CONVERSION', days,
      })
    const mar = await run(ent, { pay_frequency: 'monthly', period_start: '2026-03-01', period_end: '2026-03-31', pay_date: '2026-03-31' }, convert(10))
    expect(linesOf(mar, 'LEAVE_CONVERSION')).toEqual([['de_minimis', 10000]])
    const jun = await run(ent, { pay_frequency: 'monthly', period_start: '2026-06-01', period_end: '2026-06-30', pay_date: '2026-06-30' }, convert(5))
    expect(linesOf(jun, 'LEAVE_CONVERSION')).toEqual([['de_minimis', 2000], ['other_benefits', 3000]])
    // a SIL-only client: taxable
    ent.leave_policy = 'sil_only'
    const jul = await run(ent, { pay_frequency: 'monthly', period_start: '2026-07-01', period_end: '2026-07-31', pay_date: '2026-07-31' }, convert(2))
    expect(linesOf(jul, 'LEAVE_CONVERSION')).toEqual([['other_taxable', 2000]])
  })

  it('D4: the ceilings apply to pay dated 2026-01-07 and later', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000 })
    addAttendance(emp, '2025-12-01', '2026-01-31')
    db.t.employee_allowances.push({
      id: newId(), employee_id: emp.id, label: 'Rice subsidy', amount: 3000, category: 'de_minimis', basis: 'monthly', active: true, pay_code: 'DM_RICE',
    })
    const dec = await run(ent, { pay_frequency: 'monthly', period_start: '2025-12-01', period_end: '2025-12-31', pay_date: '2026-01-06' })
    expect(linesOf(dec, 'DM_RICE')).toEqual([['de_minimis', 3000]])
    expect((dec.computation_trace as Row).warnings).toEqual(expect.arrayContaining([expect.stringMatching(/No de minimis ceilings on file/)]))
    const jan = await run(ent, { pay_frequency: 'monthly', period_start: '2026-01-01', period_end: '2026-01-31', pay_date: '2026-01-31' })
    expect(linesOf(jan, 'DM_RICE')).toEqual([['de_minimis', 2500], ['other_benefits', 500]])
  })
})
