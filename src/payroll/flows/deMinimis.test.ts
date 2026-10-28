// C4 through the service: a monthly de minimis allowance is split over the
// payrolls of its payroll month, and its monthly ceiling counts that month,
// not the pay month (a weekly payroll paid 5 days after the cutoff can pay
// five times in one calendar month).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db, newId } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'
import { addDays } from '../../lib/manila'

describe('de minimis ceilings by payroll month (C4)', () => {
  beforeEach(() => resetDb())

  it('a weekly rice subsidy at the ceiling stays exempt when a pay month holds five payrolls', async () => {
    const ent = addEntity({ default_pay_frequency: 'weekly' })
    const emp = addEmployee(ent, { pay_frequency: 'weekly', pay_type: 'daily', daily_rate: 800, monthly_rate: 0 })
    db.t.employee_allowances.push({ id: newId(), employee_id: emp.id, label: 'Rice subsidy', amount: 2500, category: 'de_minimis', basis: 'monthly', de_minimis_kind: 'rice', active: true })
    addAttendance(emp, '2026-02-28', '2026-04-30')
    const exempt: Record<string, number> = {}
    // April's pay dates: Apr 1 (March's last cutoff), 8, 15, 22 and 29
    for (const end of ['2026-03-06', '2026-03-13', '2026-03-20', '2026-03-27', '2026-04-03', '2026-04-10', '2026-04-17', '2026-04-24']) {
      const r = addRun(ent, { pay_frequency: 'weekly', period_start: addDays(end, -6), period_end: end, pay_date: addDays(end, 5) })
      await computeRun(r as never, ent as never)
      finalize(r.id)
      const slip = db.t.payslips.find((p) => p.payroll_run_id === r.id)!
      expect(slip.earnings.some((l: { code: string }) => l.code === 'de_minimis_excess')).toBe(false)
      exempt[r.period_month] = (exempt[r.period_month] ?? 0) + slip.earnings.filter((l: { bir: string }) => l.bir === 'de_minimis').reduce((s: number, l: { amount: number }) => s + l.amount, 0)
    }
    expect(exempt).toEqual({ '2026-03-01': 2500, '2026-04-01': 2500 })
  })
})
