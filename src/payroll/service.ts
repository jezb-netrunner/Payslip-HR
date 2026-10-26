// Orchestrates a payroll run: pulls everything the engine needs from
// Supabase for one client, computes every employee's payslip, and stores
// the drafts. RLS limits all of this to admins of the run's client.

import { getEntity, getHolidaysBetween, getStatutoryTables } from '../lib/api'
import { fetchAll } from '../lib/fetchAll'
import { fmtDate } from '../lib/format'
import { addDays, endOfMonth } from '../lib/manila'
import { fetchScheduleRows, NO_SCHEDULE_ROWS, resolversFor } from '../lib/schedules'
import { supabase } from '../lib/supabase'
import type {
  Employee,
  EmployeeAllowance,
  EmployeeTaxYear,
  Entity,
  PayrollAdjustment,
  PayrollDeductionOverride,
  PayrollRun,
  Payslip,
  RecurringDeduction,
} from '../lib/db'
import type { AnnualPayslipFact } from './annual'
import { priorFromTaxYear } from './alphalist'
import { computeAttendance } from './attendance'
import { computePayslip, MATERNITY_LEAVE_CODE, sssCompensation, type ContributionSet, type DeMinimisUsed, type MaternityContext, type MaternityMonth } from './engine'
import { periodsThisYear, type TaxYearToDate } from './withholding'
import { philhealthNgFor } from './philhealth'
import { round2 } from './types'
import type {
  BirBucket,
  DeMinimisKind,
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
  /** Run-level notes ('This run') and employees left out of the run; per-payslip warnings live in each payslip's trace. */
  warnings: { employee: string; warnings: string[] }[]
}

/** Finalized payslip facts the tax year and the 13th month are built from. */
export type YearPayslip = Pick<
  Payslip,
  | 'employee_id'
  | 'payroll_run_id'
  | 'run_type'
  | 'period_month'
  | 'pay_date'
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
  | 'period_end'
  | 'taxable_income'
> & {
  payroll_runs?: { annualize?: boolean } | null
  /** how the payslip's withholding was computed (computation_trace.tax.method) */
  wht_method?: string | null
}

const YEAR_PAYSLIP_COLUMNS =
  'employee_id, payroll_run_id, run_type, period_month, period_end, pay_date, is_minimum_wage_earner, earnings, basic_pay, gross_pay, taxable_income, sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, union_dues, withholding_tax, net_pay, wht_method:computation_trace->tax->>method, payroll_runs!inner(status, annualize)'

/**
 * Finalized payslips of one client whose payroll month falls in `year` —
 * the 13th month counts basic pay EARNED in the calendar year (PD 851).
 */
export async function fetchFinalizedPayslipsForYear(entityId: string, year: number): Promise<YearPayslip[]> {
  return fetchAll<YearPayslip>((from, to) =>
    supabase
      .from('payslips')
      .select(YEAR_PAYSLIP_COLUMNS)
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('period_month', `${year}-01-01`)
      .lte('period_month', `${year}-12-01`)
      .order('id')
      .range(from, to),
  )
}

/**
 * Finalized payslips of one client PAID in `year` — the tax year: BIR
 * withholding on compensation is reported when paid, so a Dec 16–31 payroll
 * released on Jan 5 belongs to the next year's 2316 and alphalist.
 */
export async function fetchFinalizedPayslipsForTaxYear(entityId: string, year: number): Promise<YearPayslip[]> {
  return fetchAll<YearPayslip>((from, to) =>
    supabase
      .from('payslips')
      .select(YEAR_PAYSLIP_COLUMNS)
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('pay_date', `${year}-01-01`)
      .lte('pay_date', `${year}-12-31`)
      .order('id')
      .range(from, to),
  )
}

/**
 * De minimis benefits the tax year's payslips already paid, per benefit, for
 * their ceilings: in the pay month, half-year and year of `payDate` (pesos;
 * days for monetized leave).
 */
export function deMinimisPaid(slips: YearPayslip[], payDate: string): Partial<Record<DeMinimisKind, DeMinimisUsed>> {
  const used: Partial<Record<DeMinimisKind, DeMinimisUsed>> = {}
  const half = (d: string) => (Number(d.slice(5, 7)) <= 6 ? 1 : 2)
  for (const p of slips) {
    const d = p.pay_date ?? ''
    if (d.slice(0, 4) !== payDate.slice(0, 4)) continue
    for (const l of p.earnings) {
      if (!l.dm || l.bir !== 'de_minimis') continue
      const v = l.dm === 'monetized_vl' ? Number(l.leaveDays ?? 0) : Number(l.amount)
      const u = used[l.dm] ?? { month: 0, semester: 0, year: 0 }
      used[l.dm] = {
        month: round2(u.month + (d.slice(0, 7) === payDate.slice(0, 7) ? v : 0)),
        semester: round2(u.semester + (half(d) === half(payDate) ? v : 0)),
        year: round2(u.year + v),
      }
    }
  }
  return used
}

/** Days around a payroll searched for a maternity leave it falls in or pays for. */
const MATERNITY_WINDOW_DAYS = 200

type MaternitySlip = Pick<Payslip, 'employee_id' | 'period_month' | 'deductions' | 'sss_ee' | 'sss_mpf_ee' | 'philhealth_ee' | 'pagibig_ee'>

/** YYYY-MM-01 `n` months before `month`. */
function monthsBefore(month: string, n: number): string {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7)) - 1 - n
  const d = new Date(Date.UTC(y, m, 1))
  return d.toISOString().slice(0, 10)
}

/**
 * The months a maternity leave touches, each with what its finalized
 * payslips charged and how it was funded: the month's own pay, prepaid
 * shares used, and the shares maternity payouts took for it.
 */
export function maternityContext(
  leave: { start_date: string; end_date: string },
  slips: MaternitySlip[],
  thisMonth: string,
): MaternityContext {
  const months: MaternityMonth[] = []
  for (let m = `${leave.start_date.slice(0, 7)}-01`; m <= leave.end_date; m = `${addDays(endOfMonth(m), 1).slice(0, 7)}-01`) {
    const own = slips.filter((p) => p.period_month === m)
    const lines = (code: string) =>
      own.reduce((s, p) => s + p.deductions.filter((l) => l.code === code).reduce((a, l) => a - Number(l.amount), 0), 0)
    const charged = own.reduce((s, p) => s + Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee), 0)
    const prepaidUsed = lines('ee_prepaid')
    const covered = slips.reduce(
      (s, p) =>
        s +
        p.deductions
          .filter((l) => l.code === 'maternity_contributions')
          .reduce((a, l) => a + (l.covers ?? []).filter((c) => c.month === m).reduce((b, c) => b + Number(c.amount), 0), 0),
      0,
    )
    months.push({
      month: m,
      charged: round2(charged),
      fundedByPay: round2(charged - prepaidUsed - lines('ee_pending') - lines('ee_collect')),
      prepaidUsed: round2(prepaidUsed),
      covered: round2(covered),
    })
  }
  return { leaveStart: leave.start_date, months, thisMonth }
}

/** How a finalized payslip's withholding was computed (the trace itself in the test double). */
function whtMethodOf(p: YearPayslip): string | undefined {
  return p.wht_method ?? (p as { computation_trace?: { tax?: { method?: string } } }).computation_trace?.tax?.method
}

export function toAnnualFact(p: YearPayslip): AnnualPayslipFact {
  return {
    payMonth: p.pay_date ? `${p.pay_date.slice(0, 7)}-01` : (p.period_month ?? ''),
    payDate: p.pay_date ?? undefined,
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
  const picked = run.employee_ids && run.employee_ids.length > 0 ? new Set(run.employee_ids) : null
  return all.filter((e) => {
    if (picked && !picked.has(e.id)) return false
    if (e.hire_date > run.period_end) return false
    // A final pay released after the period holding the last day covers the
    // employees picked for it (one-time items and tax adjustment only).
    if (e.separation_date && e.separation_date < run.period_start && !(run.run_type === 'final_pay' && picked)) {
      return false
    }
    if (run.run_type !== 'thirteenth_month' && e.pay_frequency !== run.pay_frequency) return false
    return true
  })
}

/** Separated on or before the end of the run's period. */
function separatedBy(e: Employee, run: PayrollRun): boolean {
  return !!e.separation_date && e.separation_date <= run.period_end
}

/** Final pay released after the employee's last day: nothing worked to pay. */
function extrasOnly(e: Employee, run: PayrollRun): boolean {
  return run.run_type === 'final_pay' && !!e.separation_date && e.separation_date < run.period_start
}

/** Days before the period read for the workday before an early regular holiday. */
const HOLIDAY_LOOKBACK_DAYS = 10

const CONTRIBUTION_COLUMNS =
  'sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, sss_er, sss_mpf_er, sss_ec_er, philhealth_er, pagibig_er, philhealth_ng'

type MonthSlip = Pick<
  Payslip,
  | 'employee_id'
  | 'run_type'
  | 'earnings'
  | 'sss_ee'
  | 'sss_mpf_ee'
  | 'philhealth_ee'
  | 'pagibig_ee'
  | 'sss_er'
  | 'sss_mpf_er'
  | 'sss_ec_er'
  | 'philhealth_er'
  | 'pagibig_er'
  | 'philhealth_ng'
> & { payroll_runs?: { period_index?: number; periods_in_month?: number } | null }

function sumContributions(slips: MonthSlip[]): ContributionSet {
  const n = (f: (p: MonthSlip) => unknown) => slips.reduce((s, p) => s + Number(f(p) ?? 0), 0)
  return {
    sssEe: n((p) => p.sss_ee),
    sssMpfEe: n((p) => p.sss_mpf_ee),
    philhealthEe: n((p) => p.philhealth_ee),
    pagibigEe: n((p) => p.pagibig_ee),
    sssEr: n((p) => p.sss_er),
    sssMpfEr: n((p) => p.sss_mpf_er),
    sssEcEr: n((p) => p.sss_ec_er),
    philhealthEr: n((p) => p.philhealth_er),
    pagibigEr: n((p) => p.pagibig_er),
    philhealthNg: n((p) => p.philhealth_ng),
  }
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
    settle: run.run_type === 'final_pay' || separatedBy(emp, run),
  }
}

export async function computeRun(run: PayrollRun, selected: Entity): Promise<RunComputationResult> {
  if (run.entity_id !== selected.id) throw new Error('This run belongs to another client.')
  // Mark the draft as being computed BEFORE reading any input: a change to
  // the inputs from here on (database staleness triggers) wipes this token,
  // and the totals update at the end then refuses to complete the draft. A
  // change between reading and marking would otherwise be overwritten.
  const token = crypto.randomUUID()
  const { data: marked, error: tokErr } = await supabase
    .from('payroll_runs')
    .update({ totals: { computing: token } })
    .eq('id', run.id)
    .eq('status', 'draft')
    .select('id')
  if (tokErr) throw tokErr
  if (!marked || marked.length === 0) throw new Error('This run is no longer a draft.')
  // Another admin may have changed the client's pay policy since this
  // console loaded it: compute from the current record.
  const entity = await getEntity(run.entity_id)
  const isThirteenth = run.run_type === 'thirteenth_month'
  const payrollYear = Number(run.period_month.slice(0, 4))
  const taxYear = Number(run.pay_date.slice(0, 4))
  const warnings: { employee: string; warnings: string[] }[] = []
  // contributions follow the period worked; withholding follows the pay
  // date, like the tax year
  const [periodTables, payTables] = await Promise.all([
    getStatutoryTables(run.period_end),
    run.pay_date === run.period_end ? null : getStatutoryTables(run.pay_date),
  ])
  const tables = payTables
    ? { ...periodTables, bir_wht: payTables.bir_wht, bir_annual: payTables.bir_annual, de_minimis: payTables.de_minimis }
    : periodTables
  // A regular holiday is paid after work or paid leave on the workday before
  // it, which for a holiday early in the period lies in the days before it
  // (a long weekend, Holy Week): attendance is also read for those days.
  const lookbackStart = addDays(run.period_start, -HOLIDAY_LOOKBACK_DAYS)
  const holidays: HolidayLite[] = isThirteenth
    ? []
    : (await getHolidaysBetween(entity.id, lookbackStart, run.period_end)).map((h) => ({
        holiday_date: h.holiday_date,
        name: h.name,
        kind: h.kind,
      }))
  // only the client's holiday absence rule (off by default) needs those days
  const looksBack = entity.holiday_absence_rule === true && holidays.some((h) => h.kind === 'regular' && h.holiday_date >= run.period_start)
  const attendanceFrom = looksBack ? lookbackStart : run.period_start

  const candidates = employeesForRun(
    run,
    await fetchAll<Employee>((from, to) =>
      supabase
        .from('employees')
        .select('*')
        .eq('entity_id', entity.id)
        .lte('hire_date', run.period_end)
        .order('last_name')
        .order('id')
        .range(from, to),
    ),
  )

  // Never pay the same days twice: anyone a finalized run already paid for
  // part of this period is left out (finalize enforces the same rule).
  let employees = candidates
  if (!isThirteenth) {
    const paid = await fetchAll<{ employee_id: string; period_start: string; period_end: string }>((from, to) =>
      supabase
        .from('payslips')
        .select('employee_id, period_start, period_end, payroll_runs!inner(status)')
        .eq('entity_id', entity.id)
        .neq('payroll_run_id', run.id)
        .neq('run_type', 'thirteenth_month')
        .in('payroll_runs.status', ['finalized', 'paid'])
        .lte('period_start', run.period_end)
        .gte('period_end', run.period_start)
        .order('id')
        .range(from, to),
    )
    const paidBy = new Map(paid.map((p) => [p.employee_id, p]))
    employees = candidates.filter((e) => {
      const p = paidBy.get(e.id)
      if (!p) return true
      warnings.push({
        employee: `${e.first_name} ${e.last_name}`,
        warnings: [
          `Left out: already paid for ${p.period_start} to ${p.period_end} in another finalized payroll. Pay any remaining days in a run that doesn't overlap that period.`,
        ],
      })
      return false
    })
  }
  const ids = new Set(employees.map((e) => e.id))

  // A final pay after the last day only carries one-time items and the tax
  // adjustment: flag anyone whose last days were never paid, and pick up
  // the separation month's contributions to check that month was completed.
  const slipWarnings = new Map<string, string[]>()
  const separationMonth = new Map<string, { label: string; already: ContributionSet; compensation?: number }>()
  for (const e of employees.filter((x) => extrasOnly(x, run))) {
    const separation = e.separation_date as string
    const { data: last, error: lastErr } = await supabase
      .from('payslips')
      .select('period_end, payroll_runs!inner(status)')
      .eq('employee_id', e.id)
      .neq('run_type', 'thirteenth_month')
      .in('payroll_runs.status', ['finalized', 'paid'])
      .order('period_end', { ascending: false })
      .limit(1)
    if (lastErr) throw lastErr
    const paidThrough = (last?.[0] as { period_end: string } | undefined)?.period_end
    if (!paidThrough || paidThrough < separation) {
      slipWarnings.set(e.id, [
        `Separated ${separation}, but finalized payrolls only paid ${paidThrough ? `through ${paidThrough}` : 'nothing yet'}: this final pay (after the last day) carries one-time items and the tax adjustment only. Use a final-pay period that includes the last day to pay the remaining days.`,
      ])
      continue
    }
    // the last day was paid: did that payroll complete the month's contributions?
    const sepMonth = `${separation.slice(0, 7)}-01`
    const { data: sepSlips, error: sepErr } = await supabase
      .from('payslips')
      .select(`employee_id, earnings, ${CONTRIBUTION_COLUMNS}, payroll_runs!inner(status)`)
      .eq('employee_id', e.id)
      .eq('period_month', sepMonth)
      .neq('run_type', 'thirteenth_month')
      .neq('payroll_run_id', run.id)
      .in('payroll_runs.status', ['finalized', 'paid'])
    if (sepErr) throw sepErr
    if ((sepSlips ?? []).length > 0) {
      separationMonth.set(e.id, {
        label: new Date(`${sepMonth}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }),
        already: sumContributions(sepSlips as unknown as MonthSlip[]),
        compensation: sssCompensation((sepSlips as unknown as MonthSlip[]).flatMap((p) => p.earnings ?? []), {
          sssInclude13thMonth: entity.sss_include_13th_month !== false,
        }),
      })
    }
  }

  const [entries, leaves, allowances, deductions, adjustments, scheduleRows, deductionOverrides] = await Promise.all([
    isThirteenth
      ? Promise.resolve([] as (TimeEntryLite & { employee_id: string })[])
      : fetchAll<TimeEntryLite & { employee_id: string }>((from, to) =>
          supabase
            .from('time_entries')
            .select('employee_id, work_date, clock_in, clock_out')
            .eq('entity_id', entity.id)
            .gte('work_date', attendanceFrom)
            .lte('work_date', run.period_end)
            .order('id')
            .range(from, to),
        ),
    isThirteenth
      ? Promise.resolve([])
      : fetchAll<{ employee_id: string; start_date: string; end_date: string; leave_types: { name: string; paid: boolean; code: string } | null }>(
          (from, to) =>
            supabase
              .from('leave_requests')
              .select('employee_id, start_date, end_date, leave_types(name, paid, code)')
              .eq('entity_id', entity.id)
              .eq('status', 'approved')
              .lte('start_date', run.period_end)
              .gte('end_date', attendanceFrom)
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
            // paused ones too: a separation must not pass a paused advance
            // silently, and this payroll may set an amount for any of them
            .order('id')
            .range(from, to),
        ),
    fetchAll<PayrollAdjustment>((from, to) =>
      supabase.from('payroll_adjustments').select('*').eq('payroll_run_id', run.id).order('id').range(from, to),
    ),
    isThirteenth ? Promise.resolve(NO_SCHEDULE_ROWS) : fetchScheduleRows({ entityId: entity.id }, attendanceFrom, run.period_end),
    isThirteenth
      ? Promise.resolve([] as PayrollDeductionOverride[])
      : fetchAll<PayrollDeductionOverride>((from, to) =>
          supabase.from('payroll_deduction_overrides').select('*').eq('payroll_run_id', run.id).order('id').range(from, to),
        ),
  ])

  // Year-to-date data. 13th month: basic earned in the payroll year.
  // Annualization (the run's flag, or the employee separating within the
  // period — the last pay of a separated employee settles their tax):
  // everything PAID in the tax year.
  // 13th month: the exemption cap is per TAX year, and a 13th month paid
  // after the year was annualized re-annualizes.
  // A bonus or 13th month installment paid with a regular payroll: what the
  // tax year already paid decides how much of it is still exempt.
  // Withholding builds on the year's taxable pay and tax withheld.
  const annualizes = (e: Employee) => !isThirteenth && (run.annualize || separatedBy(e, run))
  const isBenefit = (bucket: string) => bucket === 'thirteenth' || bucket === 'other_benefits'
  // every payroll reads the tax year: the cumulative average method of
  // withholding builds on the year's taxable pay and tax withheld
  const needsTaxYear = employees.length > 0
  const [yearSlips, taxSlips, taxYears, monthSlips] = await Promise.all([
    isThirteenth ? fetchFinalizedPayslipsForYear(entity.id, payrollYear) : Promise.resolve([] as YearPayslip[]),
    needsTaxYear ? fetchFinalizedPayslipsForTaxYear(entity.id, taxYear) : Promise.resolve([] as YearPayslip[]),
    needsTaxYear ? fetchTaxYears(entity.id, taxYear) : Promise.resolve([] as EmployeeTaxYear[]),
    // contributions already deducted this payroll month, and the SSS
    // compensation already paid (a 13th month pay counts in its month)
    fetchAll<MonthSlip>((from, to) =>
      supabase
        .from('payslips')
        .select(`employee_id, run_type, earnings, ${CONTRIBUTION_COLUMNS}, payroll_runs!inner(status, period_index, periods_in_month)`)
        .eq('entity_id', entity.id)
        .eq('period_month', run.period_month)
        .neq('payroll_run_id', run.id)
        .in('payroll_runs.status', ['finalized', 'paid'])
        .order('id')
        .range(from, to),
    ),
  ])

  // Maternity leaves around this payroll (RA 11210): the months they touch
  // contribute the usual amounts, and the payroll paying the maternity pay
  // takes the employee's shares for all of them. Read: the approved leaves,
  // and the finalized payslips of those months and of the payouts.
  const mlLeaves = isThirteenth
    ? []
    : await fetchAll<{ employee_id: string; start_date: string; end_date: string }>((from, to) =>
        supabase
          .from('leave_requests')
          .select('employee_id, start_date, end_date, leave_types!inner(code)')
          .eq('entity_id', entity.id)
          .eq('status', 'approved')
          .eq('leave_types.code', MATERNITY_LEAVE_CODE)
          .lte('start_date', addDays(run.period_end, MATERNITY_WINDOW_DAYS))
          .gte('end_date', addDays(run.period_start, -MATERNITY_WINDOW_DAYS))
          .order('id')
          .range(from, to),
      )
  const leaveFor = new Map<string, { start_date: string; end_date: string }>()
  for (const e of employees) {
    const own = mlLeaves.filter((l) => l.employee_id === e.id)
    const monthStart = run.period_month
    const monthEnd = endOfMonth(run.period_month)
    // the leave in this payroll's month, else the next one (maternity pay
    // advanced before the leave), else the last one (paid after it)
    const pick =
      own.find((l) => l.start_date <= monthEnd && l.end_date >= monthStart) ??
      own.filter((l) => l.start_date > monthEnd).sort((a, b) => a.start_date.localeCompare(b.start_date))[0] ??
      own.filter((l) => l.end_date < monthStart).sort((a, b) => b.end_date.localeCompare(a.end_date))[0]
    if (pick) leaveFor.set(e.id, pick)
  }
  const matSlips =
    leaveFor.size === 0
      ? []
      : await fetchAll<MaternitySlip>((from, to) =>
          supabase
            .from('payslips')
            .select('employee_id, period_month, deductions, sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, payroll_runs!inner(status)')
            .eq('entity_id', entity.id)
            .in('employee_id', [...leaveFor.keys()])
            .neq('payroll_run_id', run.id)
            .in('payroll_runs.status', ['finalized', 'paid'])
            .gte('period_month', monthsBefore(run.period_month, 12))
            .order('id')
            .range(from, to),
        )

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
  // each employee's schedule per date: patterns in force and roster changes
  const schedules = resolversFor(employees, scheduleRows)
  // what this payroll deducts instead of the usual installment
  const setAmount = new Map(deductionOverrides.map((o) => [o.deduction_id, Number(o.amount)]))
  const yearBy = groupBy(yearSlips.filter((p) => p.payroll_run_id !== run.id))
  const taxBy = groupBy(taxSlips.filter((p) => p.payroll_run_id !== run.id))
  const monthBy = groupBy(monthSlips)

  const results: { employee: Employee; slip: PayslipComputation }[] = []

  for (const emp of employees) {
    const engineSettings: PayrollSettingsInput = {
      standardHoursPerDay: Number(entity.standard_hours_per_day),
      workingDaysDivisor: Number(emp.days_per_year ?? entity.working_days_divisor),
      gracePeriodMinutes: entity.grace_period_minutes,
      nightDiffRate: Number(entity.night_diff_rate),
      contributionTiming: entity.contribution_deduction_timing,
      payFrequency: run.pay_frequency ?? emp.pay_frequency,
      minimumWageDaily: Number(entity.minimum_wage_daily),
      mweRhRestdayPremiumTaxable: entity.mwe_rh_restday_premium_taxable !== false,
      paidVlDaysPerYear: Number(entity.paid_vl_days_per_year ?? 0),
      silConversionTaxable: entity.sil_conversion_taxable !== false,
      sssInclude13thMonth: entity.sss_include_13th_month !== false,
      holidayAbsenceRule: entity.holiday_absence_rule === true,
      holidayPayExempt: entity.holiday_pay_exempt === true,
      ...(entity.maternity_differential_exempt && entity.dole_exemption_valid_until
        ? { maternityDifferentialExemption: { ref: entity.dole_exemption_ref, validUntil: entity.dole_exemption_valid_until } }
        : {}),
    }

    const leaveList: LeaveLite[] = (leavesBy.get(emp.id) ?? []).map((l) => ({
      start_date: l.start_date,
      end_date: l.end_date,
      paid: l.leave_types?.paid ?? false,
      type_name: l.leave_types?.name ?? 'Leave',
      type_code: l.leave_types?.code,
    }))

    const attendanceOf = (periodStart: string, periodEnd: string) =>
      computeAttendance({
        periodStart,
        periodEnd,
        schedule: schedules.get(emp.id) ?? emp.work_schedule,
        standardHoursPerDay: engineSettings.standardHoursPerDay,
        gracePeriodMinutes: engineSettings.gracePeriodMinutes,
        entries: entriesBy.get(emp.id) ?? [],
        holidays,
        approvedLeaves: leaveList,
      })
    const days = isThirteenth ? [] : attendanceOf(run.period_start, run.period_end)
    const daysBefore = isThirteenth || !looksBack ? undefined : attendanceOf(lookbackStart, addDays(run.period_start, -1))

    const empAdjustments = adjustmentsBy.get(emp.id) ?? []
    const empDeductions = deductionsBy.get(emp.id) ?? []
    const inPeriod = (d: RecurringDeduction) =>
      (!d.start_date || d.start_date <= run.period_end) && (!d.end_date || d.end_date >= run.period_start)
    // a final pay after the last day carries one-time items only; an amount
    // set for this payroll applies even to a paused or not-yet-started one
    const recurring = extrasOnly(emp, run)
      ? []
      : empDeductions.filter((d) => d.category !== 'cash_advance' && (setAmount.has(d.id) || (d.active && inPeriod(d))))
    // Cash advances, oldest first: the amount set for this payroll, else the
    // installment (none when it has no fixed one), or the whole balance on
    // the payroll that settles a separation (and on final pay).
    const settles = separatedBy(emp, run)
    const owed = empDeductions.filter((d) => d.category === 'cash_advance' && Number(d.balance ?? 0) > 0)
    const advances = owed
      .filter((d) => setAmount.has(d.id) || (d.active && (settles || inPeriod(d))))
      .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? '') || a.id.localeCompare(b.id))
    // a paused advance stays paused (the admin may collect it another way),
    // but the payroll that settles a separation says what is still owed
    const pausedOwed = settles ? owed.filter((d) => !d.active && !setAmount.has(d.id)) : []
    const setFor = (d: RecurringDeduction) => setAmount.get(d.id)

    const empYear = yearBy.get(emp.id) ?? []
    const empTax = taxBy.get(emp.id) ?? []
    const empMonth = monthBy.get(emp.id) ?? []
    // the year's tax was already trued up (annualizing run, final pay, or
    // the payroll that included the separation)
    const taxYearAnnualized = empTax.some(
      (p) =>
        p.run_type !== 'thirteenth_month' &&
        (p.payroll_runs?.annualize || p.run_type === 'final_pay' || (!!emp.separation_date && (p.period_end ?? '') >= emp.separation_date)),
    )
    const taxYearRow = taxYears.find((t) => t.employee_id === emp.id)
    const prior = priorFromTaxYear(taxYearRow)
    const peraCredit = Number(taxYearRow?.pera_tax_credit ?? 0)
    const linesSum = (bucket: BirBucket) =>
      empYear.reduce(
        (s, p) => s + p.earnings.filter((l) => l.bir === bucket).reduce((a, l) => a + Number(l.amount), 0),
        0,
      )
    // 13th month pay and other benefits already paid in the tax year
    const taxYearBenefits = empTax.reduce(
      (s, p) => s + p.earnings.filter((l) => isBenefit(l.bir ?? '')).reduce((a, l) => a + Number(l.amount), 0),
      0,
    )

    // The tax year so far for the cumulative average method (RR 2-98 Sec.
    // 2.79(B)(5)(a)): taxable pay and tax withheld from 1 January, an
    // earlier employer's included (its BIR Form 2316), and the payroll
    // periods from 1 January or the first employment this year
    const frequency = run.pay_frequency ?? emp.pay_frequency
    const yearStart = `${taxYear}-01-01`
    const earlierEmployerFrom = taxYearRow?.has_previous_employer ? (taxYearRow.prev_employment_from ?? yearStart) : null
    const firstEmployment = [emp.hire_date, earlierEmployerFrom].filter((d): d is string => !!d).sort()[0]
    const periodTo = isThirteenth ? run.pay_date : run.period_end
    const clamp = (d: string) => (d < yearStart ? yearStart : d > `${taxYear}-12-31` ? `${taxYear}-12-31` : d)
    // only what was paid by this payroll's pay date: a payroll reopened and
    // recomputed ignores what later payrolls paid and withheld
    const taxBefore = empTax.filter((p) => (p.pay_date ?? '') <= run.pay_date)
    // payroll periods of last year paid this tax year (Dec 16–31 released in January)
    const lagged = new Set(taxBefore.filter((p) => p.run_type === 'regular' && (p.period_end ?? '') < yearStart).map((p) => p.period_end)).size
    const taxYearToDate: TaxYearToDate = {
      taxableBefore: round2(
        taxBefore.reduce((s, p) => s + Number(p.taxable_income ?? 0), 0) +
          prior.taxableBasic + prior.taxable13thOtherBenefits + prior.taxableOther,
      ),
      withheldBefore: round2(taxBefore.reduce((s, p) => s + Number(p.withholding_tax), 0) + prior.taxWithheld),
      periods: lagged + periodsThisYear(frequency, clamp(firstEmployment > yearStart ? firstEmployment : yearStart), clamp(periodTo)),
      cumulative: !!taxYearRow?.has_previous_employer || taxBefore.some((p) => whtMethodOf(p) === 'cumulative_average'),
    }

    const slip = computePayslip({
      employee: {
        id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        payType: emp.pay_type,
        monthlyRate: Number(emp.monthly_rate),
        dailyRate: Number(emp.daily_rate),
        isMinimumWageEarner: emp.is_minimum_wage_earner,
        apprentice: emp.employment_status === 'apprentice',
        philhealthNg: isThirteenth ? undefined : philhealthNgFor(emp, run.period_month),
        hazardCertificationRef: emp.hazard_certification_ref ?? '',
        schedule: emp.work_schedule,
        hireDate: emp.hire_date,
        separationDate: emp.separation_date,
        allowances: (allowancesBy.get(emp.id) ?? []).map((a) => ({
          label: a.label,
          amount: Number(a.amount),
          category: a.category,
          basis: a.basis,
          ...(a.de_minimis_kind ? { deMinimisKind: a.de_minimis_kind } : {}),
          ...(a.pay_item_type ? { payItemType: a.pay_item_type } : {}),
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
                    ? Math.min(setFor(d) ?? Number(d.amount_per_period), Math.max(0, Number(d.balance)))
                    : (setFor(d) ?? Number(d.amount_per_period)),
              })),
              ...empAdjustments
                .filter((a) => a.kind === 'deduction')
                .map((a) => ({ id: a.id, label: a.label, category: a.category, amount: Number(a.amount), oneTime: true })),
              ...advances.map((d) => ({
                id: d.id,
                label: d.label,
                category: d.category,
                amount:
                  setFor(d) !== undefined
                    ? Math.min(setFor(d)!, Number(d.balance))
                    : settles
                      ? Number(d.balance)
                      : Math.min(Number(d.amount_per_period), Number(d.balance)),
                upToNet: true,
                balance: Number(d.balance),
                // no later payroll follows a separation, whatever amount was set
                settlement: settles,
              })),
            ],
        oneTimeEarnings: empAdjustments
          .filter((a) => a.kind === 'earning')
          .map((a) => ({
            id: a.id,
            label: a.label,
            amount: Number(a.amount),
            category: a.category as BirBucket,
            ...(a.benefit ? { benefit: a.benefit } : {}),
            ...(a.de_minimis_kind ? { deMinimisKind: a.de_minimis_kind } : {}),
            ...(a.leave_days ? { leaveDays: Number(a.leave_days) } : {}),
            ...(a.pay_item_type ? { payItemType: a.pay_item_type } : {}),
          })),
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
        annualizes(emp) || (isThirteenth && taxYearAnnualized)
          ? {
              payMonth: `${run.pay_date.slice(0, 7)}-01`,
              ytd: empTax.map(toAnnualFact),
              prior,
              peraCredit,
            }
          : undefined,
      extrasOnly: extrasOnly(emp, run),
      daysBefore,
      separationMonth: separationMonth.get(emp.id),
      monthContributions: {
        already: sumContributions(empMonth),
        compensationAlready: sssCompensation(empMonth.flatMap((p) => p.earnings ?? []), engineSettings),
        // the month's last slot, a separation, or a payroll for earlier
        // days computed after the month's closing payroll was final (a 13th
        // month pay then trues the month up)
        closes:
          (!isThirteenth && (run.period_index >= run.periods_in_month || separatedBy(emp, run))) ||
          empMonth.some(
            (p) =>
              p.run_type !== 'thirteenth_month' &&
              (p.payroll_runs?.period_index ?? 0) >= (p.payroll_runs?.periods_in_month ?? Infinity),
          ),
        opens: !isThirteenth && !empMonth.some((p) => p.run_type !== 'thirteenth_month'),
      },
      ytdBasicPay: empYear
        .filter((p) => p.run_type !== 'thirteenth_month')
        .reduce((s, p) => s + Number(p.basic_pay), 0),
      ytdThirteenthPaid: empYear
        .filter((p) => p.run_type === 'thirteenth_month')
        .reduce((s, p) => s + Number(p.gross_pay), 0),
      ytdOtherBenefits: linesSum('other_benefits'),
      priorThirteenthOtherBenefitsExempt: prior.thirteenthOtherBenefitsExempt,
      taxYearBenefitsPaid: isThirteenth ? taxYearBenefits : undefined,
      benefitsExemptLeft: isThirteenth
        ? undefined
        : Math.max(0, tables.bir_annual.other_benefits_exemption_cap - prior.thirteenthOtherBenefitsExempt - taxYearBenefits),
      taxYear: taxYearToDate,
      deMinimisUsed: deMinimisPaid(taxBefore, run.pay_date),
      maternity: leaveFor.has(emp.id)
        ? maternityContext(leaveFor.get(emp.id)!, matSlips.filter((p) => p.employee_id === emp.id), run.period_month)
        : undefined,
    })
    slip.trace.warnings.unshift(...(slipWarnings.get(emp.id) ?? []))
    if (isThirteenth) {
      // 13th month is due by Dec 24 (PD 851), often before the year's last
      // payrolls are final: say what the basic pay counted runs through
      const counted = empYear
        .filter((p) => p.run_type !== 'thirteenth_month')
        .reduce((m, p) => ((p.period_end ?? '') > m ? (p.period_end ?? '') : m), '')
      const yearEnd = `${payrollYear}-12-31`
      const until = emp.separation_date && emp.separation_date < yearEnd ? emp.separation_date : yearEnd
      if (counted && counted < until) {
        slip.trace.warnings.push(
          `Basic pay counted through ${fmtDate(counted)}, the last finalized payroll. Pay what the rest of ${payrollYear} adds with another 13th month run once those payrolls are final — it deducts what this one pays.`,
        )
      }
    }
    const peso = (v: number) => `₱${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    for (const d of [...recurring, ...advances]) {
      const set = setFor(d)
      if (set === undefined) continue
      const usual = d.category === 'cash_advance' && Number(d.amount_per_period) === 0
        ? 'no fixed installment'
        : `usually ${peso(Number(d.amount_per_period))}`
      slip.trace.notes.push(`${d.label}: ${set === 0 ? 'skipped' : peso(set)} this payroll, as set for it (${usual}).`)
      if (settles && d.category === 'cash_advance' && set < Number(d.balance)) {
        slip.trace.warnings.push(
          `${d.label}: this payroll settles the separation but deducts only the ${peso(set)} set for it — ${peso(round2(Number(d.balance) - set))} is still owed. Clear the amount set for this payroll to take the whole balance, or collect the rest outside payroll.`,
        )
      }
    }
    for (const d of pausedOwed) {
      slip.trace.warnings.push(
        `${d.label}: ₱${Number(d.balance).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is still owed, but its deductions are paused, so this payroll doesn't collect it. Resume it under Cash Advances to collect it here, or collect it outside payroll.`,
      )
    }

    results.push({ employee: emp, slip })
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
    employee_payroll_seq: e.payroll_seq,
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
    philhealth_ng: slip.philhealthNg,
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

  const { data: done, error: updErr } = await supabase
    .from('payroll_runs')
    .update({ totals })
    .eq('id', run.id)
    .eq('totals->>computing', token)
    .select('id')
  if (updErr) throw updErr
  if (!done || done.length === 0) {
    throw new Error('Attendance, adjustments or settings changed while this payroll was being computed. Compute it again.')
  }

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
