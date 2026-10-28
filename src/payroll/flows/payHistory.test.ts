// Pay-rate history through the service: each payroll takes the rates of its
// own period from the history, whatever the employee row shows today.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

describe('pay-rate history in payroll', () => {
  beforeEach(() => resetDb())

  function setup() {
    const ent = addEntity({ working_days_divisor: 261 })
    // the employee row shows today's rate: the raise is already in effect
    const emp = addEmployee(ent, { pay_type: 'monthly', monthly_rate: 33000, hire_date: '2026-01-05' })
    for (const [effective_from, rate] of [['2026-01-05', 30000], ['2026-09-09', 33000]] as const) {
      db.t.employee_pay_rates.push({ id: newId(), employee_id: emp.id, entity_id: ent.id, effective_from, pay_type: 'monthly', rate })
    }
    addAttendance(emp, '2026-08-16', '2026-09-15')
    return { ent, emp }
  }

  async function slipFor(ent: Record<string, unknown>, start: string, end: string) {
    const r = addRun(ent, { period_start: start, period_end: end, pay_date: end })
    await computeRun(r as never, ent as never)
    return db.t.payslips.find((p) => p.payroll_run_id === r.id)!
  }

  it('a raise inside the period pays each part at its rate; the payslip records the rate at the end', async () => {
    const { ent } = setup()
    const slip = await slipFor(ent, '2026-09-01', '2026-09-15')
    const basic = slip.earnings.filter((l: { bir: string }) => l.bir === 'basic').map((l: { label: string }) => l.label)
    expect(basic).toEqual(['Basic Pay to Sep 8 (30,000.00 a month)', 'Basic Pay from Sep 9 (33,000.00 a month)'])
    expect(slip.employee_snapshot.monthly_rate).toBe(33000)
  })

  it("a period before the raise is paid at the rate it had, not today's", async () => {
    const { ent } = setup()
    const slip = await slipFor(ent, '2026-08-16', '2026-08-31')
    expect(slip.earnings.find((l: { code: string }) => l.code === 'basic')).toMatchObject({ label: 'Basic Pay', amount: 15000 })
    expect(slip.employee_snapshot.monthly_rate).toBe(30000)
  })
})
