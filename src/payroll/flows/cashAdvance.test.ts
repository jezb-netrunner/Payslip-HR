// Cash advances through whole payrolls: installments payroll after payroll,
// a short payroll deferring the rest, the whole balance on separation, and
// final pay collecting what the last payroll couldn't. Invariant: released =
// what finalized payrolls deducted + balance.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function runAndFinalize(ent: Row, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, over)
  await computeRun(r as never, ent as never)
  finalize(r.id)
  return r
}

function addAdvance(emp: Row, over: Row = {}): Row {
  const d = {
    id: newId(),
    employee_id: emp.id,
    label: 'Cash advance (Oct 5, 2026)',
    category: 'cash_advance',
    amount_per_period: 1000,
    total_amount: 3000,
    balance: 3000,
    start_date: '2026-10-05',
    end_date: null,
    active: true,
    released_on: '2026-10-05',
    ...over,
  }
  db.t.recurring_deductions.push(d)
  return d
}

const line = (runId: string, empId: string, advId: string) =>
  slipsOf(runId, empId)[0]?.deductions.find((l: Row) => l.meta === advId)

const deducted = (advId: string) =>
  db.t.payslips
    .filter((p) => db.t.payroll_runs.find((r) => r.id === p.payroll_run_id)?.status === 'finalized')
    .flatMap((p) => p.deductions)
    .filter((l: Row) => l.meta === advId)
    .reduce((s: number, l: Row) => s + Number(l.amount), 0)

describe('cash advances in payroll', () => {
  beforeEach(() => resetDb())

  it('repays installment by installment, then stops', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-11-30')
    const adv = addAdvance(emp)
    const runs = [
      await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' }),
      await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' }),
      await runAndFinalize(ent, { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' }),
      await runAndFinalize(ent, { period_start: '2026-11-16', period_end: '2026-11-30', pay_date: '2026-12-05' }),
    ]
    expect(runs.map((r) => line(r.id, emp.id, adv.id)?.label ?? null)).toEqual([
      'Cash advance (Oct 5, 2026) — 2,000.00 left',
      'Cash advance (Oct 5, 2026) — 1,000.00 left',
      'Cash advance (Oct 5, 2026) — fully paid',
      null,
    ])
    expect(adv.balance).toBe(0)
    expect(adv.active).toBe(false)
    expect(deducted(adv.id) + adv.balance).toBe(3000)
  })

  it('waits for its first deduction date', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-10-31')
    const adv = addAdvance(emp, { start_date: '2026-10-16' })
    const first = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const second = await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    expect(line(first.id, emp.id, adv.id)).toBeUndefined()
    expect(line(second.id, emp.id, adv.id)?.amount).toBe(1000)
  })

  it('a short payroll leaves the rest of the installment in the balance', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { pay_type: 'daily', daily_rate: 755, monthly_rate: 0, is_minimum_wage_earner: true })
    addAttendance(emp, '2026-10-01', '2026-10-02') // two days worked: net about ₱1,500 less contributions
    addAttendance(emp, '2026-10-16', '2026-10-31')
    const adv = addAdvance(emp, { amount_per_period: 3000 })
    const r1 = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    const s1 = slipsOf(r1.id, emp.id)[0]
    expect(s1.net_pay).toBe(0)
    expect(line(r1.id, emp.id, adv.id).amount).toBeLessThan(3000)
    expect(s1.computation_trace.warnings.some((w: string) => w.includes('stays in the balance for later payrolls'))).toBe(true)
    const r2 = await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    expect(line(r2.id, emp.id, adv.id).label).toBe('Cash advance (Oct 5, 2026) — fully paid')
    expect(adv.balance).toBe(0)
    expect(deducted(adv.id)).toBe(3000)
  })

  it('separation: the last payroll takes the whole balance; final pay collects what it could not', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { pay_type: 'daily', daily_rate: 755, monthly_rate: 0, is_minimum_wage_earner: true, separation_date: '2026-10-20', separation_reason: 'resignation' })
    addAttendance(emp, '2026-10-01', '2026-10-20')
    const adv = addAdvance(emp, { amount_per_period: 500, total_amount: 9000, balance: 9000 })
    const r1 = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    expect(line(r1.id, emp.id, adv.id).amount).toBe(500)
    // Oct 16–20 (4 days) can't cover the remaining ₱8,500
    const r2 = await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    const s2 = slipsOf(r2.id, emp.id)[0]
    expect(s2.net_pay).toBe(0)
    expect(s2.computation_trace.warnings.some((w: string) => w.includes('collect it outside payroll'))).toBe(true)
    const owed = adv.balance
    expect(owed).toBeGreaterThan(0)
    // final pay with a converted leave settles the rest
    const fp = addRun(ent, { run_type: 'final_pay', period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20', employee_ids: [emp.id], annualize: true })
    db.t.payroll_adjustments.push({ id: newId(), payroll_run_id: fp.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning', label: 'SIL conversion', amount: 10000, category: 'other_taxable' })
    await computeRun(fp as never, ent as never)
    finalize(fp.id)
    expect(line(fp.id, emp.id, adv.id).amount).toBe(owed)
    expect(line(fp.id, emp.id, adv.id).label).toBe('Cash advance (Oct 5, 2026) — fully paid')
    expect(adv.balance).toBe(0)
    expect(deducted(adv.id)).toBe(9000)
  })

  it('a paused advance is not collected at separation, but that payroll says it is still owed', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { separation_date: '2026-10-10', separation_reason: 'resignation' })
    addAttendance(emp, '2026-10-01', '2026-10-10')
    const paused = addAdvance(emp, { active: false })
    const r = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    expect(line(r.id, emp.id, paused.id)).toBeUndefined()
    expect(paused.balance).toBe(3000)
    const w = slipsOf(r.id, emp.id)[0].computation_trace.warnings as string[]
    expect(w.some((x) => x.includes('₱3,000.00 is still owed, but its deductions are paused'))).toBe(true)
  })

  it('a change while the draft is being computed keeps it from completing', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-10-15')
    const adv = addAdvance(emp)
    const r = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    // another admin records a repayment while the inputs are read: the
    // staleness triggers reset the draft's totals, as the database does
    const read = fakeSupabase.from
    let raced = false
    fakeSupabase.from = (table: string) => {
      if (table === 'recurring_deductions' && !raced) {
        raced = true
        adv.balance = 100
        db.t.payroll_runs.find((x) => x.id === r.id)!.totals = {}
      }
      return read(table)
    }
    try {
      await expect(computeRun(r as never, ent as never)).rejects.toThrow(/changed while this payroll was being computed/)
    } finally {
      fakeSupabase.from = read
    }
    expect(() => finalize(r.id)).toThrow()
  })

  it('paused advances and 13th-month pay are left alone', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-10-01', '2026-10-15')
    const paused = addAdvance(emp, { active: false })
    const live = addAdvance(emp)
    const r = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    expect(line(r.id, emp.id, paused.id)).toBeUndefined()
    expect(line(r.id, emp.id, live.id)?.amount).toBe(1000)
    const t = await runAndFinalize(ent, { run_type: 'thirteenth_month', period_start: '2026-01-01', period_end: '2026-12-15', pay_date: '2026-12-15' })
    expect(slipsOf(t.id, emp.id)[0].deductions.some((l: Row) => l.code === 'other:cash_advance')).toBe(false)
  })
})
