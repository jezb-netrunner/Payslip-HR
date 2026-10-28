// Fixed salary through the service: no time entries needed, and the 13th
// month follows the client's policy for the employee.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

describe('fixed salary without timekeeping', () => {
  beforeEach(() => resetDb())

  it('pays the half month with no time entries; the 13th month follows the policy', async () => {
    const ent = addEntity({ working_days_divisor: 261 })
    const exec = addEmployee(ent, { pay_type: 'monthly', monthly_rate: 80000, fixed_salary: true, thirteenth_month_eligible: false, employee_no: 'X1' })
    const staff = addEmployee(ent, { pay_type: 'monthly', monthly_rate: 20000, employee_no: 'S1', first_name: 'Lino' })
    addAttendance(staff, '2026-09-01', '2026-09-15')
    const r = addRun(ent, { period_start: '2026-09-01', period_end: '2026-09-15', pay_date: '2026-09-15' })
    await computeRun(r as never, ent as never)
    finalize(r.id)
    const slip = db.t.payslips.find((p) => p.payroll_run_id === r.id && p.employee_id === exec.id)!
    expect(slip.gross_pay).toBe(40000)
    expect(slip.computation_trace.warnings.some((w: string) => w.includes('charged as absence'))).toBe(false)

    const t = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10' })
    const res = await computeRun(t as never, ent as never)
    const paid = db.t.payslips.filter((p) => p.payroll_run_id === t.id).map((p) => p.employee_id)
    expect(paid).toEqual([staff.id])
    expect(res.warnings.some((w) => w.warnings.some((x) => x.includes('no 13th month pay under the client')))).toBe(true)
  })
})
