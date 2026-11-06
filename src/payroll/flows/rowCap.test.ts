// PostgREST answers at most 1,000 rows per request. Reads of one row per
// employee (previous employers, opening balances, paid days) must page, or a
// client past 1,000 employees silently loses the rest: wrong annualization,
// alphalist and BIR Form 2316, and paid days left editable on the timesheet.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, db, newId, MAX_ROWS } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { fetchOpeningBalances, fetchTaxYears } from '../service'
import { lockedKeys } from '../../lib/locks'
import { blankOpening } from '../opening'

const N = MAX_ROWS + 1

describe('reads past the 1,000-row cap', () => {
  let entityId = ''
  let employees: { id: string }[] = []
  beforeEach(() => {
    resetDb()
    const ent = addEntity()
    entityId = ent.id
    employees = Array.from({ length: N }, () => addEmployee(ent) as { id: string })
  })

  it('the fake caps a response like PostgREST', async () => {
    const { data } = await fakeSupabase.from('employees').select('*')
    expect(data).toHaveLength(MAX_ROWS)
  })

  it("reads every employee's previous employer and opening balances", async () => {
    for (const e of employees) {
      db.t.employee_tax_years.push({ id: newId(), employee_id: e.id, entity_id: entityId, year: 2026 })
      db.t.employee_opening_balances.push({ ...blankOpening(e.id, 2026, '2026-06-30'), id: newId(), entity_id: entityId })
    }
    expect(await fetchTaxYears(entityId, 2026)).toHaveLength(N)
    expect(new Set((await fetchOpeningBalances(entityId, 2026)).map((o) => o.employee_id)).size).toBe(N)
  })

  it('locks the paid days of every employee of a large payroll', async () => {
    const run = { id: newId(), entity_id: entityId, status: 'finalized', run_type: 'regular', period_start: '2026-03-01', period_end: '2026-03-15' }
    db.t.payroll_runs.push(run)
    for (const e of employees) db.t.payslips.push({ id: newId(), payroll_run_id: run.id, employee_id: e.id })
    const keys = await lockedKeys(entityId, '2026-03-02', '2026-03-03')
    expect(keys.size).toBe(N * 2)
    expect(keys.has(`${employees[N - 1].id}|2026-03-03`)).toBe(true)
  })
})
