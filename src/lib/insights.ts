// Management reports from the app's own payroll and HR records, for the
// owner's decisions rather than for BIR: what labor costs and why it moved,
// overtime, attendance, headcount and turnover, leave and the SIL cash it
// will cost, cash advances and loans. Pure: insightsData.ts loads the rows.
//
// Pay figures come from FINALIZED payslips only (what was actually paid),
// grouped by payroll month (the cutoff's month, like the 13th month and the
// contributions). Every report returns the same model — KPIs, plain-language
// insights, chart series and the tables behind them — so the page, the CSV
// and the PDF all show the same numbers.

import type { Employee, LeaveType, PayslipLine } from './db'
import { fmtDate, fmtHours, fmtNum, fullName, money, plural } from './format'
import { EMPLOYMENT_STATUS_LABELS, SEPARATION_REASON_LABELS } from './labels'
import { addDays, addMonths, endOfMonth, isoWeekday } from './manila'
import { round2, type RunType } from '../payroll/types'

// ---------- the report model ----------

export type CellKind = 'text' | 'money' | 'number' | 'hours' | 'minutes' | 'days' | 'percent' | 'date'
export interface Column {
  key: string
  label: string
  kind: CellKind
}
export type Row = Record<string, string | number | null>
export interface Table {
  title: string
  columns: Column[]
  rows: Row[]
  total?: Row
  /** shown when there are no rows */
  empty?: string
}
export interface Kpi {
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
}
export type ChartUnit = 'money' | 'hours' | 'percent' | 'count' | 'days'
export interface Chart {
  title: string
  /** columns: categories along the x axis (months, weekdays); bars: horizontal, ranked */
  kind: 'columns' | 'bars'
  categories: string[]
  series: { key: string; label: string; values: number[] }[]
  stacked?: boolean
  unit: ChartUnit
}
export interface Insight {
  tone: 'info' | 'good' | 'warn'
  text: string
}
export interface Report {
  kpis: Kpi[]
  insights: Insight[]
  charts: Chart[]
  tables: Table[]
}

/** A table cell as shown on screen and in the PDF. */
export function cellText(v: string | number | null | undefined, kind: CellKind): string {
  if (v === null || v === undefined || v === '') return kind === 'text' ? '' : '—'
  if (typeof v === 'string') return kind === 'date' ? fmtDate(v) : v
  switch (kind) {
    case 'money':
      return money(v)
    case 'percent':
      return pct(v)
    case 'minutes':
      return v ? fmtHours(v) : '0m'
    case 'hours':
      return `${fmtNum(v)} h`
    default:
      return fmtNum(v)
  }
}

/** A table cell in the CSV: plain numbers (percent as 12.5), ISO dates. */
export function cellCsv(v: string | number | null | undefined, kind: CellKind): string | number {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' && kind === 'percent') return Math.round(v * 10000) / 100
  return v
}

/** The CSV rows of a whole report: each table under its title. */
export function reportCsv(title: string, period: string, report: Report): (string | number)[][] {
  const out: (string | number)[][] = [[title], [period], []]
  for (const t of report.tables) {
    out.push([t.title])
    out.push(t.columns.map((c) => (c.kind === 'percent' ? `${c.label} (%)` : c.kind === 'minutes' ? `${c.label} (min)` : c.label)))
    for (const r of [...t.rows, ...(t.total ? [t.total] : [])]) out.push(t.columns.map((c) => cellCsv(r[c.key], c.kind)))
    out.push([])
  }
  return out
}

// ---------- periods ----------

/** Whole payroll months, 'YYYY-MM', inclusive. */
export interface MonthRange {
  from: string
  to: string
}

export const PRESETS = {
  this_month: 'This month',
  last_month: 'Last month',
  last_3: 'Last 3 months',
  last_6: 'Last 6 months',
  this_year: 'This year',
  last_year: 'Last year',
  last_12: 'Last 12 months',
} as const
export type PresetKey = keyof typeof PRESETS

const shiftMonth = (m: string, n: number) => addMonths(`${m}-01`, n).slice(0, 7)

export function presetRange(key: PresetKey, today: string): MonthRange {
  const m = today.slice(0, 7)
  const y = m.slice(0, 4)
  switch (key) {
    case 'this_month':
      return { from: m, to: m }
    case 'last_month':
      return { from: shiftMonth(m, -1), to: shiftMonth(m, -1) }
    case 'last_3':
      return { from: shiftMonth(m, -2), to: m }
    case 'last_6':
      return { from: shiftMonth(m, -5), to: m }
    case 'this_year':
      return { from: `${y}-01`, to: m }
    case 'last_year':
      return { from: `${Number(y) - 1}-01`, to: `${Number(y) - 1}-12` }
    case 'last_12':
      return { from: shiftMonth(m, -11), to: m }
  }
}

export function monthsIn(r: MonthRange): string[] {
  const out: string[] = []
  for (let m = r.from; m <= r.to && out.length < 240; m = shiftMonth(m, 1)) out.push(m)
  return out
}
export const rangeStart = (r: MonthRange) => `${r.from}-01`
export const rangeEnd = (r: MonthRange) => endOfMonth(`${r.to}-01`)

/** "2026-10" -> "Oct 2026" */
export function monthShort(m: string): string {
  return new Date(`${m.slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' })
}
export function rangeLabel(r: MonthRange): string {
  return r.from === r.to ? monthShort(r.from) : `${monthShort(r.from)} – ${monthShort(r.to)}`
}

// ---------- facts ----------

/** Who a figure belongs to, as of the payslip (department and position when paid). */
export interface Who {
  employeeId: string
  name: string
  employeeNo: string
  department: string
  position: string
  payType: 'monthly' | 'daily'
}

/** A finalized payslip as the reports load it. */
export interface SlipRow {
  employee_id: string
  run_type: RunType
  period_month: string
  period_start: string | null
  period_end: string | null
  employee_snapshot: Record<string, unknown> | null
  earnings: PayslipLine[] | null
  deductions: PayslipLine[] | null
  gross_pay: number
  net_pay: number
  withholding_tax: number
  sss_ee: number
  sss_mpf_ee: number
  philhealth_ee: number
  pagibig_ee: number
  sss_er: number
  sss_mpf_er: number
  sss_ec_er: number
  philhealth_er: number
  pagibig_er: number
  overtime_hours: number
  night_diff_hours: number
  late_minutes: number
  undertime_minutes: number
  absent_days: number
  days_worked: number
  hours_worked: number
}

/** One payslip reduced to the figures the reports use. */
export interface SlipFact extends Who {
  month: string
  runType: RunType
  periodEnd: string | null
  /** earned basic: basic pay less absences, tardiness and undertime, plus hours past a short shift */
  basic: number
  overtime: number
  nightDiff: number
  /** holiday, rest-day and special-day premiums */
  premiums: number
  allowances: number
  thirteenth: number
  /** one-time adjustments and anything else */
  other: number
  gross: number
  /** employer SSS (with MPF and EC), PhilHealth and Pag-IBIG */
  er: number
  ee: number
  tax: number
  net: number
  absenceDeduction: number
  tardinessDeduction: number
  advanceDeducted: number
  loanDeducted: number
  otHours: number
  ndHours: number
  lateMinutes: number
  undertimeMinutes: number
  absentDays: number
  daysWorked: number
  hoursWorked: number
}

const n = (v: unknown) => Number(v) || 0
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

export function whoOf(employeeId: string, snap: Record<string, unknown> | null | undefined): Who {
  const s = snap ?? {}
  return {
    employeeId,
    name: str(s.name) || 'Unnamed employee',
    employeeNo: str(s.employee_no),
    department: str(s.department).trim(),
    position: str(s.position).trim(),
    payType: s.pay_type === 'daily' ? 'daily' : 'monthly',
  }
}

const BASIC_CODES = new Set(['basic', 'absence', 'late', 'undertime', 'extra_hours'])
const PREMIUM_CODES = new Set(['restday', 'special', 'holiday'])
const LOAN_CODES = new Set(['other:sss_loan', 'other:pagibig_loan', 'other:company_loan'])

export function toSlipFact(r: SlipRow): SlipFact {
  let basic = 0
  let overtime = 0
  let nightDiff = 0
  let premiums = 0
  let allowances = 0
  let thirteenth = 0
  let other = 0
  let absenceDeduction = 0
  let tardinessDeduction = 0
  for (const l of r.earnings ?? []) {
    const a = n(l.amount)
    if (BASIC_CODES.has(l.code)) {
      basic += a
      if (l.code === 'absence') absenceDeduction -= a
      if (l.code === 'late' || l.code === 'undertime') tardinessDeduction -= a
    } else if (l.code === 'ot') overtime += a
    else if (l.code === 'nd') nightDiff += a
    else if (PREMIUM_CODES.has(l.code)) premiums += a
    else if (l.code === 'allowance') allowances += a
    else if (l.code === 'thirteenth') thirteenth += a
    else other += a
  }
  const gross = round2(n(r.gross_pay))
  // whatever the lines don't explain (none expected) stays visible as "other"
  other += round2(gross - (basic + overtime + nightDiff + premiums + allowances + thirteenth + other))
  let advanceDeducted = 0
  let loanDeducted = 0
  for (const l of r.deductions ?? []) {
    if (l.code === 'other:cash_advance') advanceDeducted += n(l.amount)
    else if (LOAN_CODES.has(l.code)) loanDeducted += n(l.amount)
  }
  return {
    ...whoOf(r.employee_id, r.employee_snapshot),
    month: r.period_month.slice(0, 7),
    runType: r.run_type,
    periodEnd: r.period_end,
    basic: round2(basic),
    overtime: round2(overtime),
    nightDiff: round2(nightDiff),
    premiums: round2(premiums),
    allowances: round2(allowances),
    thirteenth: round2(thirteenth),
    other: round2(other),
    gross,
    er: round2(n(r.sss_er) + n(r.sss_mpf_er) + n(r.sss_ec_er) + n(r.philhealth_er) + n(r.pagibig_er)),
    ee: round2(n(r.sss_ee) + n(r.sss_mpf_ee) + n(r.philhealth_ee) + n(r.pagibig_ee)),
    tax: round2(n(r.withholding_tax)),
    net: round2(n(r.net_pay)),
    absenceDeduction: round2(absenceDeduction),
    tardinessDeduction: round2(tardinessDeduction),
    advanceDeducted: round2(advanceDeducted),
    loanDeducted: round2(loanDeducted),
    otHours: n(r.overtime_hours),
    ndHours: n(r.night_diff_hours),
    lateMinutes: n(r.late_minutes),
    undertimeMinutes: n(r.undertime_minutes),
    absentDays: n(r.absent_days),
    daysWorked: n(r.days_worked),
    hoursWorked: n(r.hours_worked),
  }
}

/** One day of a finalized payslip's attendance (payroll's own day computation). */
export interface DayFact extends Who {
  date: string
  /** an ordinary scheduled workday: the days attendance is measured on (not rest days or holidays) */
  expected: boolean
  worked: boolean
  absent: boolean
  onLeave: boolean
  lateMinutes: number
  undertimeMinutes: number
}

export function toDayFacts(who: Who, days: unknown): DayFact[] {
  if (!Array.isArray(days)) return []
  const out: DayFact[] = []
  for (const raw of days) {
    const d = raw as Record<string, unknown>
    if (typeof d?.date !== 'string') continue
    const expected = d.scheduled === true && d.dayType === 'regular'
    out.push({
      ...who,
      date: d.date,
      expected,
      worked: n(d.workedMinutes) > 0,
      absent: d.absent === true,
      onLeave: expected && (d.onPaidLeave === true || d.onUnpaidLeave === true),
      lateMinutes: n(d.lateMinutes),
      undertimeMinutes: n(d.undertimeMinutes),
    })
  }
  return out
}

/** A date counts once even if two payslips carry it (an off-cycle run over the same days). */
export function uniqueDays(days: DayFact[], range: MonthRange): DayFact[] {
  const from = rangeStart(range)
  const to = rangeEnd(range)
  const seen = new Set<string>()
  return days.filter((d) => {
    const k = `${d.employeeId}|${d.date}`
    if (d.date < from || d.date > to || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------- grouping ----------

export type GroupBy = 'month' | 'department' | 'position' | 'employee' | 'pay_type' | 'run_type' | 'weekday' | 'leave_type'

export const GROUP_LABELS: Record<GroupBy, string> = {
  month: 'Month',
  department: 'Department',
  position: 'Position',
  employee: 'Employee',
  pay_type: 'Pay type',
  run_type: 'Payroll type',
  weekday: 'Weekday',
  leave_type: 'Leave type',
}

const RUN_TYPE_LABELS: Record<RunType, string> = {
  regular: 'Regular payroll',
  special: 'Special payroll',
  final_pay: 'Final pay',
  thirteenth_month: '13th month',
}
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const WEEKDAY_NAMES = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays']

export const noDepartment = (d: string) => d || 'No department'

/** [sort key, label] of a fact in a grouping */
function keyOf(f: Who & { month?: string; date?: string; runType?: RunType }, by: GroupBy): [string, string] {
  switch (by) {
    case 'month': {
      const m = f.month ?? f.date?.slice(0, 7) ?? ''
      return [m, monthShort(m)]
    }
    case 'department':
      return [noDepartment(f.department), noDepartment(f.department)]
    case 'position':
      return [f.position || 'No position', f.position || 'No position']
    case 'employee':
      return [f.employeeId, f.name]
    case 'pay_type':
      return [f.payType, f.payType === 'daily' ? 'Daily-paid' : 'Monthly-paid']
    case 'run_type':
      return [f.runType ?? '', RUN_TYPE_LABELS[f.runType ?? 'regular']]
    case 'weekday': {
      const w = f.date ? isoWeekday(f.date) : 1
      return [String(w), WEEKDAYS[w - 1]]
    }
    default:
      return ['', '']
  }
}

interface Grouped<A> {
  key: string
  label: string
  agg: A
}
function group<F, A>(facts: F[], key: (f: F) => [string, string], init: () => A, add: (a: A, f: F) => void): Grouped<A>[] {
  const map = new Map<string, Grouped<A>>()
  for (const f of facts) {
    const [k, label] = key(f)
    let g = map.get(k)
    if (!g) {
      g = { key: k, label, agg: init() }
      map.set(k, g)
    }
    add(g.agg, f)
  }
  return [...map.values()]
}

/** months and weekdays in their order; everything else by the given measure, largest first */
function ordered<A>(rows: Grouped<A>[], by: GroupBy, measure: (a: A) => number): Grouped<A>[] {
  if (by === 'month' || by === 'weekday') return rows.sort((a, b) => a.key.localeCompare(b.key))
  return rows.sort((a, b) => measure(b.agg) - measure(a.agg) || a.label.localeCompare(b.label))
}

// ---------- wording ----------

export function pct(x: number): string {
  if (!Number.isFinite(x)) return '—'
  const p = x * 100
  return `${Math.abs(p) < 10 && p !== 0 ? p.toFixed(1) : Math.round(p)}%`
}
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0)

/** "Ana, Ben and Carla"; "Ana, Ben, Carla and 4 more" */
export function names(list: string[], max = 3): string {
  if (list.length <= max) return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `${list.slice(0, max).join(', ')} and ${list.length - max} more`
}

const sum = <T>(xs: T[], f: (x: T) => number) => round2(xs.reduce((s, x) => s + f(x), 0))

function inMonths(facts: SlipFact[], range: MonthRange) {
  return facts.filter((f) => f.month >= range.from && f.month <= range.to)
}

const NO_PAY_YET: Insight = { tone: 'info', text: 'No finalized payroll in this period yet — the report fills in as payrolls are finalized.' }

// ---------- payroll cost ----------

interface CostAgg {
  employees: Set<string>
  /** employee|month pairs paid: the denominator of the monthly cost per employee */
  heads: Set<string>
  basic: number
  overtime: number
  premiums: number
  allowances: number
  thirteenth: number
  gross: number
  er: number
  net: number
}
const costAgg = (): CostAgg => ({
  employees: new Set(),
  heads: new Set(),
  basic: 0,
  overtime: 0,
  premiums: 0,
  allowances: 0,
  thirteenth: 0,
  gross: 0,
  er: 0,
  net: 0,
})
function addCost(a: CostAgg, f: SlipFact) {
  a.employees.add(f.employeeId)
  a.heads.add(`${f.employeeId}|${f.month}`)
  a.basic += f.basic
  a.overtime += f.overtime + f.nightDiff
  a.premiums += f.premiums
  a.allowances += f.allowances + f.other
  a.thirteenth += f.thirteenth
  a.gross += f.gross
  a.er += f.er
  a.net += f.net
}
const costOf = (a: CostAgg) => round2(a.gross + a.er)

/** The stacked parts of employer cost, in the chart's fixed order (they add up to it). */
const COST_PARTS: { key: string; label: string; of: (a: CostAgg) => number }[] = [
  { key: 'basic', label: 'Basic pay', of: (a) => a.basic },
  { key: 'ot', label: 'Overtime & premiums', of: (a) => a.overtime + a.premiums },
  { key: 'allowances', label: 'Allowances & other pay', of: (a) => a.allowances },
  { key: 'thirteenth', label: '13th month', of: (a) => a.thirteenth },
  { key: 'er', label: 'Employer contributions', of: (a) => a.er },
]

function costRow(label: string, a: CostAgg): Row {
  return {
    label,
    employees: a.employees.size,
    basic: round2(a.basic),
    ot: round2(a.overtime + a.premiums),
    allowances: round2(a.allowances),
    thirteenth: round2(a.thirteenth),
    gross: round2(a.gross),
    er: round2(a.er),
    cost: costOf(a),
    perHead: a.heads.size ? round2(costOf(a) / a.heads.size) : 0,
  }
}

/** Payroll months before today's: the current one still has payrolls to come. */
const completeMonth = (m: string, today?: string) => !today || m < today.slice(0, 7)

export function costReport(all: SlipFact[], range: MonthRange, by: GroupBy, today?: string): Report {
  const facts = inMonths(all, range)
  const total = costAgg()
  facts.forEach((f) => addCost(total, f))
  const byMonth = new Map(group(facts, (f) => keyOf(f, 'month'), costAgg, addCost).map((g) => [g.key, g.agg]))
  const months = monthsIn(range)
  const rows = ordered(group(facts, (f) => keyOf(f, by), costAgg, addCost), by, costOf)
  const columns: Column[] = [
    { key: 'label', label: GROUP_LABELS[by], kind: 'text' },
    { key: 'employees', label: 'Employees', kind: 'number' },
    { key: 'basic', label: 'Basic pay', kind: 'money' },
    { key: 'ot', label: 'OT & premiums', kind: 'money' },
    { key: 'allowances', label: 'Allowances & other', kind: 'money' },
    { key: 'thirteenth', label: '13th month', kind: 'money' },
    { key: 'gross', label: 'Gross pay', kind: 'money' },
    { key: 'er', label: 'Employer share', kind: 'money' },
    { key: 'cost', label: 'Employer cost', kind: 'money' },
    { key: 'perHead', label: 'Per employee a month', kind: 'money' },
  ]
  const charts: Chart[] = []
  if (facts.length) {
    charts.push({
      title: 'Employer cost by payroll month',
      kind: 'columns',
      categories: months.map(monthShort),
      series: COST_PARTS.map((p) => ({ key: p.key, label: p.label, values: months.map((m) => round2(byMonth.has(m) ? p.of(byMonth.get(m)!) : 0)) })),
      stacked: true,
      unit: 'money',
    })
    if (by !== 'month' && rows.length > 1) {
      const top = rows.slice(0, 12)
      charts.push({
        title: `Employer cost by ${GROUP_LABELS[by].toLowerCase()}${rows.length > top.length ? ` (top ${top.length})` : ''}`,
        kind: 'bars',
        categories: top.map((r) => r.label),
        series: [{ key: 'cost', label: 'Employer cost', values: top.map((r) => costOf(r.agg)) }],
        unit: 'money',
      })
    }
  }

  const cost = costOf(total)
  const perHead = total.heads.size ? cost / total.heads.size : 0
  const kpis: Kpi[] = [
    { label: 'Employer cost', value: money(cost), sub: 'gross pay + employer contributions' },
    { label: 'Gross pay', value: money(total.gross), sub: `net pay ${money(total.net)}` },
    { label: 'Employer contributions', value: money(total.er), sub: total.gross ? `${pct(ratio(total.er, total.gross))} on top of gross pay` : undefined },
    { label: 'Cost per employee a month', value: money(perHead), sub: plural(total.employees.size, 'employee') + ' paid' },
  ]

  const insights: Insight[] = []
  if (!facts.length) insights.push(NO_PAY_YET)
  else {
    // the latest complete month against the one before it, and what moved it
    const paid = months.filter((m) => byMonth.has(m) && completeMonth(m, today))
    const partial = months.find((m) => byMonth.has(m) && !completeMonth(m, today))
    const last = paid[paid.length - 1]
    const prev = last ? shiftMonth(last, -1) : ''
    if (partial) {
      insights.push({ tone: 'info', text: `${monthShort(partial)} so far: ${money(costOf(byMonth.get(partial)!))} — its remaining payrolls are still to come, so it isn't compared yet.` })
    }
    if (paid.length >= 2 && byMonth.has(prev)) {
      const a = byMonth.get(last)!
      const b = byMonth.get(prev)!
      const change = ratio(costOf(a) - costOf(b), costOf(b))
      const deltas = COST_PARTS.map((p) => ({ label: p.label, key: p.key, d: round2(p.of(a) - p.of(b)) })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
      const driver = deltas[0]
      insights.push({
        tone: 'info',
        text:
          Math.abs(change) < 0.03
            ? `${monthShort(last)} cost ${money(costOf(a))}, steady against ${monthShort(prev)} (within 3%).`
            : `${monthShort(last)} cost ${money(costOf(a))}, ${change > 0 ? 'up' : 'down'} ${pct(Math.abs(change))} from ${monthShort(prev)} — mostly ${driver.label.toLowerCase()} (${driver.d > 0 ? '+' : '−'}${money(Math.abs(driver.d))})${driver.key === 'thirteenth' ? ', which is seasonal' : ''}.`,
      })
    }
    const premiums = round2(total.overtime + total.premiums)
    const premiumShare = ratio(premiums, total.gross)
    if (premiums > 0) {
      insights.push(
        premiumShare >= 0.1
          ? {
              tone: 'warn',
              text: `Overtime, night differential and holiday/rest-day premiums were ${pct(premiumShare)} of gross pay (${money(premiums)}). Premium hours cost more than regular ones — see the Overtime report for who and when.`,
            }
          : { tone: 'info', text: `Overtime, night differential and holiday/rest-day premiums were ${pct(premiumShare)} of gross pay (${money(premiums)}).` },
      )
    }
    if (total.er > 0) {
      insights.push({ tone: 'info', text: `Employer SSS, PhilHealth and Pag-IBIG added ${money(total.er)} — ${pct(ratio(total.er, total.gross))} on top of gross pay.` })
    }
    const basicEarned = sum(facts.filter((f) => f.runType !== 'thirteenth_month'), (f) => f.basic)
    if (basicEarned > 0) {
      insights.push({
        tone: 'info',
        text: `13th month pay accrues at 1/12 of the basic pay earned (PD 851): about ${money(basicEarned / 12)} for this period${total.thirteenth > 0 ? `; ${money(total.thirteenth)} of 13th month was paid in it` : ''}.`,
      })
    }
    const depts = group(facts, (f) => keyOf(f, 'department'), costAgg, addCost).sort((a, b) => costOf(b.agg) - costOf(a.agg))
    if (depts.length >= 2 && total.heads.size) {
      const top = depts[0]
      const topPerHead = costOf(top.agg) / top.agg.heads.size
      insights.push({
        tone: 'info',
        text: `${top.label} takes ${pct(ratio(costOf(top.agg), cost))} of the cost with ${pct(ratio(top.agg.heads.size, total.heads.size))} of the headcount (${money(topPerHead)} per employee a month, against ${money(perHead)} overall).`,
      })
    }
  }

  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: `Payroll cost by ${GROUP_LABELS[by].toLowerCase()}`,
        columns,
        rows: rows.map((r) => costRow(r.label, r.agg)),
        total: facts.length ? costRow('Total', total) : undefined,
        empty: 'No finalized payslips in this period.',
      },
    ],
  }
}

// ---------- overtime ----------

interface OtAgg {
  otHours: number
  otPay: number
  ndHours: number
  ndPay: number
  premiums: number
  basic: number
  payrolls: number
  withOt: number
  employees: Set<string>
}
const otAgg = (): OtAgg => ({ otHours: 0, otPay: 0, ndHours: 0, ndPay: 0, premiums: 0, basic: 0, payrolls: 0, withOt: 0, employees: new Set() })
function addOt(a: OtAgg, f: SlipFact) {
  a.otHours += f.otHours
  a.otPay += f.overtime
  a.ndHours += f.ndHours
  a.ndPay += f.nightDiff
  a.premiums += f.premiums
  a.basic += f.basic
  a.payrolls += 1
  if (f.otHours > 0) {
    a.withOt += 1
    a.employees.add(f.employeeId)
  }
}

export interface WorkSettings {
  /** the client's standard hours a day */
  standardHours: number
  /** the client's working days a year (261, 313, 365…) */
  workingDaysPerYear: number
}

export function overtimeReport(all: SlipFact[], range: MonthRange, by: GroupBy, work: WorkSettings, today?: string): Report {
  const facts = inMonths(all, range).filter((f) => f.runType !== 'thirteenth_month')
  const total = otAgg()
  facts.forEach((f) => addOt(total, f))
  const rows = ordered(group(facts, (f) => keyOf(f, by), otAgg, addOt), by, (a) => a.otHours)
  const months = monthsIn(range)
  const byMonth = new Map(group(facts, (f) => keyOf(f, 'month'), otAgg, addOt).map((g) => [g.key, g.agg]))
  const people = group(facts, (f) => keyOf(f, 'employee'), otAgg, addOt).sort((a, b) => b.agg.otHours - a.agg.otHours)

  const row = (label: string, a: OtAgg): Row => ({
    label,
    otHours: round2(a.otHours),
    otPay: round2(a.otPay),
    ndHours: round2(a.ndHours),
    ndPay: round2(a.ndPay),
    premiums: round2(a.premiums),
    share: a.basic > 0 ? round2(a.otPay / a.basic) : 0,
    withOt: by === 'employee' ? `${a.withOt} of ${a.payrolls}` : a.withOt,
  })
  const charts: Chart[] = []
  if (total.otHours > 0) {
    if (by === 'month') {
      charts.push({
        title: 'Overtime hours by payroll month',
        kind: 'columns',
        categories: months.map(monthShort),
        series: [{ key: 'otHours', label: 'Overtime hours', values: months.map((m) => round2(byMonth.get(m)?.otHours ?? 0)) }],
        unit: 'hours',
      })
    } else {
      const top = rows.filter((r) => r.agg.otHours > 0).slice(0, 10)
      charts.push({
        title: `Overtime hours by ${GROUP_LABELS[by].toLowerCase()}${rows.length > top.length ? ` (top ${top.length})` : ''}`,
        kind: 'bars',
        categories: top.map((r) => r.label),
        series: [{ key: 'otHours', label: 'Overtime hours', values: top.map((r) => round2(r.agg.otHours)) }],
        unit: 'hours',
      })
    }
  }

  const monthHours = (work.standardHours || 8) * ((work.workingDaysPerYear || 261) / 12)
  const fte = ratio(total.otHours, monthHours * months.length)
  const kpis: Kpi[] = [
    { label: 'Overtime hours', value: fmtNum(round2(total.otHours)), sub: plural(total.employees.size, 'employee') + ' with overtime' },
    { label: 'Overtime pay', value: money(total.otPay), sub: total.basic ? `${pct(ratio(total.otPay, total.basic))} of basic pay` : undefined },
    { label: 'Night differential', value: money(total.ndPay), sub: `${fmtNum(round2(total.ndHours))} hours` },
    { label: 'Full-time equivalent', value: fmtNum(Math.round(fte * 10) / 10), sub: "employees' regular hours the overtime equals" },
  ]

  const insights: Insight[] = []
  if (!facts.length) insights.push(NO_PAY_YET)
  else if (total.otHours <= 0) insights.push({ tone: 'good', text: 'No overtime was paid in this period.' })
  else {
    const withOt = people.filter((p) => p.agg.otHours > 0)
    if (withOt.length >= 4) {
      const top3 = withOt.slice(0, 3)
      const share = ratio(sum(top3, (p) => p.agg.otHours), total.otHours)
      insights.push({
        tone: share >= 0.6 ? 'warn' : 'info',
        text: `${names(top3.map((p) => p.label))} worked ${pct(share)} of all overtime hours${share >= 0.6 ? ' — the load is concentrated; spreading it or cross-training others lowers the risk of fatigue and of a single point of failure' : ''}.`,
      })
    }
    const routine = people.filter((p) => p.agg.payrolls >= 3 && p.agg.withOt / p.agg.payrolls >= 0.75)
    if (routine.length) {
      insights.push({
        tone: 'warn',
        text: `Overtime is routine for ${plural(routine.length, 'employee')} (in at least 3 of every 4 of their payrolls): ${names(routine.map((p) => `${p.label} (${p.agg.withOt} of ${p.agg.payrolls})`))}. Routine overtime usually means the schedule or staffing is short.`,
      })
    }
    if (fte >= 0.5) {
      insights.push({
        tone: 'info',
        text: `The ${fmtNum(round2(total.otHours))} overtime hours equal about ${fmtNum(Math.round(fte * 10) / 10)} full-time employees' regular hours over the period. Overtime is paid at a premium (at least 25% more on an ordinary day, Labor Code Art. 87) — weigh it against the cost of another hire or a different schedule.`,
      })
    }
    const paid = months.filter((m) => byMonth.has(m) && completeMonth(m, today))
    if (paid.length >= 3) {
      const last = paid[paid.length - 1]
      const earlier = paid.slice(0, -1)
      const avg = sum(earlier, (m) => byMonth.get(m)!.otHours) / earlier.length
      const lastHours = byMonth.get(last)!.otHours
      if (avg > 0 && lastHours >= 10 && lastHours >= avg * 1.5) {
        insights.push({ tone: 'warn', text: `${monthShort(last)} overtime (${fmtNum(round2(lastHours))} hours) is ${fmtNum(Math.round((lastHours / avg) * 10) / 10)} times the average of the months before it.` })
      }
    }
  }

  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: `Overtime by ${GROUP_LABELS[by].toLowerCase()}`,
        columns: [
          { key: 'label', label: GROUP_LABELS[by], kind: 'text' },
          { key: 'otHours', label: 'Overtime hours', kind: 'number' },
          { key: 'otPay', label: 'Overtime pay', kind: 'money' },
          { key: 'ndHours', label: 'Night diff. hours', kind: 'number' },
          { key: 'ndPay', label: 'Night diff. pay', kind: 'money' },
          { key: 'premiums', label: 'Holiday & rest-day premiums', kind: 'money' },
          { key: 'share', label: 'Overtime pay / basic', kind: 'percent' },
          { key: 'withOt', label: 'Payrolls with overtime', kind: by === 'employee' ? 'text' : 'number' },
        ],
        rows: rows.map((r) => row(r.label, r.agg)),
        total: facts.length ? row('Total', total) : undefined,
        empty: 'No finalized payslips in this period.',
      },
    ],
  }
}

// ---------- attendance ----------

interface AttAgg {
  expected: number
  worked: number
  absent: number
  leave: number
  late: number
  lateMinutes: number
  undertime: number
  undertimeMinutes: number
}
const attAgg = (): AttAgg => ({ expected: 0, worked: 0, absent: 0, leave: 0, late: 0, lateMinutes: 0, undertime: 0, undertimeMinutes: 0 })
function addAtt(a: AttAgg, d: DayFact) {
  if (d.expected) a.expected += 1
  if (d.expected && d.worked) a.worked += 1
  if (d.absent) a.absent += 1
  if (d.onLeave) a.leave += 1
  if (d.lateMinutes > 0) {
    a.late += 1
    a.lateMinutes += d.lateMinutes
  }
  if (d.undertimeMinutes > 0) {
    a.undertime += 1
    a.undertimeMinutes += d.undertimeMinutes
  }
}

export function attendanceReport(
  allDays: DayFact[],
  allSlips: SlipFact[],
  range: MonthRange,
  by: GroupBy,
  /** hire and separation dates: payroll marks days outside the employment absent to prorate the pay — they aren't absences */
  employment?: Map<string, { hire: string; separation: string | null }>,
): Report {
  const days = uniqueDays(allDays, range).filter((d) => {
    const e = employment?.get(d.employeeId)
    return !e || (d.date >= e.hire && (!e.separation || d.date <= e.separation))
  })
  const slips = inMonths(allSlips, range)
  const total = attAgg()
  days.forEach((d) => addAtt(total, d))
  const rows = ordered(group(days, (d) => keyOf(d, by), attAgg, addAtt), by, (a) => a.absent * 1000 + a.late)
  const weekdays = group(days, (d) => keyOf(d, 'weekday'), attAgg, addAtt).sort((a, b) => a.key.localeCompare(b.key)).filter((w) => w.agg.expected > 0)
  const people = group(days, (d) => keyOf(d, 'employee'), attAgg, addAtt)

  const row = (label: string, a: AttAgg): Row => ({
    label,
    expected: a.expected,
    worked: a.worked,
    absent: a.absent,
    leave: a.leave,
    late: a.late,
    lateMinutes: a.lateMinutes,
    undertime: a.undertime,
    undertimeMinutes: a.undertimeMinutes,
    absenceRate: round2(ratio(a.absent, a.expected) * 10000) / 10000,
    lateRate: round2(ratio(a.late, a.worked) * 10000) / 10000,
  })
  const charts: Chart[] = []
  if (total.expected > 0) {
    charts.push({
      title: 'Absences and late arrivals by weekday',
      kind: 'columns',
      categories: weekdays.map((w) => w.label),
      series: [
        { key: 'absenceRate', label: 'Absent (% of scheduled days)', values: weekdays.map((w) => round2(ratio(w.agg.absent, w.agg.expected) * 100)) },
        { key: 'lateRate', label: 'Late (% of days worked)', values: weekdays.map((w) => round2(ratio(w.agg.late, w.agg.worked) * 100)) },
      ],
      unit: 'percent',
    })
    const lateTop = people.filter((p) => p.agg.late > 0).sort((a, b) => b.agg.late - a.agg.late || b.agg.lateMinutes - a.agg.lateMinutes).slice(0, 10)
    if (lateTop.length > 1) {
      charts.push({
        title: 'Most late arrivals',
        kind: 'bars',
        categories: lateTop.map((p) => p.label),
        series: [{ key: 'late', label: 'Times late', values: lateTop.map((p) => p.agg.late) }],
        unit: 'count',
      })
    }
  }

  const deducted = sum(slips, (f) => f.absenceDeduction + f.tardinessDeduction)
  const kpis: Kpi[] = [
    {
      label: 'Absence rate',
      value: pct(ratio(total.absent, total.expected)),
      sub: `${fmtNum(total.absent)} of ${fmtNum(total.expected)} scheduled days, without leave`,
      tone: ratio(total.absent, total.expected) >= 0.05 ? 'warn' : 'default',
    },
    { label: 'Late arrivals', value: fmtNum(total.late), sub: total.late ? `${pct(ratio(total.late, total.worked))} of days worked · ${fmtHours(total.lateMinutes)} in all` : 'none' },
    { label: 'Undertime', value: fmtNum(total.undertime), sub: total.undertime ? `days · ${fmtHours(total.undertimeMinutes)} in all` : 'none' },
    { label: 'Deducted from pay', value: money(deducted), sub: 'absences, tardiness and undertime of monthly-paid, in these payroll months' },
  ]

  const insights: Insight[] = []
  if (!days.length) insights.push(NO_PAY_YET)
  else {
    insights.push({
      tone: 'info',
      text: `Absent on ${pct(ratio(total.absent, total.expected))} of scheduled days (${fmtNum(total.absent)} of ${fmtNum(total.expected)}, leave not counted) and late on ${pct(ratio(total.late, total.worked))} of the days worked.`,
    })
    // a weekday clearly worse than the rest
    const worst = [...weekdays].sort((a, b) => ratio(b.agg.absent, b.agg.expected) - ratio(a.agg.absent, a.agg.expected))[0]
    if (worst && worst.agg.absent >= 3) {
      const rest = weekdays.filter((w) => w !== worst)
      const restRate = ratio(sum(rest, (w) => w.agg.absent), sum(rest, (w) => w.agg.expected))
      const rate = ratio(worst.agg.absent, worst.agg.expected)
      if (rate >= restRate * 1.5 && rate > 0) {
        insights.push({
          tone: 'warn',
          text: `Absences peak on ${WEEKDAY_NAMES[Number(worst.key) - 1]}: ${pct(rate)} of scheduled days against ${pct(restRate)} on the other days.`,
        })
      }
    }
    const late = people.filter((p) => p.agg.late >= 3).sort((a, b) => b.agg.late - a.agg.late || b.agg.lateMinutes - a.agg.lateMinutes)
    if (late.length) {
      insights.push({
        tone: 'warn',
        text: `Most often late: ${names(late.map((p) => `${p.label} (${p.agg.late} times, ${fmtHours(p.agg.lateMinutes)})`))}.`,
      })
    }
    const absent = people.filter((p) => p.agg.absent >= 3).sort((a, b) => b.agg.absent - a.agg.absent)
    if (absent.length) {
      insights.push({ tone: 'warn', text: `Absent 3 days or more without leave: ${names(absent.map((p) => `${p.label} (${p.agg.absent})`))}.` })
    }
    const perfect = people.filter((p) => p.agg.expected >= 10 && p.agg.absent === 0 && p.agg.late === 0 && p.agg.undertime === 0)
    if (perfect.length) {
      insights.push({
        tone: 'good',
        text: `Perfect attendance (no absence, late arrival or undertime over at least 10 scheduled days): ${names(perfect.map((p) => p.label), 5)}.`,
      })
    }
  }

  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: `Attendance by ${GROUP_LABELS[by].toLowerCase()}`,
        columns: [
          { key: 'label', label: GROUP_LABELS[by], kind: 'text' },
          { key: 'expected', label: 'Scheduled days', kind: 'number' },
          { key: 'worked', label: 'Days worked', kind: 'number' },
          { key: 'absent', label: 'Absent', kind: 'number' },
          { key: 'leave', label: 'On leave', kind: 'number' },
          { key: 'late', label: 'Times late', kind: 'number' },
          { key: 'lateMinutes', label: 'Time late', kind: 'minutes' },
          { key: 'undertime', label: 'Undertime days', kind: 'number' },
          { key: 'undertimeMinutes', label: 'Undertime', kind: 'minutes' },
          { key: 'absenceRate', label: 'Absence rate', kind: 'percent' },
          { key: 'lateRate', label: 'Late rate', kind: 'percent' },
        ],
        rows: rows.map((r) => row(r.label, r.agg)),
        total: days.length ? row('Total', total) : undefined,
        empty: 'No finalized payroll covers this period.',
      },
    ],
  }
}

// ---------- headcount & turnover ----------

export type PersonRow = Pick<
  Employee,
  | 'id'
  | 'first_name'
  | 'middle_name'
  | 'last_name'
  | 'suffix'
  | 'employee_no'
  | 'department'
  | 'position'
  | 'hire_date'
  | 'separation_date'
  | 'separation_reason'
  | 'employment_status'
  | 'pay_type'
  | 'monthly_rate'
  | 'daily_rate'
  | 'days_per_year'
>

export interface PaySettings {
  /** the client's working days a year, for a monthly rate's daily equivalent */
  workingDaysPerYear: number
  /** the client's minimum wage setting (0 = not set) */
  minimumWageDaily: number
  minimumWageRegion?: string
}

const employedOn = (e: PersonRow, d: string) => e.hire_date <= d && (!e.separation_date || e.separation_date >= d)

/**
 * Six months of probation are 180 days, counted with the first day excluded
 * (Civil Code Art. 13; Mitsubishi Motors v. Chrysler Phils. Labor Union,
 * G.R. 148738: hired May 27, 1996, probation ended Nov 23, 1996).
 */
export const PROBATION_DAYS = 180
/** The last day of a probationary period that started on the hire date. */
export const probationEnds = (hire: string) => addDays(hire, PROBATION_DAYS)

const yearsBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (365.25 * 864e5)

/** The daily rate, or a monthly rate's daily equivalent (rate × 12 ÷ working days a year). */
export function dailyEquivalent(e: Pick<PersonRow, 'pay_type' | 'monthly_rate' | 'daily_rate' | 'days_per_year'>, workingDaysPerYear: number): number {
  return e.pay_type === 'daily' ? n(e.daily_rate) : round2((n(e.monthly_rate) * 12) / (n(e.days_per_year) || workingDaysPerYear || 261))
}

/** A month's pay: the monthly rate, or a daily rate's monthly equivalent. */
export function monthlyEquivalent(e: Pick<PersonRow, 'pay_type' | 'monthly_rate' | 'daily_rate' | 'days_per_year'>, workingDaysPerYear: number): number {
  return e.pay_type === 'monthly' ? n(e.monthly_rate) : round2((n(e.daily_rate) * (n(e.days_per_year) || workingDaysPerYear || 261)) / 12)
}

export function headcountReport(all: PersonRow[], range: MonthRange, today: string, pay: PaySettings, department = ''): Report {
  const people = department ? all.filter((e) => noDepartment(e.department.trim()) === department) : all
  const months = monthsIn(range).filter((m) => `${m}-01` <= today)
  const start = rangeStart(range)
  const asOf = rangeEnd(range) < today ? rangeEnd(range) : today
  const before = addDays(start, -1)
  const headAt = (d: string) => people.filter((e) => employedOn(e, d)).length
  const monthRows = months.map((m) => {
    const ms = `${m}-01`
    const me = endOfMonth(ms) < asOf ? endOfMonth(ms) : asOf
    const hires = people.filter((e) => e.hire_date >= ms && e.hire_date <= me).length
    const seps = people.filter((e) => e.separation_date && e.separation_date >= ms && e.separation_date <= me).length
    const opening = headAt(addDays(ms, -1))
    const closing = headAt(me)
    return { m, opening, hires, seps, closing }
  })
  const avgHead = monthRows.length ? monthRows.reduce((s, r) => s + r.closing, 0) / monthRows.length : headAt(asOf)
  const hired = people.filter((e) => e.hire_date >= start && e.hire_date <= asOf)
  const separated = people.filter((e) => e.separation_date && e.separation_date >= start && e.separation_date <= asOf)
  const turnover = ratio(separated.length, avgHead)
  const annualized = monthRows.length && monthRows.length < 12 ? (turnover * 12) / monthRows.length : null
  const current = people.filter((e) => employedOn(e, asOf))
  const tenure = current.length ? current.reduce((s, e) => s + yearsBetween(e.hire_date, asOf), 0) / current.length : 0
  const name = (e: PersonRow) => fullName(e)

  const depts = new Map<string, { head: number; hires: number; seps: number; tenure: number }>()
  for (const e of people) {
    const k = noDepartment(e.department.trim())
    const d = depts.get(k) ?? { head: 0, hires: 0, seps: 0, tenure: 0 }
    if (employedOn(e, asOf)) {
      d.head += 1
      d.tenure += yearsBetween(e.hire_date, asOf)
    }
    if (e.hire_date >= start && e.hire_date <= asOf) d.hires += 1
    if (e.separation_date && e.separation_date >= start && e.separation_date <= asOf) d.seps += 1
    depts.set(k, d)
  }
  const deptRows = [...depts.entries()]
    .filter(([, d]) => d.head || d.hires || d.seps)
    .sort((a, b) => b[1].head - a[1].head || a[0].localeCompare(b[0]))

  const charts: Chart[] = monthRows.length
    ? [
        {
          title: 'Headcount at month end',
          kind: 'columns',
          categories: monthRows.map((r) => monthShort(r.m)),
          series: [{ key: 'closing', label: 'Headcount', values: monthRows.map((r) => r.closing) }],
          unit: 'count',
        },
        {
          title: 'Hires and separations',
          kind: 'columns',
          categories: monthRows.map((r) => monthShort(r.m)),
          series: [
            { key: 'hires', label: 'Hires', values: monthRows.map((r) => r.hires) },
            { key: 'seps', label: 'Separations', values: monthRows.map((r) => r.seps) },
          ],
          unit: 'count',
        },
      ]
    : []

  const opening = headAt(before)
  const kpis: Kpi[] = [
    { label: 'Headcount', value: fmtNum(current.length), sub: `${fmtNum(opening)} at the start (${current.length - opening >= 0 ? '+' : '−'}${Math.abs(current.length - opening)})` },
    { label: 'Hires', value: fmtNum(hired.length) },
    { label: 'Separations', value: fmtNum(separated.length) },
    {
      label: 'Turnover rate',
      value: pct(turnover),
      sub: annualized !== null ? `about ${pct(annualized)} a year at this pace` : `average headcount ${fmtNum(Math.round(avgHead * 10) / 10)}`,
    },
    { label: 'Average tenure', value: `${fmtNum(Math.round(tenure * 10) / 10)} yrs` },
  ]

  const insights: Insight[] = []
  if (separated.length) {
    insights.push({
      tone: 'info',
      text: `${plural(separated.length, 'separation')} against an average headcount of ${fmtNum(Math.round(avgHead * 10) / 10)}: ${pct(turnover)} turnover${annualized !== null ? `, about ${pct(annualized)} a year at this pace` : ''}.`,
    })
    const reasons = new Map<string, number>()
    for (const e of separated) {
      const r = e.separation_reason ? SEPARATION_REASON_LABELS[e.separation_reason] : 'No reason recorded'
      reasons.set(r, (reasons.get(r) ?? 0) + 1)
    }
    insights.push({
      tone: 'info',
      text: `Why they left: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r.toLowerCase()} ${c}`).join(', ')}.`,
    })
    const early = separated.filter((e) => e.separation_date! < addDays(e.hire_date, PROBATION_DAYS))
    if (early.length >= 2 && early.length / separated.length >= 0.4) {
      insights.push({
        tone: 'warn',
        text: `${early.length} of the ${separated.length} separations came within the first six months of employment — early leavers usually point to hiring or onboarding.`,
      })
    }
  } else if (months.length) {
    insights.push({ tone: 'good', text: 'No separations in this period.' })
  }
  if (current.length) {
    const mix = new Map<string, number>()
    for (const e of current) mix.set(EMPLOYMENT_STATUS_LABELS[e.employment_status], (mix.get(EMPLOYMENT_STATUS_LABELS[e.employment_status]) ?? 0) + 1)
    insights.push({ tone: 'info', text: `Employment status: ${[...mix.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${c} ${s.toLowerCase()}`).join(', ')}.` })
  }

  // what needs doing now (as of today, whatever the period)
  const activeNow = people.filter((e) => employedOn(e, today))
  const probation = activeNow
    .filter((e) => e.employment_status === 'probationary')
    .map((e) => ({ e, ends: probationEnds(e.hire_date) }))
    .sort((a, b) => a.ends.localeCompare(b.ends))
  const overdue = probation.filter((p) => p.ends < today)
  const dueSoon = probation.filter((p) => p.ends >= today && p.ends <= addDays(today, 30))
  if (overdue.length) {
    insights.push({
      tone: 'warn',
      text: `Still probationary after six months: ${names(overdue.map((p) => `${name(p.e)} (since ${fmtDate(p.e.hire_date)})`))}. An employee allowed to work past the probationary period is a regular employee (Labor Code Art. 296) — update their status.`,
    })
  }
  if (dueSoon.length) {
    insights.push({
      tone: 'warn',
      text: `Probation ends within 30 days for ${names(dueSoon.map((p) => `${name(p.e)} (${fmtDate(p.ends)})`))}: evaluate them against the standards made known when they were hired (Labor Code Art. 296).`,
    })
  }
  const leaving = activeNow.filter((e) => e.separation_date && e.separation_date >= today && e.separation_date <= addDays(today, 30))
  if (leaving.length) {
    insights.push({
      tone: 'info',
      text: `Leaving within 30 days: ${names(leaving.map((e) => `${name(e)} (${fmtDate(e.separation_date)})`))} — plan their handover. Final pay is due within 30 days of the last day, and a certificate of employment within 3 days of a request (DOLE Labor Advisory 06-20).`,
    })
  }
  if (pay.minimumWageDaily > 0) {
    // apprentices and learners may be paid 75% of the minimum (Labor Code Arts. 61 and 73)
    const floorOf = (e: PersonRow) => pay.minimumWageDaily * (e.employment_status === 'apprentice' ? 0.75 : 1)
    const below = activeNow.filter((e) => dailyEquivalent(e, pay.workingDaysPerYear) + 0.005 < floorOf(e))
    if (below.length) {
      insights.push({
        tone: 'warn',
        text: `Paid below the client's minimum wage setting (${money(pay.minimumWageDaily)} a day${pay.minimumWageRegion ? `, ${pay.minimumWageRegion}` : ''}; 75% of it for apprentices and learners): ${names(below.map((e) => `${name(e)} (${money(dailyEquivalent(e, pay.workingDaysPerYear))})`))}. Check the rate, or the exemption that allows it.`,
      })
    }
  }

  const tenureOf = (e: PersonRow, d: string) => `${fmtNum(Math.round(yearsBetween(e.hire_date, d) * 10) / 10)} yrs`
  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: 'Headcount by month',
        columns: [
          { key: 'label', label: 'Month', kind: 'text' },
          { key: 'opening', label: 'At the start', kind: 'number' },
          { key: 'hires', label: 'Hires', kind: 'number' },
          { key: 'seps', label: 'Separations', kind: 'number' },
          { key: 'closing', label: 'At month end', kind: 'number' },
          { key: 'turnover', label: 'Turnover', kind: 'percent' },
        ],
        rows: monthRows.map((r) => ({
          label: monthShort(r.m),
          opening: r.opening,
          hires: r.hires,
          seps: r.seps,
          closing: r.closing,
          turnover: r.closing + r.opening > 0 ? round2(ratio(r.seps, (r.opening + r.closing) / 2) * 10000) / 10000 : 0,
        })),
        empty: 'This period has not started yet.',
      },
      {
        title: 'By department',
        columns: [
          { key: 'label', label: 'Department', kind: 'text' },
          { key: 'head', label: 'Headcount', kind: 'number' },
          { key: 'hires', label: 'Hires', kind: 'number' },
          { key: 'seps', label: 'Separations', kind: 'number' },
          { key: 'tenure', label: 'Average tenure (yrs)', kind: 'number' },
        ],
        rows: deptRows.map(([k, d]) => ({ label: k, head: d.head, hires: d.hires, seps: d.seps, tenure: d.head ? Math.round((d.tenure / d.head) * 10) / 10 : 0 })),
        empty: 'No employees.',
      },
      {
        title: 'Probationary employees',
        columns: [
          { key: 'label', label: 'Employee', kind: 'text' },
          { key: 'department', label: 'Department', kind: 'text' },
          { key: 'hired', label: 'Hired', kind: 'date' },
          { key: 'ends', label: 'Six months end', kind: 'date' },
          { key: 'left', label: 'Days left', kind: 'text' },
        ],
        rows: probation.map((p) => ({
          label: name(p.e),
          department: noDepartment(p.e.department.trim()),
          hired: p.e.hire_date,
          ends: p.ends,
          left: (() => {
            const d = Math.round((Date.parse(`${p.ends}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 864e5)
            return d >= 0 ? plural(d, 'day') : `past, ${plural(-d, 'day')} ago`
          })(),
        })),
        empty: 'No probationary employees.',
      },
      {
        title: 'Separations in the period',
        columns: [
          { key: 'label', label: 'Employee', kind: 'text' },
          { key: 'department', label: 'Department', kind: 'text' },
          { key: 'hired', label: 'Hired', kind: 'date' },
          { key: 'last', label: 'Last day', kind: 'date' },
          { key: 'tenure', label: 'Tenure', kind: 'text' },
          { key: 'reason', label: 'Reason', kind: 'text' },
        ],
        rows: separated
          .sort((a, b) => a.separation_date!.localeCompare(b.separation_date!))
          .map((e) => ({
            label: name(e),
            department: noDepartment(e.department.trim()),
            hired: e.hire_date,
            last: e.separation_date,
            tenure: tenureOf(e, e.separation_date!),
            reason: e.separation_reason ? SEPARATION_REASON_LABELS[e.separation_reason] : '—',
          })),
        empty: 'No separations in this period.',
      },
    ],
  }
}

// ---------- leave ----------

export interface LeaveRow {
  employee_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  days: number
}
export interface EntitlementRow {
  employee_id: string
  leave_type_id: string
  year: number
  days: number
}

export function leaveReport(
  requests: LeaveRow[],
  types: (Pick<LeaveType, 'id' | 'code' | 'name' | 'paid' | 'default_annual_days' | 'min_service_months'> & { active?: boolean })[],
  people: PersonRow[],
  entitlements: EntitlementRow[],
  range: MonthRange,
  by: GroupBy,
  today: string,
  pay: PaySettings,
  department = '',
): Report {
  const staff = new Map(people.map((e) => [e.id, e]))
  const typeOf = new Map(types.map((t) => [t.id, t]))
  const inDept = (id: string) => {
    const e = staff.get(id)
    return !!e && (!department || noDepartment(e.department.trim()) === department)
  }
  // leaves by the date they start
  const taken = requests.filter((r) => r.start_date >= rangeStart(range) && r.start_date <= rangeEnd(range) && inDept(r.employee_id))
  interface LAgg {
    requests: number
    days: number
    paid: number
    unpaid: number
    employees: Set<string>
  }
  const lAgg = (): LAgg => ({ requests: 0, days: 0, paid: 0, unpaid: 0, employees: new Set() })
  const addL = (a: LAgg, r: LeaveRow) => {
    const d = n(r.days)
    a.requests += 1
    a.days += d
    if (typeOf.get(r.leave_type_id)?.paid) a.paid += d
    else a.unpaid += d
    a.employees.add(r.employee_id)
  }
  const key = (r: LeaveRow): [string, string] => {
    const e = staff.get(r.employee_id)!
    if (by === 'leave_type') {
      const t = typeOf.get(r.leave_type_id)
      return [r.leave_type_id, t?.name ?? 'Leave']
    }
    if (by === 'month') return [r.start_date.slice(0, 7), monthShort(r.start_date)]
    if (by === 'employee') return [e.id, fullName(e)]
    return [noDepartment(e.department.trim()), noDepartment(e.department.trim())]
  }
  const total = lAgg()
  taken.forEach((r) => addL(total, r))
  const rows = ordered(group(taken, key, lAgg, addL), by, (a) => a.days)

  // unused service incentive leave this year: converted to cash at year end
  const year = Number(today.slice(0, 4))
  // a client exempt from SIL (Art. 95: fewer than 10 workers, or 5+ days of paid leave already) turns the type off
  const sil = types.find((t) => t.code === 'SIL' && t.active !== false)
  const silRows: Row[] = []
  let silDays = 0
  let silValue = 0
  if (sil) {
    for (const e of people) {
      if (!employedOn(e, today) || (department && noDepartment(e.department.trim()) !== department)) continue
      const set = entitlements.find((x) => x.employee_id === e.id && x.leave_type_id === sil.id && x.year === year)
      const eligible = n(sil.min_service_months) <= 0 || addMonths(e.hire_date, n(sil.min_service_months)) <= today || (set?.days ?? 0) > 0
      if (!eligible) continue
      const credits = set ? n(set.days) : n(sil.default_annual_days)
      const used = sum(
        requests.filter((r) => r.employee_id === e.id && r.leave_type_id === sil.id && r.start_date.slice(0, 4) === String(year)),
        (r) => n(r.days),
      )
      const left = Math.max(0, round2(credits - used))
      const rate = dailyEquivalent(e, pay.workingDaysPerYear)
      silDays += left
      silValue += left * rate
      silRows.push({ label: fullName(e), department: noDepartment(e.department.trim()), credits, used, left, rate, value: round2(left * rate) })
    }
    silRows.sort((a, b) => Number(b.value) - Number(a.value))
  }
  silValue = round2(silValue)

  const charts: Chart[] = []
  if (rows.length) {
    const top = rows.slice(0, 12)
    charts.push(
      by === 'month'
        ? {
            title: 'Leave days by month started',
            kind: 'columns',
            categories: monthsIn(range).map(monthShort),
            series: [{ key: 'days', label: 'Leave days', values: monthsIn(range).map((m) => rows.find((r) => r.key === m)?.agg.days ?? 0) }],
            unit: 'days',
          }
        : {
            title: `Leave days by ${GROUP_LABELS[by].toLowerCase()}${rows.length > top.length ? ` (top ${top.length})` : ''}`,
            kind: 'bars',
            categories: top.map((r) => r.label),
            series: [{ key: 'days', label: 'Leave days', values: top.map((r) => round2(r.agg.days)) }],
            unit: 'days',
          },
    )
  }

  const kpis: Kpi[] = [
    { label: 'Leave days taken', value: fmtNum(round2(total.days)), sub: `${plural(total.requests, 'approved leave')} starting in the period` },
    { label: 'Employees on leave', value: fmtNum(total.employees.size), sub: total.employees.size ? `${fmtNum(Math.round((total.days / total.employees.size) * 10) / 10)} days each on average` : undefined },
    { label: 'Unpaid leave days', value: fmtNum(round2(total.unpaid)) },
    { label: 'Unused SIL', value: money(silValue), sub: `${fmtNum(silDays)} days at current rates, ${year}` },
  ]

  const insights: Insight[] = []
  if (!taken.length) insights.push({ tone: 'info', text: 'No approved leave started in this period.' })
  else {
    const byType = group(taken, (r) => [r.leave_type_id, typeOf.get(r.leave_type_id)?.name ?? 'Leave'], lAgg, addL).sort((a, b) => b.agg.days - a.agg.days)
    insights.push({ tone: 'info', text: `${byType[0].label} is ${pct(ratio(byType[0].agg.days, total.days))} of leave days (${fmtNum(round2(byType[0].agg.days))} of ${fmtNum(round2(total.days))}).` })
    if (total.unpaid > 0) {
      insights.push({ tone: 'info', text: `${fmtNum(round2(total.unpaid))} of the ${fmtNum(round2(total.days))} leave days ${total.unpaid === 1 ? 'was' : 'were'} unpaid.` })
    }
    const heavy = group(taken, (r) => [r.employee_id, fullName(staff.get(r.employee_id)!)], lAgg, addL).filter((p) => p.agg.days >= 10).sort((a, b) => b.agg.days - a.agg.days)
    if (heavy.length) insights.push({ tone: 'info', text: `10 days or more of leave: ${names(heavy.map((p) => `${p.label} (${fmtNum(round2(p.agg.days))})`))}.` })
  }
  if (silDays > 0) {
    insights.push({
      tone: 'warn',
      text: `Unused service incentive leave: ${fmtNum(silDays)} days across ${plural(silRows.filter((r) => Number(r.left) > 0).length, 'employee')}, about ${money(silValue)} at current daily rates. Unused SIL is converted to cash at the end of the year (Labor Code Art. 95) — budget for it, or encourage employees to take it.`,
    })
  }
  const yearStart = `${year}-01-01`
  const rested = new Set(requests.filter((r) => r.start_date >= yearStart && r.start_date <= `${year}-12-31`).map((r) => r.employee_id))
  const noLeave = people.filter(
    (e) => employedOn(e, today) && e.hire_date <= addMonths(today, -6) && !rested.has(e.id) && (!department || noDepartment(e.department.trim()) === department),
  )
  if (noLeave.length) {
    insights.push({ tone: 'info', text: `No leave taken in ${year} yet: ${names(noLeave.map((e) => fullName(e)), 5)}.` })
  }

  const lRow = (label: string, a: LAgg): Row => ({ label, requests: a.requests, days: round2(a.days), paid: round2(a.paid), unpaid: round2(a.unpaid), employees: a.employees.size })
  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: `Leave by ${GROUP_LABELS[by].toLowerCase()}`,
        columns: [
          { key: 'label', label: GROUP_LABELS[by], kind: 'text' },
          { key: 'requests', label: 'Leaves', kind: 'number' },
          { key: 'days', label: 'Days', kind: 'number' },
          { key: 'paid', label: 'Paid days', kind: 'number' },
          { key: 'unpaid', label: 'Unpaid days', kind: 'number' },
          { key: 'employees', label: 'Employees', kind: 'number' },
        ],
        rows: rows.map((r) => lRow(r.label, r.agg)),
        total: taken.length ? lRow('Total', total) : undefined,
        empty: 'No approved leave started in this period.',
      },
      {
        title: `Unused service incentive leave, ${year}`,
        columns: [
          { key: 'label', label: 'Employee', kind: 'text' },
          { key: 'department', label: 'Department', kind: 'text' },
          { key: 'credits', label: 'Credits', kind: 'number' },
          { key: 'used', label: 'Used', kind: 'number' },
          { key: 'left', label: 'Left', kind: 'number' },
          { key: 'rate', label: 'Daily rate', kind: 'money' },
          { key: 'value', label: 'Cash value', kind: 'money' },
        ],
        rows: silRows,
        total: silRows.length ? { label: 'Total', department: '', credits: sum(silRows, (r) => Number(r.credits)), used: sum(silRows, (r) => Number(r.used)), left: silDays, rate: null, value: silValue } : undefined,
        empty: sil ? 'Nobody has service incentive leave yet (it starts after 12 months of service).' : 'This client has no Service Incentive Leave type.',
      },
    ],
  }
}

// ---------- cash advances & loans ----------

export interface AdvanceRow {
  id: string
  employee_id: string
  category: string
  label: string
  total_amount: number | null
  balance: number | null
  amount_per_period: number
  active: boolean
  released_on: string | null
  created_at?: string
}
export interface RepaymentRow {
  advance_id: string
  amount: number
  paid_on: string
}

export function advancesReport(
  deductions: AdvanceRow[],
  repayments: RepaymentRow[],
  allSlips: SlipFact[],
  people: PersonRow[],
  range: MonthRange,
  today: string,
  pay: PaySettings,
  department = '',
): Report {
  const staff = new Map(people.map((e) => [e.id, e]))
  const inDept = (id: string) => {
    const e = staff.get(id)
    return !!e && (!department || noDepartment(e.department.trim()) === department)
  }
  const advances = deductions.filter((d) => d.category === 'cash_advance' && inDept(d.employee_id))
  const loans = deductions.filter((d) => d.category !== 'cash_advance' && d.balance !== null && n(d.balance) > 0 && inDept(d.employee_id))
  const open = advances.filter((a) => n(a.balance) > 0)
  const advanceIds = new Set(advances.map((a) => a.id))
  const from = rangeStart(range)
  const to = rangeEnd(range)
  const slips = allSlips.filter((f) => f.runType !== 'thirteenth_month' && inDept(f.employeeId))
  const months = monthsIn(range)
  const releasedOn = (a: AdvanceRow) => a.released_on ?? a.created_at?.slice(0, 10) ?? ''

  const released = advances.filter((a) => releasedOn(a) >= from && releasedOn(a) <= to)
  const repaid = repayments.filter((r) => advanceIds.has(r.advance_id) && r.paid_on >= from && r.paid_on <= to)
  const payrollIn = slips.filter((f) => f.month >= range.from && f.month <= range.to)
  const collectedPayroll = sum(payrollIn, (f) => f.advanceDeducted)
  const collectedDirect = sum(repaid, (r) => n(r.amount))
  const outstanding = sum(open, (a) => n(a.balance))

  const charts: Chart[] =
    released.length || collectedPayroll || collectedDirect
      ? [
          {
            title: 'Cash advances released and collected',
            kind: 'columns',
            categories: months.map(monthShort),
            series: [
              { key: 'released', label: 'Released', values: months.map((m) => sum(released.filter((a) => releasedOn(a).slice(0, 7) === m), (a) => n(a.total_amount))) },
              {
                key: 'collected',
                label: 'Collected',
                values: months.map((m) => round2(sum(payrollIn.filter((f) => f.month === m), (f) => f.advanceDeducted) + sum(repaid.filter((r) => r.paid_on.slice(0, 7) === m), (r) => n(r.amount)))),
              },
            ],
            unit: 'money',
          },
        ]
      : []

  // each employee's open advances, against a month's pay
  const ages = (a: AdvanceRow) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${releasedOn(a) || today}T00:00:00Z`)) / 864e5)
  const lastDeducted = new Map<string, string>()
  for (const f of slips) {
    if (f.advanceDeducted > 0 && f.periodEnd && f.periodEnd > (lastDeducted.get(f.employeeId) ?? '')) lastDeducted.set(f.employeeId, f.periodEnd)
  }
  const owing = new Map<string, AdvanceRow[]>()
  for (const a of open) owing.set(a.employee_id, [...(owing.get(a.employee_id) ?? []), a])
  const empRows = [...owing.entries()]
    .map(([id, list]) => {
      const e = staff.get(id)!
      const owed = sum(list, (a) => n(a.balance))
      const monthPay = monthlyEquivalent(e, pay.workingDaysPerYear)
      const fixed = sum(list.filter((a) => a.active), (a) => n(a.amount_per_period))
      const oldest = list.map(releasedOn).sort()[0] ?? ''
      return {
        e,
        list,
        owed,
        monthPay,
        row: {
          label: fullName(e),
          department: noDepartment(e.department.trim()),
          advances: list.length,
          owed,
          oldest,
          installment: list.some((a) => a.active && !(n(a.amount_per_period) > 0)) ? (fixed ? `${money(fixed)} + agreed` : 'agreed each payroll') : money(fixed),
          share: monthPay > 0 ? round2((owed / monthPay) * 10000) / 10000 : 0,
          lastDeducted: lastDeducted.get(id) ?? '',
        } as Row,
      }
    })
    .sort((a, b) => b.owed - a.owed)

  const buckets = [
    { label: '30 days or less', test: (d: number) => d <= 30 },
    { label: '31–60 days', test: (d: number) => d > 30 && d <= 60 },
    { label: '61–90 days', test: (d: number) => d > 60 && d <= 90 },
    { label: 'Over 90 days', test: (d: number) => d > 90 },
  ].map((b) => {
    const list = open.filter((a) => b.test(ages(a)))
    return { label: b.label, advances: list.length, owed: sum(list, (a) => n(a.balance)) }
  })

  const kpis: Kpi[] = [
    { label: 'Advances outstanding', value: money(outstanding), sub: `${plural(owing.size, 'employee')} owing, as of today` },
    { label: 'Released in the period', value: money(sum(released, (a) => n(a.total_amount))), sub: plural(released.length, 'advance') },
    { label: 'Collected in the period', value: money(collectedPayroll + collectedDirect), sub: `payroll ${money(collectedPayroll)} · direct ${money(collectedDirect)}` },
    { label: 'Loans outstanding', value: money(sum(loans, (l) => n(l.balance))), sub: `${plural(loans.length, 'loan')} (company, SSS, Pag-IBIG)` },
  ]

  const insights: Insight[] = []
  const releasedSum = sum(released, (a) => n(a.total_amount))
  const collected = round2(collectedPayroll + collectedDirect)
  if (releasedSum || collected) {
    const net = round2(releasedSum - collected)
    insights.push({
      tone: 'info',
      text: `${money(releasedSum)} released and ${money(collected)} collected in the period: what employees owe ${net > 0 ? `grew by ${money(net)}` : net < 0 ? `fell by ${money(-net)}` : 'stayed the same'}.`,
    })
  } else if (!open.length) insights.push({ tone: 'good', text: 'No cash advances outstanding.' })
  const old = buckets[3]
  if (old.advances) {
    insights.push({ tone: 'warn', text: `${money(old.owed)} (${plural(old.advances, 'advance')}) was released more than 90 days ago and is still owed.` })
  }
  const exposed = empRows.filter((r) => r.monthPay > 0 && r.owed >= r.monthPay * 0.5)
  if (exposed.length) {
    insights.push({
      tone: 'warn',
      text: `Owing half a month's pay or more: ${names(exposed.map((r) => `${fullName(r.e)} (${pct(r.owed / r.monthPay)})`))}. Consider the balance before releasing another advance.`,
    })
  }
  // open advances no recent payroll deducted
  const recent = new Map<string, SlipFact[]>()
  for (const f of [...slips].sort((a, b) => (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''))) {
    const list = recent.get(f.employeeId) ?? []
    if (list.length < 2) recent.set(f.employeeId, [...list, f])
  }
  const stalled = empRows.filter((r) => {
    const last2 = recent.get(r.e.id) ?? []
    return last2.length === 2 && last2.every((f) => f.advanceDeducted <= 0) && r.list.some((a) => a.active && ages(a) >= 30)
  })
  if (stalled.length) {
    insights.push({
      tone: 'warn',
      text: `Nothing deducted in their last 2 payrolls: ${names(stalled.map((r) => `${fullName(r.e)} (${money(r.owed)})`))}. Set an amount in the next payroll, or record a repayment.`,
    })
  }
  const paused = open.filter((a) => !a.active)
  if (paused.length) {
    insights.push({ tone: 'warn', text: `${plural(paused.length, 'paused advance')} (${money(sum(paused, (a) => n(a.balance)))}) ${paused.length === 1 ? 'is' : 'are'} not being collected.` })
  }
  const leavers = empRows.filter((r) => r.e.separation_date && r.e.separation_date <= addDays(today, 30))
  if (leavers.length) {
    insights.push({
      tone: 'warn',
      text: `Leaving or left with an advance still owed: ${names(leavers.map((r) => `${fullName(r.e)} (last day ${fmtDate(r.e.separation_date)}, ${money(r.owed)})`))}. The payroll that includes the last day takes the rest, as far as the pay allows; collect any shortfall directly.`,
    })
  }
  const multi = empRows.filter((r) => r.list.length >= 2)
  if (multi.length) insights.push({ tone: 'info', text: `More than one advance open: ${names(multi.map((r) => `${fullName(r.e)} (${r.list.length})`))}.` })

  return {
    kpis,
    insights,
    charts,
    tables: [
      {
        title: 'Employees owing',
        columns: [
          { key: 'label', label: 'Employee', kind: 'text' },
          { key: 'department', label: 'Department', kind: 'text' },
          { key: 'advances', label: 'Open advances', kind: 'number' },
          { key: 'owed', label: 'Owed', kind: 'money' },
          { key: 'oldest', label: 'Oldest released', kind: 'date' },
          { key: 'installment', label: 'Per payroll', kind: 'text' },
          { key: 'share', label: "Owed / a month's pay", kind: 'percent' },
          { key: 'lastDeducted', label: 'Last deducted (cutoff)', kind: 'date' },
        ],
        rows: empRows.map((r) => r.row),
        total: empRows.length ? { label: 'Total', department: '', advances: open.length, owed: outstanding, oldest: null, installment: '', share: null, lastDeducted: null } : undefined,
        empty: 'No cash advances outstanding.',
      },
      {
        title: 'Open advances by age',
        columns: [
          { key: 'label', label: 'Released', kind: 'text' },
          { key: 'advances', label: 'Advances', kind: 'number' },
          { key: 'owed', label: 'Owed', kind: 'money' },
        ],
        rows: open.length ? buckets.map((b) => ({ ...b })) : [],
        empty: 'No cash advances outstanding.',
      },
    ],
  }
}

// ---------- custom report ----------

export interface Measure {
  key: string
  label: string
  kind: 'money' | 'number'
  of: (f: SlipFact) => number
}

export const MEASURES: Measure[] = [
  { key: 'cost', label: 'Employer cost', kind: 'money', of: (f) => f.gross + f.er },
  { key: 'gross', label: 'Gross pay', kind: 'money', of: (f) => f.gross },
  { key: 'basic', label: 'Basic pay (earned)', kind: 'money', of: (f) => f.basic },
  { key: 'overtime', label: 'Overtime pay', kind: 'money', of: (f) => f.overtime },
  { key: 'nightDiff', label: 'Night differential', kind: 'money', of: (f) => f.nightDiff },
  { key: 'premiums', label: 'Holiday & rest-day premiums', kind: 'money', of: (f) => f.premiums },
  { key: 'allowances', label: 'Allowances', kind: 'money', of: (f) => f.allowances },
  { key: 'thirteenth', label: '13th month', kind: 'money', of: (f) => f.thirteenth },
  { key: 'other', label: 'Adjustments & other pay', kind: 'money', of: (f) => f.other },
  { key: 'er', label: 'Employer contributions', kind: 'money', of: (f) => f.er },
  { key: 'ee', label: 'Employee contributions', kind: 'money', of: (f) => f.ee },
  { key: 'tax', label: 'Withholding tax', kind: 'money', of: (f) => f.tax },
  { key: 'net', label: 'Net pay', kind: 'money', of: (f) => f.net },
  { key: 'advanceDeducted', label: 'Cash advances deducted', kind: 'money', of: (f) => f.advanceDeducted },
  { key: 'loanDeducted', label: 'Loans deducted', kind: 'money', of: (f) => f.loanDeducted },
  { key: 'absenceDeduction', label: 'Absences deducted', kind: 'money', of: (f) => f.absenceDeduction },
  { key: 'tardinessDeduction', label: 'Tardiness & undertime deducted', kind: 'money', of: (f) => f.tardinessDeduction },
  { key: 'otHours', label: 'Overtime hours', kind: 'number', of: (f) => f.otHours },
  { key: 'ndHours', label: 'Night differential hours', kind: 'number', of: (f) => f.ndHours },
  { key: 'hoursWorked', label: 'Hours worked', kind: 'number', of: (f) => f.hoursWorked },
  { key: 'daysWorked', label: 'Days worked', kind: 'number', of: (f) => f.daysWorked },
  { key: 'absentDays', label: 'Days absent', kind: 'number', of: (f) => f.absentDays },
  { key: 'lateMinutes', label: 'Minutes late', kind: 'number', of: (f) => f.lateMinutes },
  { key: 'undertimeMinutes', label: 'Minutes undertime', kind: 'number', of: (f) => f.undertimeMinutes },
]
export const DEFAULT_MEASURES = ['cost', 'gross', 'overtime', 'net']

export function customReport(all: SlipFact[], range: MonthRange, by: GroupBy, measureKeys: string[]): Report {
  const facts = inMonths(all, range)
  const measures = measureKeys.map((k) => MEASURES.find((m) => m.key === k)).filter((m): m is Measure => !!m)
  const chosen = measures.length ? measures : MEASURES.filter((m) => DEFAULT_MEASURES.includes(m.key))
  interface CAgg {
    values: number[]
    employees: Set<string>
    payslips: number
  }
  const init = (): CAgg => ({ values: chosen.map(() => 0), employees: new Set(), payslips: 0 })
  const add = (a: CAgg, f: SlipFact) => {
    chosen.forEach((m, i) => (a.values[i] += m.of(f)))
    a.employees.add(f.employeeId)
    a.payslips += 1
  }
  const total = init()
  facts.forEach((f) => add(total, f))
  const rows = ordered(group(facts, (f) => keyOf(f, by), init, add), by, (a) => a.values[0])
  const row = (label: string, a: CAgg): Row => {
    const r: Row = { label, employees: a.employees.size, payslips: a.payslips }
    chosen.forEach((m, i) => (r[m.key] = round2(a.values[i])))
    return r
  }
  const first = chosen[0]
  const fmt = (v: number) => (first.kind === 'money' ? money(v) : fmtNum(round2(v)))
  const charts: Chart[] = []
  if (facts.length) {
    if (by === 'month') {
      const months = monthsIn(range)
      charts.push({
        title: `${first.label} by month`,
        kind: 'columns',
        categories: months.map(monthShort),
        series: [{ key: first.key, label: first.label, values: months.map((m) => round2(rows.find((r) => r.key === m)?.agg.values[0] ?? 0)) }],
        unit: first.kind === 'money' ? 'money' : 'count',
      })
    } else {
      const top = rows.slice(0, 15)
      charts.push({
        title: `${first.label} by ${GROUP_LABELS[by].toLowerCase()}${rows.length > top.length ? ` (top ${top.length})` : ''}`,
        kind: 'bars',
        categories: top.map((r) => r.label),
        series: [{ key: first.key, label: first.label, values: top.map((r) => round2(r.agg.values[0])) }],
        unit: first.kind === 'money' ? 'money' : 'count',
      })
    }
  }
  const insights: Insight[] = []
  if (!facts.length) insights.push(NO_PAY_YET)
  else if (rows.length >= 2 && by !== 'month' && total.values[0] > 0) {
    insights.push({ tone: 'info', text: `${rows[0].label} has the most ${first.label.toLowerCase()}: ${fmt(rows[0].agg.values[0])}, ${pct(ratio(rows[0].agg.values[0], total.values[0]))} of the total.` })
  } else if (by === 'month' && rows.length >= 2) {
    const hi = [...rows].sort((a, b) => b.agg.values[0] - a.agg.values[0])[0]
    insights.push({ tone: 'info', text: `${first.label} peaked in ${hi.label}: ${fmt(hi.agg.values[0])}.` })
  }
  return {
    kpis: chosen.slice(0, 4).map((m, i) => ({ label: m.label, value: m.kind === 'money' ? money(total.values[i]) : fmtNum(round2(total.values[i])) })),
    insights,
    charts,
    tables: [
      {
        title: `By ${GROUP_LABELS[by].toLowerCase()}`,
        columns: [
          { key: 'label', label: GROUP_LABELS[by], kind: 'text' },
          ...chosen.map((m): Column => ({ key: m.key, label: m.label, kind: m.kind })),
          { key: 'employees', label: 'Employees', kind: 'number' },
          { key: 'payslips', label: 'Payslips', kind: 'number' },
        ],
        rows: rows.map((r) => row(r.label, r.agg)),
        total: facts.length ? row('Total', total) : undefined,
        empty: 'No finalized payslips in this period.',
      },
    ],
  }
}
