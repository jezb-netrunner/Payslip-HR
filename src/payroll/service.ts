// Orchestrates a payroll run: pulls everything the engine needs from
// Supabase, computes every employee's payslip, and stores the drafts.
// Only admins can call these paths (enforced by RLS).

import { getHolidaysBetween, getSettings, getStatutoryTables } from '../lib/api'
import { supabase } from '../lib/supabase'
import type { CompanySettings, Employee, PayrollRun } from '../lib/db'
import { computeAttendance } from './attendance'
import { computePayslip } from './engine'
import type {
  HolidayLite,
  LeaveLite,
  PayrollSettingsInput,
  PayslipComputation,
  PeriodHalf,
  TimeEntryLite,
} from './types'

function periodHalf(run: PayrollRun, settings: CompanySettings): PeriodHalf {
  if (settings.pay_frequency === 'monthly') return 'full'
  const startDay = Number(run.period_start.slice(8, 10))
  const endDay = Number(run.period_end.slice(8, 10))
  if (startDay <= 15 && endDay <= 15) return 'first'
  if (startDay >= 16) return 'second'
  return 'full'
}

export interface RunComputationResult {
  computed: number
  totals: Record<string, number>
  warnings: { employee: string; warnings: string[] }[]
}

export async function computeRun(run: PayrollRun): Promise<RunComputationResult> {
  const settings = await getSettings()
  const tables = await getStatutoryTables(run.period_end)
  const holidays = (await getHolidaysBetween(run.period_start, run.period_end)).map(
    (h): HolidayLite => ({ holiday_date: h.holiday_date, name: h.name, kind: h.kind }),
  )

  const engineSettings: PayrollSettingsInput = {
    standardHoursPerDay: Number(settings.standard_hours_per_day),
    workingDaysDivisor: Number(settings.working_days_divisor),
    gracePeriodMinutes: settings.grace_period_minutes,
    nightDiffRate: Number(settings.night_diff_rate),
    contributionTiming: settings.contribution_deduction_timing,
    payFrequency: settings.pay_frequency,
    minimumWageDaily: Number(settings.minimum_wage_daily),
  }
  const half = periodHalf(run, settings)

  // Employees on payroll for the period: hired on/before the period end and
  // not separated before the period start.
  const { data: empData, error: empErr } = await supabase
    .from('employees')
    .select('*')
    .lte('hire_date', run.period_end)
    .order('last_name')
  if (empErr) throw empErr
  const employees = ((empData ?? []) as Employee[]).filter(
    (e) => !e.separation_date || e.separation_date >= run.period_start,
  )

  const year = run.period_end.slice(0, 4)

  const results: { employee: Employee; slip: PayslipComputation }[] = []
  const warnings: { employee: string; warnings: string[] }[] = []

  for (const emp of employees) {
    const [entriesRes, leavesRes, allowancesRes, deductionsRes] = await Promise.all([
      supabase
        .from('time_entries')
        .select('work_date, clock_in, clock_out')
        .eq('employee_id', emp.id)
        .gte('work_date', run.period_start)
        .lte('work_date', run.period_end),
      supabase
        .from('leave_requests')
        .select('start_date, end_date, status, leave_types(name, paid)')
        .eq('employee_id', emp.id)
        .eq('status', 'approved')
        .lte('start_date', run.period_end)
        .gte('end_date', run.period_start),
      supabase.from('employee_allowances').select('*').eq('employee_id', emp.id).eq('active', true),
      supabase
        .from('recurring_deductions')
        .select('*')
        .eq('employee_id', emp.id)
        .eq('active', true),
    ])

    const entries = (entriesRes.data ?? []) as TimeEntryLite[]
    const leaves: LeaveLite[] = (leavesRes.data ?? []).map((l) => {
      const lt = l.leave_types as unknown as { name: string; paid: boolean } | null
      return {
        start_date: l.start_date as string,
        end_date: l.end_date as string,
        paid: lt?.paid ?? false,
        type_name: lt?.name ?? 'Leave',
      }
    })

    const days =
      run.run_type === 'thirteenth_month'
        ? []
        : computeAttendance({
            periodStart: run.period_start,
            periodEnd: run.period_end,
            schedule: emp.work_schedule,
            standardHoursPerDay: engineSettings.standardHoursPerDay,
            gracePeriodMinutes: engineSettings.gracePeriodMinutes,
            entries,
            holidays,
            approvedLeaves: leaves,
          })

    let ytdBasicPay = 0
    if (run.run_type === 'thirteenth_month') {
      const { data: ytdRows } = await supabase
        .from('payslips')
        .select('basic_pay, payroll_run_id, payroll_runs!inner(status, period_start, run_type)')
        .eq('employee_id', emp.id)
        .in('payroll_runs.status', ['finalized', 'paid'])
        .eq('payroll_runs.run_type', 'regular')
        .gte('payroll_runs.period_start', `${year}-01-01`)
        .lte('payroll_runs.period_start', `${year}-12-31`)
      ytdBasicPay = (ytdRows ?? []).reduce((s, r) => s + Number(r.basic_pay), 0)
    }

    const slip = computePayslip({
      employee: {
        id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        payType: emp.pay_type,
        monthlyRate: Number(emp.monthly_rate),
        dailyRate: Number(emp.daily_rate),
        isMinimumWageEarner: emp.is_minimum_wage_earner,
        schedule: emp.work_schedule,
        allowances: (allowancesRes.data ?? []).map((a) => ({
          label: a.label as string,
          monthlyAmount: Number(a.monthly_amount),
          taxable: a.taxable as boolean,
          deMinimis: a.de_minimis as boolean,
        })),
        extraDeductions:
          run.run_type === 'thirteenth_month'
            ? []
            : (deductionsRes.data ?? []).map((d) => ({
                id: d.id as string,
                label: d.label as string,
                category: d.category as string,
                // Never deduct more than what's left of a tracked balance.
                amount:
                  d.balance !== null && d.balance !== undefined
                    ? Math.min(Number(d.amount_per_period), Math.max(0, Number(d.balance)))
                    : Number(d.amount_per_period),
              })),
      },
      settings: engineSettings,
      period: { start: run.period_start, end: run.period_end, half },
      tables,
      days,
      runType: run.run_type,
      ytdBasicPay,
    })

    results.push({ employee: emp, slip })
    if (slip.trace.warnings.length > 0) {
      warnings.push({ employee: `${emp.first_name} ${emp.last_name}`, warnings: slip.trace.warnings })
    }
  }

  // Replace existing draft payslips for this run.
  const { error: delErr } = await supabase.from('payslips').delete().eq('payroll_run_id', run.id)
  if (delErr) throw delErr

  const rows = results.map(({ employee: e, slip }) => ({
    payroll_run_id: run.id,
    employee_id: e.id,
    // Run info denormalized onto the payslip so employees never need read
    // access to payroll_runs rows (which carry company-wide totals/notes).
    period_start: run.period_start,
    period_end: run.period_end,
    pay_date: run.pay_date,
    run_type: run.run_type,
    employee_snapshot: {
      name: `${e.first_name} ${e.middle_name ? e.middle_name + ' ' : ''}${e.last_name}${e.suffix ? ' ' + e.suffix : ''}`,
      employee_no: e.employee_no,
      position: e.position,
      department: e.department,
      sss_no: e.sss_no,
      philhealth_no: e.philhealth_no,
      pagibig_no: e.pagibig_no,
      tin: e.tin,
      pay_type: e.pay_type,
      monthly_rate: e.monthly_rate,
      daily_rate: e.daily_rate,
      hire_date: e.hire_date,
    },
    days_worked: slip.daysWorked,
    hours_worked: slip.hoursWorked,
    overtime_hours: slip.overtimeHours,
    night_diff_hours: slip.nightDiffHours,
    late_minutes: slip.lateMinutes,
    undertime_minutes: slip.undertimeMinutes,
    absent_days: slip.absentDays,
    earnings: slip.earnings,
    deductions: slip.deductions,
    basic_pay: slip.basicPay,
    gross_pay: slip.grossPay,
    taxable_income: slip.taxableIncome,
    sss_ee: slip.sssEe,
    sss_er: slip.sssEr,
    sss_ec_er: slip.sssEcEr,
    sss_mpf_ee: slip.sssMpfEe,
    sss_mpf_er: slip.sssMpfEr,
    philhealth_ee: slip.philhealthEe,
    philhealth_er: slip.philhealthEr,
    pagibig_ee: slip.pagibigEe,
    pagibig_er: slip.pagibigEr,
    withholding_tax: slip.withholdingTax,
    other_deductions_total: slip.otherDeductionsTotal,
    total_deductions: slip.totalDeductions,
    net_pay: slip.netPay,
    computation_trace: slip.trace,
  }))

  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('payslips').insert(rows)
    if (insErr) throw insErr
  }

  const totals: Record<string, number> = {
    employees: rows.length,
    gross: sum(rows.map((r) => r.gross_pay)),
    net: sum(rows.map((r) => r.net_pay)),
    withholding_tax: sum(rows.map((r) => r.withholding_tax)),
    sss_ee: sum(rows.map((r) => r.sss_ee + r.sss_mpf_ee)),
    sss_er: sum(rows.map((r) => r.sss_er + r.sss_mpf_er + r.sss_ec_er)),
    philhealth_ee: sum(rows.map((r) => r.philhealth_ee)),
    philhealth_er: sum(rows.map((r) => r.philhealth_er)),
    pagibig_ee: sum(rows.map((r) => r.pagibig_ee)),
    pagibig_er: sum(rows.map((r) => r.pagibig_er)),
    employer_cost: 0,
  }
  totals.employer_cost = round2(totals.gross + totals.sss_er + totals.philhealth_er + totals.pagibig_er)
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k])

  const { error: updErr } = await supabase
    .from('payroll_runs')
    .update({ totals })
    .eq('id', run.id)
  if (updErr) throw updErr

  return { computed: rows.length, totals, warnings }
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0)
}
function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

export async function finalizeRun(run: PayrollRun): Promise<void> {
  // Decrement recurring deduction balances captured in this run's payslips.
  const { data: slips, error } = await supabase
    .from('payslips')
    .select('deductions')
    .eq('payroll_run_id', run.id)
  if (error) throw error

  const byDeduction = new Map<string, number>()
  for (const s of slips ?? []) {
    for (const line of (s.deductions ?? []) as { code: string; amount: number; meta?: string }[]) {
      if (line.code.startsWith('other:') && line.meta) {
        byDeduction.set(line.meta, (byDeduction.get(line.meta) ?? 0) + line.amount)
      }
    }
  }
  for (const [id, amount] of byDeduction) {
    const { data: ded } = await supabase
      .from('recurring_deductions')
      .select('balance')
      .eq('id', id)
      .maybeSingle()
    if (ded && ded.balance !== null) {
      const newBalance = round2(Number(ded.balance) - amount)
      await supabase
        .from('recurring_deductions')
        .update({ balance: newBalance, active: newBalance > 0 })
        .eq('id', id)
    }
  }

  const { data: userData } = await supabase.auth.getUser()
  const { error: updErr } = await supabase
    .from('payroll_runs')
    .update({
      status: 'finalized',
      finalized_at: new Date().toISOString(),
      finalized_by: userData.user?.id ?? null,
    })
    .eq('id', run.id)
  if (updErr) throw updErr
}

export async function reopenRun(runId: string): Promise<void> {
  // Reverse the recurring-deduction balance decrements made at finalization,
  // so a reopen + re-finalize cycle never double-decrements a loan.
  const { data: slips, error: slipErr } = await supabase
    .from('payslips')
    .select('deductions')
    .eq('payroll_run_id', runId)
  if (slipErr) throw slipErr

  const byDeduction = new Map<string, number>()
  for (const s of slips ?? []) {
    for (const line of (s.deductions ?? []) as { code: string; amount: number; meta?: string }[]) {
      if (line.code.startsWith('other:') && line.meta) {
        byDeduction.set(line.meta, (byDeduction.get(line.meta) ?? 0) + line.amount)
      }
    }
  }
  for (const [id, amount] of byDeduction) {
    const { data: ded } = await supabase
      .from('recurring_deductions')
      .select('balance')
      .eq('id', id)
      .maybeSingle()
    if (ded && ded.balance !== null) {
      const restored = round2(Number(ded.balance) + amount)
      await supabase
        .from('recurring_deductions')
        .update({ balance: restored, active: restored > 0 })
        .eq('id', id)
    }
  }

  const { error } = await supabase
    .from('payroll_runs')
    .update({ status: 'draft', finalized_at: null, finalized_by: null })
    .eq('id', runId)
  if (error) throw error
}
