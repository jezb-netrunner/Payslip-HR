// Orchestrates a payroll run: pulls everything the engine needs from
// Supabase for one client, computes every employee's payslip, and stores
// the drafts. RLS limits all of this to admins of the run's client.

import { getHolidaysBetween, getStatutoryTables } from '../lib/api'
import { fetchAll } from '../lib/fetchAll'
import { supabase } from '../lib/supabase'
import type {
  Employee,
  EmployeeAllowance,
  EmployeeTaxYear,
  Entity,
  PayrollAdjustment,
  PayrollRun,
  Payslip,
  RecurringDeduction,
} from '../lib/db'
import type { AnnualPayslipFact } from './annual'
import { priorFromTaxYear } from './alphalist'
import { computeAttendance } from './attendance'
import { computePayslip } from './engine'
import type {
  BirBucket,
  HolidayLite,
  LeaveLite,
  PayrollSettingsInput,
  PayslipComputation,
  RoundingInput,
  TimeEntryLite,
} from './types'

export interface RunComputationResult {
  computed: number
  totals: Record<string, number>
  warnings: { employee: string; warnings: string[] }[]
}

/** Finalized payslips of one client whose payroll month falls in `year`. */
export type YearPayslip = Pick<
  Payslip,
  | 'employee_id'
  | 'payroll_run_id'
  | 'run_type'
  | 'period_month'
  | 'is_minimum_wage_earner'
  | 'earnings'
  | 'basic_pay'
  | 'gross_pay'
  | 'sss_ee'
  | 'sss_mpf_ee'
  | 'philhealth_ee'
  | 'pagibig_ee'
  | 'union_dues'
  | 'withholding_tax'
  | 'net_pay'
>

export async function fetchFinalizedPayslipsForYear(entityId: string, year: number): Promise<YearPayslip[]> {
  return fetchAll<YearPayslip>((from, to) =>
    supabase
      .from('payslips')
      .select(
        'employee_id, payroll_run_id, run_type, period_month, is_minimum_wage_earner, earnings, basic_pay, gross_pay, sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, union_dues, withholding_tax, net_pay, payroll_runs!inner(status)',
      )
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('period_month', `${year}-01-01`)
      .lte('period_month', `${year}-12-01`)
      .order('id')
      .range(from, to),
  )
}

export function toAnnualFact(p: YearPayslip): AnnualPayslipFact {
  return {
    periodMonth: p.period_month ?? '',
    isMwe: p.is_minimum_wage_earner,
    earnings: p.earnings.map((l) => ({ amount: Number(l.amount), bir: l.bir, taxable: l.taxable })),
    contributionsEe: Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee),
    unionDues: Number(p.union_dues),
    withholdingTax: Number(p.withholding_tax),
  }
}

export async function fetchTaxYears(entityId: string, year: number): Promise<EmployeeTaxYear[]> {
  const { data, error } = await supabase
    .from('employee_tax_years')
    .select('*')
    .eq('entity_id', entityId)
    .eq('year', year)
  if (error) throw error
  return (data ?? []) as EmployeeTaxYear[]
}

/** Employees a run covers: right client, frequency, employment overlapping the period. */
export function employeesForRun(run: PayrollRun, all: Employee[]): Employee[] {
  return all.filter((e) => {
    if (e.hire_date > run.period_end) return false
    if (e.separation_date && e.separation_date < run.period_start) return false
    if (run.run_type !== 'thirteenth_month' && e.pay_frequency !== run.pay_frequency) return false
    if (run.employee_ids && run.employee_ids.length > 0 && !run.employee_ids.includes(e.id)) return false
    return true
  })
}

function roundingFor(entity: Entity, emp: Employee, run: PayrollRun): RoundingInput {
  const applies =
    entity.net_pay_rounding !== 'none' &&
    (entity.rounding_scope === 'all' || emp.payment_method === 'cash')
  return {
    mode: applies ? entity.net_pay_rounding : 'none',
    // A balance left from an earlier carry-forward is always paid out, even
    // after the client switches rounding off or the employee to bank pay.
    carryIn: Number(emp.rounding_balance),
    settle: run.run_type === 'final_pay' || (!!emp.separation_date && emp.separation_date <= run.period_end),
  }
}

export async function computeRun(run: PayrollRun, entity: Entity): Promise<RunComputationResult> {
  if (run.entity_id !== entity.id) throw new Error('This run belongs to another client.')
  const isThirteenth = run.run_type === 'thirteenth_month'
  const year = Number(run.period_month.slice(0, 4))
  const tables = await getStatutoryTables(run.period_end)
  const holidays: HolidayLite[] = isThirteenth
    ? []
    : (await getHolidaysBetween(entity.id, run.period_start, run.period_end)).map((h) => ({
        holiday_date: h.holiday_date,
        name: h.name,
        kind: h.kind,
      }))

  const { data: empData, error: empErr } = await supabase
    .from('employees')
    .select('*')
    .eq('entity_id', entity.id)
    .lte('hire_date', run.period_end)
    .order('last_name')
  if (empErr) throw empErr
  const employees = employeesForRun(run, (empData ?? []) as Employee[])
  const ids = new Set(employees.map((e) => e.id))

  const [entries, leaves, allowances, deductions, adjustments] = await Promise.all([
    isThirteenth
      ? Promise.resolve([] as (TimeEntryLite & { employee_id: string })[])
      : fetchAll<TimeEntryLite & { employee_id: string }>((from, to) =>
          supabase
            .from('time_entries')
            .select('employee_id, work_date, clock_in, clock_out')
            .eq('entity_id', entity.id)
            .gte('work_date', run.period_start)
            .lte('work_date', run.period_end)
            .order('id')
            .range(from, to),
        ),
    isThirteenth
      ? Promise.resolve([])
      : fetchAll<{ employee_id: string; start_date: string; end_date: string; leave_types: { name: string; paid: boolean } | null }>(
          (from, to) =>
            supabase
              .from('leave_requests')
              .select('employee_id, start_date, end_date, leave_types(name, paid)')
              .eq('entity_id', entity.id)
              .eq('status', 'approved')
              .lte('start_date', run.period_end)
              .gte('end_date', run.period_start)
              .order('id')
              .range(from, to),
        ),
    fetchAll<EmployeeAllowance>((from, to) =>
      supabase
        .from('employee_allowances')
        .select('*, employees!inner(entity_id)')
        .eq('employees.entity_id', entity.id)
        .eq('active', true)
        .order('id')
        .range(from, to),
    ),
    isThirteenth
      ? Promise.resolve([] as RecurringDeduction[])
      : fetchAll<RecurringDeduction>((from, to) =>
          supabase
            .from('recurring_deductions')
            .select('*, employees!inner(entity_id)')
            .eq('employees.entity_id', entity.id)
            .eq('active', true)
            .order('id')
            .range(from, to),
        ),
    fetchAll<PayrollAdjustment>((from, to) =>
      supabase.from('payroll_adjustments').select('*').eq('payroll_run_id', run.id).order('id').range(from, to),
    ),
  ])

  // Year-to-date data: 13th month (basic earned, installments, benefits)
  // and annualizing runs (every finalized payslip of the year).
  const needsYear = isThirteenth || run.annualize
  const yearSlips = needsYear
    ? (await fetchFinalizedPayslipsForYear(entity.id, year)).filter(
        (p) => ids.has(p.employee_id) && p.payroll_run_id !== run.id,
      )
    : []
  const taxYears = needsYear ? await fetchTaxYears(entity.id, year) : []

  const groupBy = <T extends { employee_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>()
    for (const r of rows) {
      if (!ids.has(r.employee_id)) continue
      const list = m.get(r.employee_id) ?? []
      list.push(r)
      m.set(r.employee_id, list)
    }
    return m
  }
  const entriesBy = groupBy(entries)
  const leavesBy = groupBy(leaves)
  const allowancesBy = groupBy(allowances)
  const deductionsBy = groupBy(deductions)
  const adjustmentsBy = groupBy(adjustments)
  const yearBy = groupBy(yearSlips)

  const results: { employee: Employee; slip: PayslipComputation }[] = []
  const warnings: { employee: string; warnings: string[] }[] = []

  for (const emp of employees) {
    const engineSettings: PayrollSettingsInput = {
      standardHoursPerDay: Number(entity.standard_hours_per_day),
      workingDaysDivisor: Number(emp.days_per_year ?? entity.working_days_divisor),
      gracePeriodMinutes: entity.grace_period_minutes,
      nightDiffRate: Number(entity.night_diff_rate),
      contributionTiming: entity.contribution_deduction_timing,
      payFrequency: run.pay_frequency ?? emp.pay_frequency,
      minimumWageDaily: Number(entity.minimum_wage_daily),
    }

    const leaveList: LeaveLite[] = (leavesBy.get(emp.id) ?? []).map((l) => ({
      start_date: l.start_date,
      end_date: l.end_date,
      paid: l.leave_types?.paid ?? false,
      type_name: l.leave_types?.name ?? 'Leave',
    }))

    const days = isThirteenth
      ? []
      : computeAttendance({
          periodStart: run.period_start,
          periodEnd: run.period_end,
          schedule: emp.work_schedule,
          standardHoursPerDay: engineSettings.standardHoursPerDay,
          gracePeriodMinutes: engineSettings.gracePeriodMinutes,
          entries: entriesBy.get(emp.id) ?? [],
          holidays,
          approvedLeaves: leaveList,
        })

    const empAdjustments = adjustmentsBy.get(emp.id) ?? []
    const recurring = (deductionsBy.get(emp.id) ?? []).filter(
      (d) => (!d.start_date || d.start_date <= run.period_end) && (!d.end_date || d.end_date >= run.period_start),
    )

    const empYear = yearBy.get(emp.id) ?? []
    const prior = priorFromTaxYear(taxYears.find((t) => t.employee_id === emp.id))
    const peraCredit = Number(taxYears.find((t) => t.employee_id === emp.id)?.pera_tax_credit ?? 0)
    const linesSum = (bucket: BirBucket) =>
      empYear.reduce(
        (s, p) => s + p.earnings.filter((l) => l.bir === bucket).reduce((a, l) => a + Number(l.amount), 0),
        0,
      )

    const slip = computePayslip({
      employee: {
        id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        payType: emp.pay_type,
        monthlyRate: Number(emp.monthly_rate),
        dailyRate: Number(emp.daily_rate),
        isMinimumWageEarner: emp.is_minimum_wage_earner,
        schedule: emp.work_schedule,
        allowances: (allowancesBy.get(emp.id) ?? []).map((a) => ({
          label: a.label,
          amount: Number(a.amount),
          category: a.category,
          basis: a.basis,
        })),
        extraDeductions: isThirteenth
          ? []
          : [
              ...recurring.map((d) => ({
                id: d.id,
                label: d.label,
                category: d.category,
                // Never deduct more than what's left of a tracked balance.
                amount:
                  d.balance !== null && d.balance !== undefined
                    ? Math.min(Number(d.amount_per_period), Math.max(0, Number(d.balance)))
                    : Number(d.amount_per_period),
              })),
              ...empAdjustments
                .filter((a) => a.kind === 'deduction')
                .map((a) => ({ id: a.id, label: a.label, category: a.category, amount: Number(a.amount), oneTime: true })),
            ],
        oneTimeEarnings: empAdjustments
          .filter((a) => a.kind === 'earning')
          .map((a) => ({ id: a.id, label: a.label, amount: Number(a.amount), category: a.category as BirBucket })),
      },
      settings: engineSettings,
      period: {
        start: run.period_start,
        end: run.period_end,
        index: run.period_index,
        count: run.periods_in_month,
      },
      tables,
      days,
      runType: run.run_type,
      rounding: roundingFor(entity, emp, run),
      annualization:
        run.annualize && !isThirteenth
          ? { periodMonth: run.period_month, ytd: empYear.map(toAnnualFact), prior, peraCredit }
          : undefined,
      ytdBasicPay: empYear
        .filter((p) => p.run_type !== 'thirteenth_month')
        .reduce((s, p) => s + Number(p.basic_pay), 0),
      ytdThirteenthPaid: empYear
        .filter((p) => p.run_type === 'thirteenth_month')
        .reduce((s, p) => s + Number(p.gross_pay), 0),
      ytdOtherBenefits: linesSum('other_benefits'),
      priorThirteenthOtherBenefitsExempt: prior.thirteenthOtherBenefitsExempt,
    })

    results.push({ employee: emp, slip })
    if (slip.trace.warnings.length > 0) {
      warnings.push({ employee: `${emp.first_name} ${emp.last_name}`, warnings: slip.trace.warnings })
    }
  }

  // Regular runs of one frequency must agree on how many pay periods the
  // month has, or contributions get split into the wrong number of parts.
  if (run.run_type === 'regular') {
    const { data: siblings } = await supabase
      .from('payroll_runs')
      .select('period_index, periods_in_month')
      .eq('entity_id', entity.id)
      .eq('run_type', 'regular')
      .eq('pay_frequency', run.pay_frequency ?? '')
      .eq('period_month', run.period_month)
      .neq('id', run.id)
    const mismatch = (siblings ?? []).some((s) => s.periods_in_month !== run.periods_in_month)
    if (mismatch) {
      warnings.push({
        employee: 'This run',
        warnings: [
          'Another regular run of this month uses a different number of pay periods — monthly contributions will not split correctly. Make the period counts match.',
        ],
      })
    }
  }

  // Replace existing draft payslips for this run.
  const { error: delErr } = await supabase.from('payslips').delete().eq('payroll_run_id', run.id)
  if (delErr) throw delErr

  const rows = results.map(({ employee: e, slip }) => ({
    payroll_run_id: run.id,
    employee_id: e.id,
    payment_method: e.payment_method,
    is_minimum_wage_earner: e.is_minimum_wage_earner,
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
      pay_frequency: e.pay_frequency,
      payment_method: e.payment_method,
      monthly_rate: e.monthly_rate,
      daily_rate: e.daily_rate,
      hire_date: e.hire_date,
      employer: {
        name: entity.name,
        tin: entity.tin,
        address: entity.registered_address,
      },
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
    union_dues: slip.unionDues,
    other_deductions_total: slip.otherDeductionsTotal,
    total_deductions: slip.totalDeductions,
    net_pay: slip.netPay,
    rounding_adjustment: slip.roundingAdjustment,
    rounding_carry_in: slip.roundingCarryIn,
    rounding_carry_out: slip.roundingCarryOut,
    computation_trace: slip.trace,
  }))

  for (let i = 0; i < rows.length; i += 200) {
    const { error: insErr } = await supabase.from('payslips').insert(rows.slice(i, i + 200))
    if (insErr) throw insErr
  }

  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0)
  const cash = rows.filter((r) => r.payment_method === 'cash')
  const totals: Record<string, number> = {
    employees: rows.length,
    gross: sum((r) => r.gross_pay),
    net: sum((r) => r.net_pay),
    withholding_tax: sum((r) => r.withholding_tax),
    sss_ee: sum((r) => r.sss_ee + r.sss_mpf_ee),
    sss_er: sum((r) => r.sss_er + r.sss_mpf_er + r.sss_ec_er),
    philhealth_ee: sum((r) => r.philhealth_ee),
    philhealth_er: sum((r) => r.philhealth_er),
    pagibig_ee: sum((r) => r.pagibig_ee),
    pagibig_er: sum((r) => r.pagibig_er),
    rounding: sum((r) => r.rounding_adjustment),
    cash_employees: cash.length,
    cash_net: cash.reduce((s, r) => s + r.net_pay, 0),
    employer_cost: 0,
  }
  totals.employer_cost = totals.gross + totals.sss_er + totals.philhealth_er + totals.pagibig_er + totals.rounding
  for (const k of Object.keys(totals)) totals[k] = Math.round((totals[k] + Number.EPSILON) * 100) / 100

  const { error: updErr } = await supabase.from('payroll_runs').update({ totals }).eq('id', run.id)
  if (updErr) throw updErr

  return { computed: rows.length, totals, warnings }
}

export async function finalizeRun(run: PayrollRun): Promise<void> {
  // Atomic DB RPC: the draft->finalized flip, loan balance decrements and
  // the cash-rounding carry chain settle in ONE transaction, exactly once.
  const { error } = await supabase.rpc('finalize_payroll_run', { p_run: run.id })
  if (error) throw error
}

export async function reopenRun(runId: string): Promise<void> {
  // Atomic DB RPC: flips finalized/paid -> draft and restores loan balances
  // and rounding carries this run had moved, in one transaction.
  const { error } = await supabase.rpc('reopen_payroll_run', { p_run: runId })
  if (error) throw error
}
