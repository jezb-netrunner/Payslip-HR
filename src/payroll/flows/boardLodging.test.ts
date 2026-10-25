// Owner's answer to the T3 question end to end: the employee's job level
// decides whether their own board and lodging is withheld on (rank and
// file) or flagged for the fringe benefit tax (managerial or supervisory).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>

describe('owner 2026-10-25 flows: board and lodging by job level', () => {
  beforeEach(() => resetDb())

  it('rank and file: taxable; managerial or supervisory: a fringe benefit, not withheld on', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const staff = addEmployee(ent, { employee_no: 'E1', pay_frequency: 'monthly', monthly_rate: 30000 })
    const boss = addEmployee(ent, { employee_no: 'E2', pay_frequency: 'monthly', monthly_rate: 30000, job_level: 'managerial_supervisory' })
    for (const e of [staff, boss]) {
      addAttendance(e, '2026-06-01', '2026-06-30')
      db.t.employee_allowances.push({
        id: newId(), employee_id: e.id, label: 'Board and lodging', amount: 3000, category: 'other_taxable', basis: 'monthly', active: true, pay_code: 'BOARD_LODGING',
      })
    }
    const r = addRun(ent, { pay_frequency: 'monthly', period_start: '2026-06-01', period_end: '2026-06-30', pay_date: '2026-06-30' })
    await computeRun(r as never, ent as never)
    const line = (e: Row) => (slipsOf(r.id as string, e.id as string)[0].earnings as Row[]).find((l) => l.payCode === 'BOARD_LODGING')
    expect(line(staff)).toMatchObject({ taxable: true, incomeClass: 'regular' })
    expect(line(boss)).toMatchObject({ taxable: false, fbt: true })
    const [a, b] = [staff, boss].map((e) => slipsOf(r.id as string, e.id as string)[0])
    expect(Number(a.taxable_regular) - Number(b.taxable_regular)).toBe(3000)
  })
})
