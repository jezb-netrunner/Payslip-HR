// Loads what the management reports (insights.ts) work from, for one client.
// Payslips come from finalized runs only, with just the snapshot fields the
// reports group by (not the employee's government numbers).

import { getEmployees } from './api'
import type { LeaveType } from './db'
import { fetchAll } from './fetchAll'
import {
  rangeEnd,
  rangeStart,
  toDayFacts,
  toSlipFact,
  whoOf,
  type AdvanceRow,
  type DayFact,
  type EntitlementRow,
  type LeaveRow,
  type MonthRange,
  type PersonRow,
  type RepaymentRow,
  type SlipFact,
  type SlipRow,
} from './insights'
import { supabase } from './supabase'

const WHO = 'name:employee_snapshot->>name, employee_no:employee_snapshot->>employee_no, department:employee_snapshot->>department, position:employee_snapshot->>position, pay_type:employee_snapshot->>pay_type'
const PAY =
  'earnings, deductions, gross_pay, net_pay, withholding_tax, sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, sss_er, sss_mpf_er, sss_ec_er, philhealth_er, pagibig_er, overtime_hours, night_diff_hours, late_minutes, undertime_minutes, absent_days, days_worked, hours_worked'

type Loaded = Omit<SlipRow, 'employee_snapshot'> & { name: string; employee_no: string; department: string; position: string; pay_type: string; days?: unknown }

const toRow = (p: Loaded): SlipRow => ({
  ...p,
  employee_snapshot: { name: p.name, employee_no: p.employee_no, department: p.department, position: p.position, pay_type: p.pay_type },
})

/** Finalized payslips of the payroll months in the range. */
export async function fetchSlipFacts(entityId: string, range: MonthRange): Promise<SlipFact[]> {
  const rows = await fetchAll<Loaded>((f, t) =>
    supabase
      .from('payslips')
      .select(`employee_id, run_type, period_month, period_start, period_end, ${WHO}, ${PAY}, payroll_runs!inner(status)`)
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('period_month', `${range.from}-01`)
      .lte('period_month', `${range.to}-01`)
      .order('period_month')
      .order('id')
      .range(f, t),
  )
  return rows.map((p) => toSlipFact(toRow(p)))
}

/**
 * Attendance: the days of every finalized payslip whose period overlaps the
 * range (a cutoff can straddle two months), with its pay facts.
 */
export async function fetchAttendance(entityId: string, range: MonthRange): Promise<{ days: DayFact[]; slips: SlipFact[] }> {
  const rows = await fetchAll<Loaded>((f, t) =>
    supabase
      .from('payslips')
      .select(`employee_id, run_type, period_month, period_start, period_end, ${WHO}, ${PAY}, days:computation_trace->days, payroll_runs!inner(status)`)
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .neq('run_type', 'thirteenth_month')
      .lte('period_start', rangeEnd(range))
      .gte('period_end', rangeStart(range))
      .order('period_end')
      .order('id')
      .range(f, t),
  )
  return {
    // regular payrolls first, so their days win over an off-cycle run's
    days: [...rows]
      .sort((a, b) => Number(a.run_type !== 'regular') - Number(b.run_type !== 'regular'))
      .flatMap((p) => toDayFacts(whoOf(p.employee_id, toRow(p).employee_snapshot), p.days)),
    slips: rows.map((p) => toSlipFact(toRow(p))),
  }
}

export async function fetchPeople(entityId: string): Promise<PersonRow[]> {
  return getEmployees(entityId)
}

export async function fetchLeave(entityId: string, from: string, to: string, year: number) {
  const [requests, types, entitlements] = await Promise.all([
    fetchAll<LeaveRow>((f, t) =>
      supabase
        .from('leave_requests')
        .select('employee_id, leave_type_id, start_date, end_date, days')
        .eq('entity_id', entityId)
        .eq('status', 'approved')
        .gte('start_date', from)
        .lte('start_date', to)
        .order('start_date')
        .order('id')
        .range(f, t),
    ),
    supabase.from('leave_types').select('id, code, name, paid, default_annual_days, min_service_months').eq('entity_id', entityId),
    fetchAll<EntitlementRow>((f, t) =>
      supabase
        .from('employee_leave_entitlements')
        .select('employee_id, leave_type_id, year, days, employees!inner(entity_id)')
        .eq('employees.entity_id', entityId)
        .eq('year', year)
        .order('id')
        .range(f, t),
    ),
  ])
  if (types.error) throw types.error
  return {
    requests,
    types: (types.data ?? []) as Pick<LeaveType, 'id' | 'code' | 'name' | 'paid' | 'default_annual_days' | 'min_service_months'>[],
    entitlements,
  }
}

export async function fetchAdvances(entityId: string): Promise<{ deductions: AdvanceRow[]; repayments: RepaymentRow[] }> {
  const [deductions, repayments] = await Promise.all([
    fetchAll<AdvanceRow>((f, t) =>
      supabase
        .from('recurring_deductions')
        .select('id, employee_id, category, label, total_amount, balance, amount_per_period, active, released_on, created_at, employees!inner(entity_id)')
        .eq('employees.entity_id', entityId)
        .order('id')
        .range(f, t),
    ),
    fetchAll<RepaymentRow>((f, t) =>
      supabase.from('advance_repayments').select('advance_id, amount, paid_on').eq('entity_id', entityId).order('id').range(f, t),
    ),
  ])
  return { deductions, repayments }
}
