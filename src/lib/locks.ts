// Paid days: attendance (and the schedule) of a date paid by a finalized
// payroll is locked in the database (attendance_locked); screens grey those
// days out instead of letting a save fail.

import { eachDate } from './manila'
import { supabase } from './supabase'

/** employee|date of every paid day of the client's employees in [start, end]. */
export async function lockedKeys(entityId: string, start: string, end: string): Promise<Set<string>> {
  const { data: runs, error } = await supabase
    .from('payroll_runs')
    .select('id, period_start, period_end')
    .eq('entity_id', entityId)
    .in('status', ['finalized', 'paid'])
    .in('run_type', ['regular', 'special', 'final_pay'])
    .lte('period_start', end)
    .gte('period_end', start)
  if (error) throw error
  const out = new Set<string>()
  if (!runs?.length) return out
  const { data: slips, error: slipErr } = await supabase
    .from('payslips')
    .select('employee_id, payroll_run_id')
    .in('payroll_run_id', runs.map((r) => r.id))
  if (slipErr) throw slipErr
  for (const s of slips ?? []) {
    const r = runs.find((x) => x.id === s.payroll_run_id)
    if (!r) continue
    for (const d of eachDate(r.period_start > start ? r.period_start : start, r.period_end < end ? r.period_end : end)) {
      out.add(`${s.employee_id as string}|${d}`)
    }
  }
  return out
}

/** The employee's last day paid by a finalized payroll (null = nothing paid yet). */
export async function lastPaidDate(employeeId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('payslips')
    .select('period_end, payroll_runs!inner(status)')
    .eq('employee_id', employeeId)
    .in('run_type', ['regular', 'special', 'final_pay'])
    .in('payroll_runs.status', ['finalized', 'paid'])
    .order('period_end', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data ?? [])[0] as { period_end: string } | undefined)?.period_end ?? null
}
