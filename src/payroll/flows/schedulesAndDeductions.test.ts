// Whole payrolls with flexible schedules (effective-dated patterns and roster
// changes) and with deduction amounts set per payroll.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manilaWallToIso } from '../../lib/manila'
import { fakeSupabase, resetDb, addEntity, addEmployee, addRun, finalize, slipsOf, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const day = { start: '08:00', end: '17:00', break_minutes: 60 }
const half = { start: '08:00', end: '12:00', break_minutes: 0 }

function work(emp: Row, date: string, tin: string, tout: string) {
  db.t.time_entries.push({
    id: newId(),
    entity_id: emp.entity_id,
    employee_id: emp.id,
    work_date: date,
    clock_in: manilaWallToIso(date, tin),
    clock_out: manilaWallToIso(date, tout),
  })
}

describe('flexible schedules in a payroll run', () => {
  beforeEach(() => resetDb())

  it('measures each date against its own shift', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { pay_type: 'daily', monthly_rate: 0, daily_rate: 800, pay_frequency: 'weekly' })
    // from Oct 12: Mon–Fri day shift plus a half-day Saturday; Oct 14 (Wed) moved to a rest day
    db.t.employee_schedules.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, effective_from: '2026-10-12', pattern: [day, day, day, day, day, half, null] })
    db.t.schedule_overrides.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, work_date: '2026-10-14', shift: null })
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-15', '2026-10-16']) work(emp, d, '08:00', '17:00')
    work(emp, '2026-10-17', '08:00', '12:00')
    const run = addRun(ent, { pay_frequency: 'weekly', period_start: '2026-10-12', period_end: '2026-10-18', pay_date: '2026-10-23' })
    await computeRun(run as never, ent as never)
    const [slip] = slipsOf(run.id, emp.id)
    expect(slip.absent_days).toBe(0) // Wednesday was a rest day, Saturday a half day
    expect(slip.undertime_minutes).toBe(0)
    expect(slip.days_worked).toBe(5)
    expect(slip.basic_pay).toBe(3600) // 4 × 800 + 0.5 × 800
    const days = slip.computation_trace.days as Row[]
    expect(days.find((d) => d.date === '2026-10-14')).toMatchObject({ scheduled: false, dayType: 'rest_day', shift: null })
    expect(days.find((d) => d.date === '2026-10-17')).toMatchObject({ expectedMinutes: 240, shift: half })
  })

  it('keeps the old schedule for the days before a change', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { pay_frequency: 'weekly' })
    // the base is Mon–Fri 8–5; from Oct 15 the employee works Tue–Sat
    db.t.employee_schedules.push({ id: newId(), entity_id: ent.id, employee_id: emp.id, effective_from: '2026-10-15', pattern: [null, day, day, day, day, day, null] })
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']) work(emp, d, '08:00', '17:00')
    const run = addRun(ent, { pay_frequency: 'weekly', period_start: '2026-10-12', period_end: '2026-10-18', pay_date: '2026-10-23' })
    await computeRun(run as never, ent as never)
    const [slip] = slipsOf(run.id, emp.id)
    const days = slip.computation_trace.days as Row[]
    expect(days.find((d) => d.date === '2026-10-12')?.scheduled).toBe(true) // Monday under the base schedule
    expect(days.find((d) => d.date === '2026-10-17')).toMatchObject({ scheduled: true, dayType: 'regular' }) // Saturday under the new one
    expect(slip.absent_days).toBe(0)
    expect(slip.earnings.some((l: Row) => l.code === 'restday')).toBe(false)
  })
})

describe('deduction amounts set for one payroll', () => {
  beforeEach(() => resetDb())

  function addDeduction(emp: Row, over: Row): Row {
    const d = {
      id: newId(),
      employee_id: emp.id,
      label: 'Cash advance (Oct 1, 2026)',
      category: 'cash_advance',
      amount_per_period: 1000,
      total_amount: 3000,
      balance: 3000,
      start_date: '2026-10-01',
      end_date: null,
      active: true,
      released_on: '2026-10-01',
      ...over,
    }
    db.t.recurring_deductions.push(d)
    return d
  }
  const setFor = (run: Row, ded: Row, amount: number) =>
    db.t.payroll_deduction_overrides.push({ id: newId(), payroll_run_id: run.id, deduction_id: ded.id, employee_id: ded.employee_id, entity_id: run.entity_id, amount })
  const line = (run: Row, emp: Row, ded: Row) => slipsOf(run.id, emp.id)[0]?.deductions.find((l: Row) => l.meta === ded.id)

  function fullWeeks(emp: Row, from: string, to: string) {
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10)
      if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) work(emp, iso, '08:00', '17:00')
    }
  }

  it('deducts what is set for the payroll instead of the installment, and finalize follows it', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    fullWeeks(emp, '2026-10-01', '2026-10-31')
    const adv = addDeduction(emp, {})
    const loan = addDeduction(emp, { label: 'Company loan', category: 'company_loan', amount_per_period: 500, total_amount: 2000, balance: 2000, released_on: null })
    const first = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    setFor(first, adv, 400)
    setFor(first, loan, 0)
    await computeRun(first as never, ent as never)
    expect(line(first, emp, adv)).toMatchObject({ amount: 400, label: 'Cash advance (Oct 1, 2026) — 2,600.00 left' })
    expect(line(first, emp, loan)).toBeUndefined()
    const notes = slipsOf(first.id, emp.id)[0].computation_trace.notes as string[]
    expect(notes).toContain('Cash advance (Oct 1, 2026): ₱400.00 this payroll, as set for it (usually ₱1,000.00).')
    expect(notes).toContain('Company loan: skipped this payroll, as set for it (usually ₱500.00).')
    finalize(first.id)
    expect(adv.balance).toBe(2600)
    expect(loan.balance).toBe(2000)
    // the next payroll is back to the installments
    const second = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    await computeRun(second as never, ent as never)
    expect(line(second, emp, adv)?.amount).toBe(1000)
    expect(line(second, emp, loan)?.amount).toBe(500)
  })

  it('collects an advance with no fixed installment only when an amount is set, never more than owed', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    fullWeeks(emp, '2026-10-01', '2026-10-31')
    const adv = addDeduction(emp, { amount_per_period: 0, total_amount: 1500, balance: 1500 })
    const first = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    await computeRun(first as never, ent as never)
    expect(line(first, emp, adv)).toBeUndefined()
    const second = addRun(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    setFor(second, adv, 2000) // more than owed: capped at the balance
    await computeRun(second as never, ent as never)
    expect(line(second, emp, adv)).toMatchObject({ amount: 1500, label: 'Cash advance (Oct 1, 2026) — fully paid' })
    // a paused advance is collected when an amount is set for the payroll
    const paused = addDeduction(emp, { label: 'Cash advance (Oct 2, 2026)', active: false, total_amount: 900, balance: 900 })
    setFor(second, paused, 300)
    await computeRun(second as never, ent as never)
    expect(line(second, emp, paused)?.amount).toBe(300)
  })

  it('warns when the payroll settling a separation deducts less than the balance', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent, { separation_date: '2026-10-15', separation_reason: 'resignation' })
    fullWeeks(emp, '2026-10-01', '2026-10-15')
    const adv = addDeduction(emp, {})
    const run = addRun(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    setFor(run, adv, 1000)
    await computeRun(run as never, ent as never)
    expect(line(run, emp, adv)?.amount).toBe(1000)
    const warnings = slipsOf(run.id, emp.id)[0].computation_trace.warnings as string[]
    expect(warnings.some((w) => w.includes('₱2,000.00 is still owed'))).toBe(true)
  })
})
