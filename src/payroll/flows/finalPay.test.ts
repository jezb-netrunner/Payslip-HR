// The payroll holding a separation names what the final pay still owes: the
// 13th month pay to the last day and the leave left. A 13th month run for the
// leaver, ending on the last day, then pays exactly that.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId, slipsOf } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { payrollJournal } from '../journal'
import { endOfMonth } from '../../lib/manila'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, over)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

describe('final pay on separation', () => {
  beforeEach(() => resetDb())

  async function leaverThroughJune(over: Record<string, unknown> = {}) {
    const ent = addEntity()
    const emp = addEmployee(ent, { hire_date: '2024-03-04', monthly_rate: 30000, ...over })
    const sil = { id: newId(), entity_id: ent.id, code: 'SIL', name: 'Service Incentive Leave', paid: true, active: true, default_annual_days: 5, min_service_months: 12 }
    const vl = { id: newId(), entity_id: ent.id, code: 'VL', name: 'Vacation Leave', paid: true, active: true, default_annual_days: 0, min_service_months: 0 }
    const lwop = { id: newId(), entity_id: ent.id, code: 'LWOP', name: 'Leave Without Pay', paid: false, active: true, default_annual_days: 0, min_service_months: 0 }
    db.t.leave_types.push(sil, vl, lwop)
    db.t.employee_leave_entitlements.push({ id: newId(), employee_id: emp.id, leave_type_id: vl.id, year: 2026, days: 10 })
    // two days of SIL taken in March, with no time in/out those days
    db.t.leave_requests.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, leave_type_id: sil.id, start_date: '2026-03-10', end_date: '2026-03-11', days: 2, half_day: null, status: 'approved' })
    addAttendance(emp, '2026-01-01', '2026-06-30')
    db.t.time_entries = db.t.time_entries.filter((t) => t.work_date !== '2026-03-10' && t.work_date !== '2026-03-11')
    let last: Record<string, unknown> | undefined
    for (let m = 1; m <= 6; m++) {
      const mm = String(m).padStart(2, '0')
      await runAndFinalize(ent, { period_start: `2026-${mm}-01`, period_end: `2026-${mm}-15`, pay_date: `2026-${mm}-20` })
      if (m === 6) emp.separation_date = '2026-06-30'
      last = await runAndFinalize(ent, { period_start: `2026-${mm}-16`, period_end: endOfMonth(`2026-${mm}-01`), pay_date: `2026-${String(m + 1).padStart(2, '0')}-05` })
    }
    return { ent, emp, slip: slipsOf(last!.id as string, emp.id)[0] }
  }

  it('names the 13th month to the last day and the leave left', async () => {
    const { slip } = await leaverThroughJune()
    // twelve halves of 15,000 earned Jan–Jun: 180,000 ÷ 12
    expect(slip.computation_trace.finalPay).toEqual({
      separationDate: '2026-06-30',
      thirteenth: 15000,
      leave: [
        { typeId: expect.any(String), code: 'SIL', name: 'Service Incentive Leave', days: 3 },
        { typeId: expect.any(String), code: 'VL', name: 'Vacation Leave', days: 10 },
      ],
    })
    const w = slip.computation_trace.warnings as string[]
    expect(w.some((x) => x.startsWith('Final pay: the 13th month pay to the last day (Jun 30, 2026) is ₱15,000.00'))).toBe(true)
    expect(w.some((x) => x.includes('Service Incentive Leave 3 day/s (converts to cash, Labor Code Art. 95); Vacation Leave 10 day/s (if company policy converts it)'))).toBe(true)
  })

  it('pays exactly that in a 13th month run for the leaver ending on the last day', async () => {
    const { ent, emp } = await leaverThroughJune()
    const r = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-06-30', pay_date: '2026-07-10', employee_ids: [emp.id] })
    await computeRun(r as never, ent as never)
    const [p] = slipsOf(r.id, emp.id)
    expect(p.gross_pay).toBe(15000)
    expect((p.computation_trace.warnings as string[]).some((x) => x.startsWith('Basic pay counted through'))).toBe(false)
  })

  it("balances every run's journal entry, the 13th month run included", async () => {
    const { ent, emp } = await leaverThroughJune()
    const r = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-06-30', pay_date: '2026-07-10', employee_ids: [emp.id] })
    await computeRun(r as never, ent as never)
    for (const run of db.t.payroll_runs) {
      const j = payrollJournal(slipsOf(run.id) as never)
      expect(j.balanced).toBe(true)
      expect(j.debit).toBeGreaterThan(0)
    }
  })

  it('names no 13th month for someone the client policy leaves out', async () => {
    const { slip } = await leaverThroughJune({ thirteenth_month_eligible: false })
    expect(slip.computation_trace.finalPay?.thirteenth).toBe(0)
  })

  it('gives no service incentive leave before 12 months of service', async () => {
    const { slip } = await leaverThroughJune({ hire_date: '2025-09-01' })
    expect(slip.computation_trace.finalPay.leave.map((l: { code: string }) => l.code)).toEqual(['VL'])
  })
})
