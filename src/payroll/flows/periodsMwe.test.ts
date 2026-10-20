// Cutoff suggestions/slots over a full year (10th/25th semi-monthly,
// 26th-25th monthly, weekly), and an MWE -> non-MWE raise mid-year.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { slotFor, suggestPeriod } from '../../lib/payPeriods'
import { addDays } from '../../lib/manila'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun, fetchFinalizedPayslipsForTaxYear, toAnnualFact } from '../service'
import { buildAlphalist } from '../alphalist'
import { BIR_ANNUAL_2023 } from '../defaults'

function chain(freq: 'weekly' | 'semi_monthly' | 'monthly', seed: { period_end: string }[], n: number) {
  const prev = [...seed]
  const out: { start: string; end: string; slot: ReturnType<typeof slotFor> }[] = []
  for (let i = 0; i < n; i++) {
    const p = suggestPeriod(freq, prev, '')
    out.push({ ...p, slot: slotFor(freq, p.end) })
    prev.unshift({ period_end: p.end })
  }
  return out
}

describe('period chains', () => {
  it('semi-monthly 10th/25th for 2 years: contiguous, every month slots 1 and 2 exactly once', () => {
    const c = chain('semi_monthly', [{ period_end: '2026-10-25' }, { period_end: '2026-10-10' }], 48)
    for (let i = 1; i < c.length; i++) expect(c[i].start).toBe(addDays(c[i - 1].end, 1))
    expect(new Set(c.map((x) => x.end.slice(8)))).toEqual(new Set(['10', '25']))
    const keys = c.map((x) => `${x.slot.month}#${x.slot.index}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('semi-monthly 15th/30th survives February in the 2nd year', () => {
    const c = chain('semi_monthly', [{ period_end: '2026-10-30' }, { period_end: '2026-10-15' }, { period_end: '2026-09-30' }, { period_end: '2026-09-15' }], 48)
    for (let i = 1; i < c.length; i++) expect(c[i].start).toBe(addDays(c[i - 1].end, 1))
    const bad = c.filter((x) => !['15', '30'].includes(x.end.slice(8)) && !x.end.endsWith('-02-28') && !x.end.endsWith('-02-29'))
    expect(bad).toEqual([])
  })

  it('monthly 26th-25th and 30th cutoffs for 2 years', () => {
    for (const seed of [[{ period_end: '2026-10-25' }], [{ period_end: '2026-10-30' }, { period_end: '2026-09-30' }]]) {
      const c = chain('monthly', seed, 24)
      for (let i = 1; i < c.length; i++) expect(c[i].start).toBe(addDays(c[i - 1].end, 1))
      const months = c.map((x) => x.slot.month)
      expect(new Set(months).size).toBe(24)
    }
  })

  it('weekly for 2 years: one slot per cutoff, counts 4/5 consistent within a month', () => {
    const c = chain('weekly', [{ period_end: '2026-10-04' }], 104)
    const byMonth = new Map<string, number[]>()
    for (const x of c) byMonth.set(x.slot.month, [...(byMonth.get(x.slot.month) ?? []), x.slot.index])
    for (const [m, idx] of byMonth) {
      const counts = new Set(c.filter((x) => x.slot.month === m).map((x) => x.slot.count))
      expect(counts.size).toBe(1)
      if (m !== '2026-10-01' && m !== c[c.length - 1].slot.month) expect(idx).toEqual(Array.from({ length: [...counts][0] }, (_, i) => i + 1))
    }
  })
})

describe('MWE -> non-MWE raise in July', () => {
  beforeEach(() => resetDb())
  it('reconciles at year end', async () => {
    const ent = addEntity({ working_days_divisor: 313 })
    const emp = addEmployee(ent, { pay_type: 'daily', daily_rate: 755, monthly_rate: 0, is_minimum_wage_earner: true, work_schedule: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', break_minutes: 60 } })
    addAttendance(emp, '2026-01-01', '2026-12-31')
    for (let m = 1; m <= 12; m++) {
      const mm = String(m).padStart(2, '0')
      if (m === 7) { emp.daily_rate = 2200; emp.is_minimum_wage_earner = false }
      for (const [s, e, pay] of [[`${mm}-01`, `${mm}-15`, `${mm}-20`], [`${mm}-16`, m === 2 ? '02-28' : ['04', '06', '09', '11'].includes(mm) ? `${mm}-30` : `${mm}-31`, m === 12 ? null : `${String(m + 1).padStart(2, '0')}-05`]] as const) {
        if (!pay) continue
        const r = addRun(ent, { period_start: `2026-${s}`, period_end: `2026-${e}`, pay_date: `2026-${pay}`, annualize: m === 12 })
        await computeRun(r as never, ent as never)
        finalize(r.id)
      }
    }
    const slips = await fetchFinalizedPayslipsForTaxYear(ent.id, 2026)
    const [row] = buildAlphalist({ year: 2026, entity: ent as never, employees: db.t.employees as never, payslips: slips.map((p) => ({ employee_id: p.employee_id, fact: toAnnualFact(p) })), taxYears: [], annual: BIR_ANNUAL_2023 })
    expect(row.summary.variance).toBe(0)
    expect(row.schedule).toBe(1)
  })
})
