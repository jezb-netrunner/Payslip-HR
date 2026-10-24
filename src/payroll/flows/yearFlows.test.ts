// Year-level consistency:
//  - Dec 16-31 payroll paid Jan 5: Dec contributions, next year's BIR
//  - weekly months with 4 and 5 cutoffs, mid-month hire, split/first/last
//  - mid-month rate decrease under split / first_period: SSS settles on the
//    month's pay (a refund when the first payroll took too much), the others
//    never go negative or repeat
//  - first_period re-hire within the month (same record)
// SSS follows the month's actual compensation; PhilHealth and Pag-IBIG the rate.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, fetchFinalizedPayslipsForYear, toAnnualFact } from '../service'
import { summarizeYear } from '../annual'
import { BIR_ANNUAL_2023 } from '../defaults'
import { addDays } from '../../lib/manila'

async function runAndFinalize(ent: Record<string, unknown>, over: Parameters<typeof addRun>[1]) {
  const r = addRun(ent, over)
  const res = await computeRun(r as never, ent as never)
  finalize(r.id)
  return { r, res }
}
const ee = (rows: Record<string, number>[]) => Math.round(rows.reduce((s, p) => s + p.sss_ee + p.sss_mpf_ee + p.philhealth_ee + p.pagibig_ee, 0) * 100) / 100
const er = (rows: Record<string, number>[]) => Math.round(rows.reduce((s, p) => s + p.sss_er + p.sss_mpf_er + p.sss_ec_er + p.philhealth_er + p.pagibig_er, 0) * 100) / 100

describe('flows', () => {
  beforeEach(() => resetDb())

  it('Dec 16-31 paid Jan 5', async () => {
    const ent = addEntity()
    const emp = addEmployee(ent)
    addAttendance(emp, '2026-12-01', '2026-12-31')
    const { r: a } = await runAndFinalize(ent, { period_start: '2026-12-01', period_end: '2026-12-15', pay_date: '2026-12-20', annualize: true })
    const { r: b } = await runAndFinalize(ent, { period_start: '2026-12-16', period_end: '2026-12-31', pay_date: '2027-01-05' })
    const dec = db.t.payslips.filter((p) => p.period_month === '2026-12-01')
    expect(ee(dec)).toBe(2450)
    const t26 = await fetchFinalizedPayslipsForTaxYear(ent.id, 2026)
    const t27 = await fetchFinalizedPayslipsForTaxYear(ent.id, 2027)
    expect(t26.map((p) => p.payroll_run_id)).toEqual([a.id])
    expect(t27.map((p) => p.payroll_run_id)).toEqual([b.id])
    expect(toAnnualFact(t27[0]).payMonth).toBe('2027-01-01')
    const y26 = await fetchFinalizedPayslipsForYear(ent.id, 2026)
    expect(y26.length).toBe(2) // 13th-month basis: both halves of December
    const s27 = summarizeYear(t27.map(toAnnualFact), BIR_ANNUAL_2023)
    expect(s27.withheldJanNov).toBe(slipsOf(b.id)[0].withholding_tax)
  })

  it.each([
    ['2026-10', 'split'], ['2026-10', 'first_period'], ['2026-10', 'last_period'],
    ['2026-08', 'split'], ['2026-08', 'first_period'], ['2026-08', 'last_period'],
  ] as const)('weekly %s %s: full month, mid-month hire', async (ym, timing) => {
    const ent = addEntity({ contribution_deduction_timing: timing, default_pay_frequency: 'weekly' })
    const a = addEmployee(ent, { pay_frequency: 'weekly' })
    const h = addEmployee(ent, { pay_frequency: 'weekly', first_name: 'Hire', employee_no: 'E2', hire_date: `${ym}-14` })
    // Sunday cutoffs of the month
    const first = Array.from({ length: 7 }, (_, i) => `${ym}-0${i + 1}`).find((d) => new Date(d + 'T00:00:00Z').getUTCDay() === 0)!
    const ends: string[] = []
    for (let d = first; d.slice(0, 7) === ym; d = addDays(d, 7)) ends.push(d)
    addAttendance(a, addDays(ends[0], -6), ends[ends.length - 1])
    addAttendance(h, addDays(ends[0], -6), ends[ends.length - 1])
    const runs = []
    for (const e of ends) runs.push((await runAndFinalize(ent, { pay_frequency: 'weekly', period_start: addDays(e, -6), period_end: e, pay_date: addDays(e, 5) })).r)
    const sa = runs.flatMap((r) => slipsOf(r.id, a.id))
    const sh = runs.flatMap((r) => slipsOf(r.id, h.id))
    expect(ee(sa)).toBe(2450)
    expect(er(sa)).toBe(3980)
    // the hire's month paid ₱12,241.38 (Oct) / ₱12,482.76 (Aug, five cutoffs): SSS MSC 12,000 / 12,500,
    // plus PhilHealth 750 and Pag-IBIG 200 on the rate
    expect(ee(sh)).toBe(ym === '2026-10' ? 1550 : 1575)
  })

  it.each(['split', 'first_period'] as const)('%s: rate decrease mid-month — no negative, no duplicate', async (timing) => {
    const ent = addEntity({ contribution_deduction_timing: timing })
    const emp = addEmployee(ent, { monthly_rate: 40000 })
    addAttendance(emp, '2026-10-01', '2026-10-31')
    await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    emp.monthly_rate = 18000
    const { r: r2 } = await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    const p2 = slipsOf(r2.id)[0]
    const cols = ['philhealth_ee', 'pagibig_ee', 'philhealth_er', 'pagibig_er']
    for (const c of cols) expect(p2[c]).toBeGreaterThanOrEqual(0)
    // October paid 20,000 + 9,000: SSS MSC 29,000 — EE 1,000 + MPF 450 over the month
    const oct = db.t.payslips.filter((p) => p.period_month === '2026-10-01')
    expect(Math.round(oct.reduce((s, p) => s + p.sss_ee + p.sss_mpf_ee, 0) * 100) / 100).toBe(1450)
  })

  it('first_period re-hire within the month (same record) — no duplicate month', async () => {
    const ent = addEntity({ contribution_deduction_timing: 'first_period' })
    const emp = addEmployee(ent, { separation_date: '2026-10-05', separation_reason: 'resignation' })
    addAttendance(emp, '2026-10-01', '2026-10-05')
    const { r: r1 } = await runAndFinalize(ent, { period_start: '2026-10-01', period_end: '2026-10-15', pay_date: '2026-10-20' })
    emp.separation_date = null
    emp.hire_date = '2026-10-19'
    addAttendance(emp, '2026-10-19', '2026-10-31')
    const { r: r2 } = await runAndFinalize(ent, { period_start: '2026-10-16', period_end: '2026-10-31', pay_date: '2026-11-05' })
    const oct = [...slipsOf(r1.id), ...slipsOf(r2.id)]
    // SSS on October's pay (₱3,965.52 + ₱13,620.69 → MSC 17,500: 875), PhilHealth 750 and Pag-IBIG 200 once
    expect(ee(oct)).toBe(1825)
  })
})
