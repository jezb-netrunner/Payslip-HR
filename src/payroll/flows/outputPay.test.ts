// Output pay through the service: the payroll pays the outputs dated in its
// period, and the month's closing payroll settles Pag-IBIG and PhilHealth on
// the month's output pay; the 13th month counts a worker's output pay.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

let seq = 0
function addOutput(emp: Record<string, unknown>, date: string, description: string, amount: number, units?: { quantity: number; rate: number }) {
  db.t.employee_outputs.push({
    id: `out-${++seq}`,
    employee_id: emp.id,
    entity_id: emp.entity_id,
    output_date: date,
    description,
    quantity: units?.quantity ?? null,
    unit_rate: units?.rate ?? null,
    amount,
    accepted_by: '',
    note: '',
    report_path: null,
    report_name: null,
  })
}

describe('output pay', () => {
  beforeEach(() => resetDb())

  it('pays the outputs of the period, settles the month on them and counts them toward the 13th month', async () => {
    const ent = addEntity({ working_days_divisor: 261, minimum_wage_daily: 695 })
    const worker = addEmployee(ent, { pay_type: 'daily', daily_rate: 0, monthly_rate: 0, output_pay: 'basic', employee_no: 'P1' })
    addAttendance(worker, '2026-09-01', '2026-09-30')
    addOutput(worker, '2026-09-04', 'Sewn shirts', 5000, { quantity: 200, rate: 25 })
    addOutput(worker, '2026-09-11', 'Sewn shirts', 5000, { quantity: 200, rate: 25 })
    addOutput(worker, '2026-09-18', 'Sewn shirts', 10000, { quantity: 400, rate: 25 })
    addOutput(worker, '2026-10-02', 'Sewn shirts', 2500, { quantity: 100, rate: 25 })

    const first = addRun(ent, { period_start: '2026-09-01', period_end: '2026-09-15', pay_date: '2026-09-15' })
    await computeRun(first as never, ent as never)
    finalize(first.id)
    const a = db.t.payslips.find((p) => p.payroll_run_id === first.id)!
    expect(a.earnings.filter((l: { code: string }) => l.code === 'output').map((l: { label: string; amount: number }) => [l.label, l.amount])).toEqual([
      ['Output: Sewn shirts (400 × 25.00)', 10000],
    ])
    expect(a.basic_pay).toBe(10000)
    expect(a.computation_trace.warnings).toContain("2 outputs paid by this payroll have no output report attached: attach it on the employee's Outputs tab.")
    // PhilHealth on the minimum wage (₱695 × 261 ÷ 12 = ₱15,116.25): half of ₱377.90
    expect(a.philhealth_ee).toBe(188.95)
    expect(a.pagibig_ee).toBe(0)

    const second = addRun(ent, { period_start: '2026-09-16', period_end: '2026-09-30', pay_date: '2026-09-30' })
    await computeRun(second as never, ent as never)
    finalize(second.id)
    const b = db.t.payslips.find((p) => p.payroll_run_id === second.id)!
    expect(b.gross_pay).toBe(10000)
    // the month paid ₱20,000 of output: PhilHealth ₱500 and Pag-IBIG ₱200, less what the first half took
    expect(b.philhealth_ee).toBe(311.05)
    expect(b.pagibig_ee).toBe(200)

    const t = addRun(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-31', pay_date: '2026-12-10' })
    await computeRun(t as never, ent as never)
    const th = db.t.payslips.find((p) => p.payroll_run_id === t.id)!
    // 1/12 of the year's output pay so far
    expect(th.gross_pay).toBe(1666.67)
  })

  it("pays a regular holiday on the average of the last 7 working days, reading the weeks before the period", async () => {
    const ent = addEntity({ working_days_divisor: 261, minimum_wage_daily: 695 })
    const worker = addEmployee(ent, { pay_type: 'daily', daily_rate: 0, monthly_rate: 0, output_pay: 'basic', employee_no: 'P2' })
    db.t.holidays.push({ id: 'h-sep8', entity_id: null, holiday_date: '2026-09-08', name: 'Test holiday', kind: 'regular' })
    addAttendance(worker, '2026-08-18', '2026-09-07')
    addAttendance(worker, '2026-09-09', '2026-09-15')
    for (const d of ['2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07']) {
      addOutput(worker, d, 'Sewn shirts', 1200, { quantity: 48, rate: 25 })
    }
    const run = addRun(ent, { period_start: '2026-09-01', period_end: '2026-09-15', pay_date: '2026-09-15' })
    await computeRun(run as never, ent as never)
    const slip = db.t.payslips.find((p) => p.payroll_run_id === run.id)!
    const lines = slip.earnings.map((l: { label: string; amount: number }) => [l.label, l.amount])
    // only September's outputs are paid here; August's only weigh in the holiday's average
    expect(lines).toContainEqual(['Output: Sewn shirts (240 × 25.00)', 6000])
    // Aug 28 – Sep 7: 7 working days, ₱8,400 of output
    expect(lines).toContainEqual(['Holiday Pay, Sep 8 (paid by results: average of the last 7 working day/s)', 1200])
  })
})
