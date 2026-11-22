// Half-day leave through the service: the request's half reaches the
// computation, so a morning worked beside an afternoon on paid leave is a
// whole day's pay with no undertime.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, db, newId, slipsOf } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

const DAY = '2026-08-19' // a Wednesday

describe('half-day leave through a payroll run', () => {
  beforeEach(() => resetDb())

  async function run(half: 'am' | 'pm' | null, paid = true) {
    const ent = addEntity()
    const monthly = addEmployee(ent, { employee_no: 'M1', monthly_rate: 30000 })
    const daily = addEmployee(ent, { employee_no: 'D1', pay_type: 'daily', daily_rate: 800, monthly_rate: 0 })
    const type = { id: newId(), entity_id: ent.id, code: paid ? 'VL' : 'LWOP', name: paid ? 'Vacation Leave' : 'Leave Without Pay', paid }
    db.t.leave_types.push(type)
    for (const e of [monthly, daily]) {
      addAttendance(e, '2026-08-16', '2026-08-31')
      // the morning only on DAY: 08:00 to 12:00 Manila
      const entry = db.t.time_entries.find((t) => t.employee_id === e.id && t.work_date === DAY)!
      entry.clock_out = `${DAY}T04:00:00.000Z`
      db.t.leave_requests.push({
        id: newId(), entity_id: ent.id, employee_id: e.id, leave_type_id: type.id, start_date: DAY, end_date: DAY,
        days: half ? 0.5 : 1, half_day: half, status: 'approved',
      })
    }
    const r = addRun(ent, { period_start: '2026-08-16', period_end: '2026-08-31', pay_date: '2026-09-05' })
    await computeRun(r as never, ent as never)
    return { monthly: slipsOf(r.id, monthly.id)[0], daily: slipsOf(r.id, daily.id)[0] }
  }
  const basic = (slip: Record<string, unknown>) =>
    (slip.earnings as { code: string; amount: number }[]).filter((l) => l.code === 'basic').reduce((s, l) => s + l.amount, 0)
  const deducted = (slip: Record<string, unknown>, code: string) =>
    (slip.deductions as { code: string; amount: number }[]).filter((l) => l.code === code).reduce((s, l) => s + l.amount, 0)

  it('pays the day whole: the morning worked and the afternoon on paid leave', async () => {
    const { monthly, daily } = await run('pm')
    expect(Number(monthly.undertime_minutes)).toBe(0)
    expect(Number(monthly.absent_days)).toBe(0)
    expect(deducted(monthly, 'undertime')).toBe(0)
    // 11 working days in the period at 800: ten and a half worked, half on leave
    expect(Number(daily.undertime_minutes)).toBe(0)
    expect(basic(daily)).toBe(8800)
  })

  it('an unpaid half is half a day of leave without pay, not undertime', async () => {
    const { monthly, daily } = await run('pm', false)
    expect(Number(monthly.undertime_minutes)).toBe(0)
    expect(Number(monthly.absent_days)).toBe(0.5)
    expect(Number(daily.undertime_minutes)).toBe(0)
    expect(basic(daily)).toBe(8400)
  })

  it('without the half, a whole-day leave on a day with work changes nothing: the short day is undertime', async () => {
    const { monthly, daily } = await run(null)
    expect(Number(monthly.undertime_minutes)).toBe(240)
    expect(Number(daily.undertime_minutes)).toBe(240)
    expect(basic(daily)).toBe(8400)
  })
})
