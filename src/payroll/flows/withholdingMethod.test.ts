// Spec T2 end to end: a payroll stores R, S and the withholding method, CAM
// stays on once triggered, a previous employer's figures start CAM, and the
// pay codes come from the database.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, resetDb, addEntity, addEmployee, addAttendance, addRun, finalize, slipsOf, newId, db } from './fakeSupabase'

vi.mock('../../lib/supabase', () => ({ supabase: fakeSupabase }))

import { computeRun } from '../service'

type Row = Record<string, unknown>

async function runMonth(ent: Row, m: number, adjust?: (run: Row) => void) {
  const mm = String(m).padStart(2, '0')
  const end = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10)
  const r = addRun(ent, { pay_frequency: 'monthly', period_start: `2026-${mm}-01`, period_end: end, pay_date: end })
  adjust?.(r)
  await computeRun(r as never, ent as never)
  finalize(r.id as string)
  return r
}

describe('T2 flows', () => {
  beforeEach(() => resetDb())

  it('W2: overtime in March starts CAM, which stays on; each payslip stores R, S and the method', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 20000 })
    addAttendance(emp, '2026-01-01', '2026-04-30')
    const runs: Row[] = []
    for (let m = 1; m <= 4; m++) {
      runs.push(
        await runMonth(ent, m, (r) => {
          if (m !== 3) return
          db.t.payroll_adjustments.push({
            id: newId(), payroll_run_id: r.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning',
            label: 'Overtime (February)', amount: 10000, category: 'overtime', benefit: null, pay_code: 'OVERTIME_ADJ',
          })
        }),
      )
    }
    const slips = runs.map((r) => slipsOf(r.id as string)[0])
    expect(slips.map((p) => p.wht_method)).toEqual(['regular', 'regular', 'cam', 'cam'])
    // January: 20,000 less SSS 1,000, PhilHealth 500 and Pag-IBIG 200
    expect(slips[0].taxable_regular).toBe(18300)
    expect(slips[0].taxable_supplementary).toBe(0)
    // March: SSS on the month's 30,000 (1,500); S is the overtime
    expect(slips[2].taxable_regular).toBe(17800)
    expect(slips[2].taxable_supplementary).toBe(10000)
    // 3 periods: 15% × (64,400 − 3 × 20,833)
    expect(slips.map((p) => p.withholding_tax)).toEqual([0, 0, 285.15, 0])
    expect(slips[2].earnings.find((l: Row) => l.label === 'Overtime (February)').payCode).toBe('OVERTIME_ADJ')
  })

  it('an adjustment saved before pay codes (category only) gets its category\'s code', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 40000 })
    addAttendance(emp, '2026-06-01', '2026-06-30')
    const r = await runMonth(ent, 6, (run) => {
      db.t.payroll_adjustments.push({
        id: newId(), payroll_run_id: run.id, employee_id: emp.id, entity_id: ent.id, kind: 'earning',
        label: 'Incentive', amount: 5000, category: 'other_taxable', benefit: null,
      })
    })
    const [slip] = slipsOf(r.id as string)
    expect(slip.earnings.find((l: Row) => l.label === 'Incentive').payCode).toBe('OTHER_TAXABLE')
    expect(slip.taxable_supplementary).toBe(5000)
  })

  it('W4: a new hire with a previous employer this year is on CAM from the first payroll', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000, hire_date: '2026-05-01' })
    db.t.employee_tax_years.push({
      id: newId(), employee_id: emp.id, entity_id: ent.id, year: 2026, has_previous_employer: true,
      prev_employment_from: '2026-01-01', prev_employment_to: '2026-04-30',
      prev_mwe_exempt: 0, prev_13th_other_benefits_exempt: 0, prev_de_minimis: 0, prev_contributions: 9800,
      prev_other_non_taxable: 0, prev_taxable_basic: 110200, prev_taxable_13th_other_benefits: 0, prev_taxable_other: 0,
      prev_tax_withheld: 5000, pera_tax_credit: 0,
    })
    addAttendance(emp, '2026-05-01', '2026-05-31')
    const r = await runMonth(ent, 5)
    const [slip] = slipsOf(r.id as string)
    expect(slip.wht_method).toBe('cam')
    expect(slip.taxable_regular).toBe(27550)
    // 5 periods (January to May): 15% × (110,200 + 27,550 − 5 × 20,833) = 5,037.75 due, less 5,000
    expect(slip.withholding_tax).toBe(37.75)
  })

  it('reads the pay codes from the database', async () => {
    const ent = addEntity({ default_pay_frequency: 'monthly' })
    const emp = addEmployee(ent, { pay_frequency: 'monthly', monthly_rate: 30000 })
    addAttendance(emp, '2026-06-01', '2026-06-30')
    db.t.employee_allowances.push({
      id: newId(), employee_id: emp.id, label: 'Transportation', amount: 3000, category: 'transportation',
      basis: 'monthly', active: true, pay_code: 'TRANSPORTATION',
    })
    // a database whose TRANSPORTATION code is supplementary
    const code = db.t.pay_codes.find((c) => c.code === 'TRANSPORTATION')!
    code.income_class = 'supplementary'
    const r = await runMonth(ent, 6)
    const [slip] = slipsOf(r.id as string)
    expect(slip.taxable_supplementary).toBe(3000)
  })
})
