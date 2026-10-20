import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

describe('harness sanity: two semi-monthly payrolls', () => {
  beforeEach(() => resetDb())

  it('computes, finalizes and splits contributions exactly', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-10-31')
    const r1 = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const res1 = await computeRun(r1 as never, ent as never)
    expect(res1.computed).toBe(1)
    finalize(r1.id)
    const r2 = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(r2 as never, ent as never)
    finalize(r2.id)
    const [a] = slipsOf(r1.id)
    const [b] = slipsOf(r2.id)
    expect(a.sss_ee + b.sss_ee).toBe(1000)
    expect(a.sss_mpf_ee + b.sss_mpf_ee).toBe(500)
    expect(a.philhealth_ee + b.philhealth_ee).toBe(750)
    expect(db.t.employees[0].payroll_seq).toBe(2)
  })
})
