// C7 through the service: the NG share recorded after the month's first
// payroll deducted the employee half. The month's closing payroll refunds it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

describe('PhilHealth NG share recorded mid-month (C7)', () => {
  beforeEach(() => resetDb())

  it("refunds the employee half an earlier payroll of the month deducted", async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { monthly_rate: 30000 })
    addAttendance(emp, '2026-11-01', '2026-11-30')
    const first = addRun(ent, { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' })
    await computeRun(first as never, ent as never)
    finalize(first.id)
    const a = db.t.payslips.find((p) => p.payroll_run_id === first.id)!
    expect(a.philhealth_ee).toBe(375)
    Object.assign(emp, { ph_ng_type: 'pwd', ph_ng_from_month: '2026-11-01', id_number: 'PWD-0042' })
    const second = addRun(ent, { period_start: '2026-11-16', period_end: '2026-11-30', pay_date: '2026-12-05' })
    await computeRun(second as never, ent as never)
    const b = db.t.payslips.find((p) => p.payroll_run_id === second.id)!
    expect([b.philhealth_ee, b.philhealth_ng, a.philhealth_er + b.philhealth_er]).toEqual([-375, 750, 750])
    expect(b.deductions.find((l: { code: string }) => l.code === 'philhealth')).toMatchObject({ amount: -375, label: expect.stringContaining('refund') })
  })
})
