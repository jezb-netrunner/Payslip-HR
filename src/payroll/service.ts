// Orchestrates a payroll run: pulls everything the engine needs from
// Supabase for one client, computes every employee's payslip, and stores
// the drafts. RLS limits all of this to admins of the run's client.

import { getEntity, getHolidaysBetween, getMinimumWages, getPayCodes, getPayrollRules, getStatutoryTables } from '../lib/api'
import { fetchAll } from '../lib/fetchAll'
import { fmtDate } from '../lib/format'
import { addDays } from '../lib/manila'
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
  PayslipLine,
  RecurringDeduction,
} from '../lib/db'
import type { AnnualPayslipFact } from './annual'
import { priorFromTaxYear } from './alphalist'
import { computeAttendance } from './attendance'
import { computePayslip, MATERNITY_LEAVE_CODE, sssCompensation, type ContributionSet } from './engine'
import { round2 } from './types'
import { dailyRateOf, minimumWageOn, mweStatusOf, retestMweFact, type MinimumWageRow } from './minimumWage'
import { philhealthWaiverFor, philhealthWaiverWarnings, type PhilhealthWaiverRecord } from './philhealthWaiver'
import type { RemittanceSlip } from './remittance'
import { withholdingFactOf, type PriorWithholding } from './withholding'
import type {
  BirBucket,
  DeMinimisItem,
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
  | 'employee_snapshot'
  | 'earnings'
  | 'basic_pay'
  | 'gross_pay'
  | 'taxable_income'
  | 'taxable_regular'
  | 'taxable_supplementary'
  | 'wht_method'
  | 'sss_ee'
  | 'sss_mpf_ee'
  | 'philhealth_ee'
  | 'pagibig_ee'
  | 'union_dues'
  | 'withholding_tax'
  | 'tax_paid_by_employer'
  | 'net_pay'
  | 'period_end'
> & { payroll_runs?: { annualize?: boolean } | null }

const YEAR_PAYSLIP_COLUMNS =
  'employee_id, payroll_run_id, run_type, period_month, period_end, pay_date, is_minimum_wage_earner, employee_snapshot, earnings, basic_pay, gross_pay, taxable_income, taxable_regular, taxable_supplementary, wht_method, sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, union_dues, withholding_tax, tax_paid_by_employer, net_pay, payroll_runs!inner(status, annualize)'

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
 * The tax figures of one client's finalized payslips paid from `from`
 * through `through`, for the 1601-C schedule (spec T8).
 */
export async function fetchRemittanceSlips(entityId: string, from: string, through: string): Promise<RemittanceSlip[]> {
  return fetchAll<RemittanceSlip>((f, t) =>
    supabase
      .from('payslips')
      .select('pay_date, withholding_tax, tax_paid_by_employer, payroll_runs!inner(status)')
      .eq('entity_id', entityId)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('pay_date', from)
      .lte('pay_date', through)
      .order('id')
      .range(f, t),
  )
}

export function toAnnualFact(p: YearPayslip): AnnualPayslipFact {
  return {
    payMonth: p.pay_date ? `${p.pay_date.slice(0, 7)}-01` : (p.period_month ?? ''),
    isMwe: p.is_minimum_wage_earner,
    earnings: p.earnings.map((l) => ({ amount: Number(l.amount), bir: l.bir, taxable: l.taxable, incomeClass: l.incomeClass, ...(l.fbt ? { fbt: true } : {}) })),
    contributionsEe: Number(p.sss_ee) + Number(p.sss_mpf_ee) + Number(p.philhealth_ee) + Number(p.pagibig_ee),
    unionDues: Number(p.union_dues),
    withholdingTax: Number(p.withholding_tax),
    taxPaidByEmployer: Number(p.tax_paid_by_employer ?? 0),
  }
}

/**
 * A finalized payslip's year fact with its MWE status re-tested against the
 * minimum wage on file for its period's last day (spec T12): a past-dated
 * wage order changes the status of payslips already closed, and the
 * year-end adjustment corrects the year. Without a rate on file for that
 * day, or for a 13th month payslip, the fact stays as computed.
 */
export function retestedFact(
  p: YearPayslip,
  ctx: { rows: readonly MinimumWageRow[]; region: string; sector: string; factor: number; hazardExempt: boolean },
): { fact: AnnualPayslipFact; changed: boolean } {
  const fact = toAnnualFact(p)
  const snap = (p.employee_snapshot ?? {}) as { pay_type?: string; daily_rate?: number | string; monthly_rate?: number | string }
  const smw = p.run_type === 'thirteenth_month' || !p.period_end ? null : minimumWageOn(ctx.rows, ctx.region, ctx.sector, p.period_end)
  if (!smw || !snap.pay_type) return { fact, changed: false }
  const daily = dailyRateOf({ pay_type: snap.pay_type, daily_rate: snap.daily_rate ?? 0, monthly_rate: snap.monthly_rate ?? 0 }, ctx.factor)
  const out = retestMweFact(fact, mweStatusOf(daily, Number(smw.daily_rate)).isMwe, ctx.hazardExempt)
  return { fact: out, changed: out !== fact }
}

/** Previous employers this tax year, as the withholding method needs them (spec T2, trigger c). */
function priorWithholdingOf(t: EmployeeTaxYear | undefined): PriorWithholding | null {
  if (!t || !t.has_previous_employer) return null
  const p = priorFromTaxYear(t)
  return {
    taxable: round2(p.taxableBasic + p.taxable13thOtherBenefits + p.taxableOther),
    withheld: p.taxWithheld,
    employedFrom: t.prev_employment_from,
    employedTo: t.prev_employment_to,
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

/** An employee's PhilHealth NG share record (spec T6). */
function waiverOf(e: Employee): PhilhealthWaiverRecord {
  return {
    kind: e.philhealth_ee_waiver ?? null,
    startMonth: e.philhealth_waiver_start_month ?? null,
    spicExpiry: e.philhealth_spic_expiry ?? null,
    pwdStatus: e.philhealth_pwd_status ?? null,
  }
}

/** Final pay released after the employee's last day: nothing worked to pay. */
function extrasOnly(e: Employee, run: PayrollRun): boolean {
  return run.run_type === 'final_pay' && !!e.separation_date && e.separation_date < run.period_start
}

/** Days before the period read for the workday before an early regular holiday. */
const HOLIDAY_LOOKBACK_DAYS = 10

const CONTRIBUTION_COLUMNS =
  'sss_ee, sss_mpf_ee, philhealth_ee, pagibig_ee, sss_er, sss_mpf_er, sss_ec_er, philhealth_er, pagibig_er'

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
    ? { ...periodTables, bir_wht: payTables.bir_wht, bir_annual: payTables.bir_annual, de_minimis: payTables.de_minimis, de_minimis_from: payTables.de_minimis_from }
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
  const looksBack = holidays.some((h) => h.kind === 'regular' && h.holiday_date >= run.period_start)
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
        compensation: sssCompensation((sepSlips as unknown as MonthSlip[]).flatMap((p) => p.earnings ?? [])),
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
  // Everything PAID in the tax year: the withholding method (R, S and tax
  // of the year so far, and previous employers), annualization (the run's
  // flag, or the employee separating within the period — the last pay of a
  // separated employee settles their tax), and the exemption cap for the
  // 13th month and other benefits, which is per TAX year (a 13th month paid
  // after the year was annualized re-annualizes).
  const annualizes = (e: Employee) => !isThirteenth && (run.annualize || separatedBy(e, run))
  const isBenefit = (bucket: string) => bucket === 'thirteenth' || bucket === 'other_benefits'
  // maternity salary differentials paid in the last year: one paid earlier
  // in a leave covers the leave (spec T4)
  const onMaternity = leaves.some((l) => l.leave_types?.code === MATERNITY_LEAVE_CODE)
  const [yearSlips, taxSlips, taxYears, monthSlips, payCodes, rules, differentialSlips, wageRows] = await Promise.all([
    isThirteenth ? fetchFinalizedPayslipsForYear(entity.id, payrollYear) : Promise.resolve([] as YearPayslip[]),
    fetchFinalizedPayslipsForTaxYear(entity.id, taxYear),
    fetchTaxYears(entity.id, taxYear),
    // the payroll month's finalized payslips: contributions already
    // deducted (completing months around hires and separations) and the
    // SSS compensation they paid (13th month payslips included: whether
    // their pay is in the SSS base is a setting)
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
    getPayCodes(),
    getPayrollRules(),
    onMaternity
      ? fetchAll<Pick<Payslip, 'employee_id' | 'pay_date' | 'earnings'>>((from, to) =>
          supabase
            .from('payslips')
            .select('employee_id, pay_date, earnings, payroll_runs!inner(status)')
            .eq('entity_id', entity.id)
            .neq('payroll_run_id', run.id)
            .in('payroll_runs.status', ['finalized', 'paid'])
            .gte('pay_date', addDays(run.period_start, -366))
            .order('id')
            .range(from, to),
        )
      : Promise.resolve([] as Pick<Payslip, 'employee_id' | 'pay_date' | 'earnings'>[]),
    // the statutory minimum wages of the client's region (spec T12)
    getMinimumWages(entity.minimum_wage_region),
  ])

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
  // What each de minimis item already used in its ceiling's window — the
  // pay month, half-year or year of this payroll's pay date (spec T7)
  const units = new Map((tables.de_minimis?.items ?? []).map((c) => [c.item, c.unit]))
  const itemOf = new Map(payCodes.filter((c) => c.de_minimis_item).map((c) => [c.code, c.de_minimis_item as DeMinimisItem]))
  const half = (d: string) => `${d.slice(0, 4)}-${d.slice(5, 7) <= '06' ? 1 : 2}`
  const deMinimisUsedIn = (slips: YearPayslip[]) => {
    const used: Partial<Record<DeMinimisItem, number>> = {}
    for (const p of slips) {
      const paid = p.pay_date ?? ''
      // only pay under the same ceilings counts (and only what was paid by now)
      if (paid > run.pay_date || paid < (tables.de_minimis_from ?? '')) continue
      for (const l of p.earnings) {
        const item = l.payCode ? itemOf.get(l.payCode) : undefined
        if (!item || l.bir !== 'de_minimis') continue
        const unit = units.get(item)
        const same =
          unit === 'per_month' ? paid.slice(0, 7) === run.pay_date.slice(0, 7)
            : unit === 'per_semester' ? half(paid) === half(run.pay_date)
              : unit === 'per_year' || unit === 'days_per_year' ? paid.slice(0, 4) === run.pay_date.slice(0, 4)
                : false // the meal allowance's ceiling is per payroll
        if (same) used[item] = round2((used[item] ?? 0) + Number(unit === 'days_per_year' ? (l.days ?? 0) : l.amount))
      }
    }
    return used
  }
  // a differential line: its pay code, or (before pay codes) the one adjustment counted toward the 13th month
  const isDifferential = (l: PayslipLine) => l.payCode === 'MAT_DIFFERENTIAL' || (!l.payCode && l.code === 'adjustment' && !!l.thirteenthBasis)
  const differentialBy = groupBy(differentialSlips.filter((p) => (p.earnings ?? []).some(isDifferential)))
  // the client's DOLE exemption from the differential covers the payroll year (RA 11210 Sec. 5(c))
  const differentialExempt = !!entity.maternity_exemption_category && entity.maternity_exemption_year === payrollYear

  // The statutory minimum wage in force on the period's last day (spec T12):
  // the table kept by company admins, else the client's own setting (said
  // on the payslips it decides). An employee paid at or below it is a
  // minimum wage earner for this payroll.
  const region = entity.minimum_wage_region ?? ''
  const sector = entity.minimum_wage_sector ?? ''
  const smwRow = minimumWageOn(wageRows, region, sector, run.period_end)
  const smwDaily = smwRow ? Number(smwRow.daily_rate) : Number(entity.minimum_wage_daily) || null
  const smwSource = smwRow ? `${region}, ${smwRow.wage_order_ref}` : "the client's own setting"
  const smwWarning = smwRow
    ? null
    : !region
      ? "The client's wage region is not set, so the minimum wage comes from the client's own setting. Set the region in Client Settings."
      : `No minimum wage on file for ${region} on ${fmtDate(run.period_end)}: using the client's own setting ${smwDaily ? `₱${smwDaily.toFixed(2)}` : '(none)'}. A company admin adds the wage order under Statutory Tables → Minimum wages.`

  const results: { employee: Employee; slip: PayslipComputation; isMwe: boolean }[] = []

  for (const emp of employees) {
    const engineSettings: PayrollSettingsInput = {
      standardHoursPerDay: Number(entity.standard_hours_per_day),
      workingDaysDivisor: Number(emp.days_per_year ?? entity.working_days_divisor),
      gracePeriodMinutes: entity.grace_period_minutes,
      nightDiffRate: Number(entity.night_diff_rate),
      contributionTiming: entity.contribution_deduction_timing,
      payFrequency: run.pay_frequency ?? emp.pay_frequency,
      minimumWageDaily: smwDaily ?? 0,
      minimumWageSource: smwSource,
      holidayPayAfterAbsence: entity.holiday_pay_after_absence ?? 'apply_rule',
    }
    const mwe = mweStatusOf(dailyRateOf(emp, engineSettings.workingDaysDivisor), smwDaily)
    const hazardExempt = !!emp.hazard_criteria_met && !!emp.hazard_dole_cert_ref?.trim()

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
    const empMonthAll = monthBy.get(emp.id) ?? []
    // the month's regular payrolls (a 13th month run deducts no contributions)
    const empMonth = empMonthAll.filter((p) => p.run_type !== 'thirteenth_month')
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

    // the year's closed payslips, their MWE status re-tested (a past-dated wage order, spec T12)
    const retested = empTax.map((p) => retestedFact(p, { rows: wageRows, region, sector, factor: engineSettings.workingDaysDivisor, hazardExempt }))

    const slip = computePayslip({
      employee: {
        id: emp.id,
        name: `${emp.first_name} ${emp.last_name}`,
        payType: emp.pay_type,
        monthlyRate: Number(emp.monthly_rate),
        dailyRate: Number(emp.daily_rate),
        isMinimumWageEarner: mwe.isMwe,
        hazardExempt,
        apprentice: emp.employment_status === 'apprentice',
        managerial: emp.job_level === 'managerial_supervisory',
        // the NG share by payroll month (contributions follow the payroll month)
        philhealthEeWaiver: philhealthWaiverFor(waiverOf(emp), run.period_month),
        schedule: emp.work_schedule,
        hireDate: emp.hire_date,
        separationDate: emp.separation_date,
        allowances: (allowancesBy.get(emp.id) ?? []).map((a) => ({
          label: a.label,
          amount: Number(a.amount),
          category: a.category,
          basis: a.basis,
          payCode: a.pay_code ?? undefined,
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
            payCode: a.pay_code ?? undefined,
            ...(a.days ? { days: Number(a.days) } : {}),
          })),
      },
      settings: engineSettings,
      payCodes,
      rules,
      maternityDifferentialExempt: differentialExempt,
      maternityDifferentialPaid: (differentialBy.get(emp.id) ?? []).map((p) => p.pay_date ?? ''),
      leavePolicy: entity.leave_policy,
      deMinimisUsed: deMinimisUsedIn(empTax),
      // hired this tax year: had they another employer earlier in it? (their 2316)
      newHireWithoutTaxYear:
        !taxYearRow && emp.hire_date > `${taxYear}-01-01` && emp.hire_date <= run.period_end
          ? { hireDate: emp.hire_date, year: taxYear }
          : undefined,
      withholding: {
        payDate: run.pay_date,
        ytd: empTax.map((p) => withholdingFactOf({ ...p, pay_date: p.pay_date ?? run.pay_date, run_type: p.run_type ?? 'regular' })),
        prior: priorWithholdingOf(taxYearRow),
      },
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
              ytd: retested.map((r) => r.fact),
              prior,
              peraCredit,
            }
          : undefined,
      extrasOnly: extrasOnly(emp, run),
      daysBefore,
      separationMonth: separationMonth.get(emp.id),
      monthContributions: isThirteenth
        ? undefined
        : {
            already: sumContributions(empMonth),
            compensationAlready: sssCompensation(empMonthAll.flatMap((p) => p.earnings ?? [])),
            // the month's last slot, a separation, or a payroll for earlier
            // days computed after the month's closing payroll was final
            closes:
              run.period_index >= run.periods_in_month ||
              separatedBy(emp, run) ||
              empMonth.some((p) => (p.payroll_runs?.period_index ?? 0) >= (p.payroll_runs?.periods_in_month ?? Infinity)),
            opens: empMonth.length === 0,
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
    })
    slip.trace.warnings.unshift(...(slipWarnings.get(emp.id) ?? []))
    if (!isThirteenth) slip.trace.warnings.push(...philhealthWaiverWarnings(waiverOf(emp), run.period_month, run.period_end))
    // 13th month pay in the SSS base (a setting, spec P2) is settled by the
    // month's last regular payroll: one already final has to be recomputed
    const closedMonth = empMonth.some((p) => (p.payroll_runs?.period_index ?? 0) >= (p.payroll_runs?.periods_in_month ?? Infinity))
    if (isThirteenth && closedMonth && sssCompensation(slip.earnings) > 0) {
      const month = new Date(`${run.period_month}T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
      slip.trace.warnings.push(
        `${month}'s last payroll is already final, so its SSS doesn't include this 13th month pay (in the SSS base by the pay code setting). Reopen and recompute it.`,
      )
    }
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

    if (slip.whtMethod === 'annualized') {
      const flipped = retested.filter((r) => r.changed)
      for (const toMwe of [true, false]) {
        const n = flipped.filter((r) => r.fact.isMwe === toMwe).length
        if (n > 0) {
          slip.trace.notes.push(
            `The year-end adjustment treats ${n} earlier payslip${n === 1 ? '' : 's'} of the year as ${toMwe ? 'minimum wage pay' : 'pay above the minimum wage'} under the minimum wage now on file for their periods (the finalized payrolls themselves are not changed).`,
          )
        }
      }
    }
    // the status depends on the client's own setting: say so
    if (smwWarning && (mwe.isMwe || mwe.below)) slip.trace.warnings.push(smwWarning)

    results.push({ employee: emp, slip, isMwe: mwe.isMwe })
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

  const rows = results.map(({ employee: e, slip, isMwe }) => ({
    payroll_run_id: run.id,
    employee_id: e.id,
    employee_payroll_seq: e.payroll_seq,
    payment_method: e.payment_method,
    // computed for this payroll from the minimum wage (spec T12)
    is_minimum_wage_earner: isMwe,
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
    taxable_regular: slip.taxableRegular,
    taxable_supplementary: slip.taxableSupplementary,
    wht_method: slip.whtMethod,
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
    tax_paid_by_employer: slip.taxPaidByEmployer,
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
    tax_paid_by_employer: sum((r) => r.tax_paid_by_employer),
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
