// In-memory stand-in for the supabase-js query builder, just enough of it
// for computeRun / getEntity / getStatutoryTables / getHolidaysBetween.
// Mirrors the DB triggers that matter for payroll math (payslips copy their
// run's period facts) and the finalize RPC (status flip, rounding carry,
// payroll_seq, loan balances, overlap + staleness checks).

import { DEFAULT_TABLES } from '../defaults'
import { slotFor } from '../../lib/payPeriods'
import { eachDate, isoWeekday } from '../../lib/manila'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

const TABLES = [
  'entities', 'employees', 'payroll_runs', 'payslips', 'time_entries', 'leave_requests', 'leave_types',
  'employee_allowances', 'recurring_deductions', 'payroll_adjustments', 'employee_tax_years',
  'statutory_versions', 'holidays', 'employee_schedules', 'schedule_overrides', 'payroll_deduction_overrides',
]

export const db: { t: Record<string, Row[]>; seq: number } = { t: {}, seq: 0 }

export function resetDb() {
  db.seq = 0
  db.t = Object.fromEntries(TABLES.map((n) => [n, []]))
  for (const [kind, data] of Object.entries(DEFAULT_TABLES)) {
    db.t.statutory_versions.push({ id: newId(), kind, effective_from: '2000-01-01', data })
  }
}

export function newId(): string {
  const n = ++db.seq
  // uuid-shaped so the loan-balance regex in finalize matches
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const REL: Record<string, { table: string; fk: string }> = {
  payroll_runs: { table: 'payroll_runs', fk: 'payroll_run_id' },
  employees: { table: 'employees', fk: 'employee_id' },
  leave_types: { table: 'leave_types', fk: 'leave_type_id' },
}

function relRow(row: Row, rel: string): Row | undefined {
  const r = REL[rel]
  return db.t[r.table].find((x) => x.id === row[r.fk])
}

function resolve(row: Row, path: string): any {
  if (path.includes('->>')) {
    const [col, key] = path.split('->>')
    const v = row[col]
    return v == null || v[key] == null ? null : String(v[key])
  }
  if (path.includes('.')) {
    const [rel, col] = path.split('.')
    return relRow(row, rel)?.[col]
  }
  return row[path]
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

class Q implements PromiseLike<{ data: any; error: any }> {
  private filters: ((r: Row) => boolean)[] = []
  private orders: { col: string; asc: boolean }[] = []
  private rangeArg?: [number, number]
  private limitN?: number
  private mode: 'select' | 'update' | 'delete' | 'insert' = 'select'
  private payload: any
  private returning = false
  private singleMode: 'single' | 'maybe' | null = null
  private embeds: string[] = []
  private table: string
  constructor(table: string) {
    this.table = table
  }

  select(cols = '*') {
    if (this.mode !== 'select') {
      this.returning = true
      return this
    }
    const re = /(\w+)(!inner)?\(([^)]*)\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(cols))) {
      const rel = m[1]
      this.embeds.push(rel)
      if (m[2]) this.filters.push((r) => relRow(r, rel) != null)
    }
    return this
  }
  insert(rows: Row | Row[]) {
    this.mode = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }
  update(obj: Row) {
    this.mode = 'update'
    this.payload = obj
    return this
  }
  delete() {
    this.mode = 'delete'
    return this
  }
  eq(c: string, v: any) {
    this.filters.push((r) => resolve(r, c) === v)
    return this
  }
  neq(c: string, v: any) {
    this.filters.push((r) => {
      const x = resolve(r, c)
      return x != null && x !== v
    })
    return this
  }
  in(c: string, vs: any[]) {
    this.filters.push((r) => vs.includes(resolve(r, c)))
    return this
  }
  gte(c: string, v: any) {
    this.filters.push((r) => {
      const x = resolve(r, c)
      return x != null && x >= v
    })
    return this
  }
  lte(c: string, v: any) {
    this.filters.push((r) => {
      const x = resolve(r, c)
      return x != null && x <= v
    })
    return this
  }
  or(expr: string) {
    const parts = expr.split(',').map((p) => p.split('.'))
    this.filters.push((r) => parts.some(([col, op, val]) => (op === 'is' ? r[col] == null : String(r[col]) === val)))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false })
    return this
  }
  range(a: number, b: number) {
    this.rangeArg = [a, b]
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  single() {
    this.singleMode = 'single'
    return this
  }
  maybeSingle() {
    this.singleMode = 'maybe'
    return this
  }
  then<A, B>(res?: ((v: { data: any; error: any }) => A | PromiseLike<A>) | null, rej?: ((e: any) => B | PromiseLike<B>) | null) {
    let out: { data: any; error: any }
    try {
      out = this.exec()
    } catch (e) {
      out = { data: null, error: { message: (e as Error).message } }
    }
    return Promise.resolve(out).then(res, rej)
  }

  private matched(): Row[] {
    return db.t[this.table].filter((r) => this.filters.every((f) => f(r)))
  }

  private exec(): { data: any; error: any } {
    const table = db.t[this.table]
    if (this.mode === 'insert') {
      const inserted: Row[] = []
      for (const p of this.payload) {
        const row = { id: newId(), ...clone(p) }
        if (this.table === 'payslips') {
          const run = db.t.payroll_runs.find((r) => r.id === row.payroll_run_id)
          if (!run) throw new Error('Payroll run not found.')
          Object.assign(row, {
            entity_id: run.entity_id,
            period_start: run.period_start,
            period_end: run.period_end,
            pay_date: run.pay_date,
            run_type: run.run_type,
            period_month: run.period_month,
            pay_frequency: run.pay_frequency,
          })
        }
        table.push(row)
        inserted.push(row)
      }
      return { data: this.returning ? clone(inserted) : null, error: null }
    }
    if (this.mode === 'update') {
      const rows = this.matched()
      for (const r of rows) Object.assign(r, clone(this.payload))
      return { data: this.returning ? clone(rows) : null, error: null }
    }
    if (this.mode === 'delete') {
      const rows = new Set(this.matched())
      db.t[this.table] = table.filter((r) => !rows.has(r))
      return { data: null, error: null }
    }
    let rows = this.matched()
    if (this.orders.length) {
      rows = rows.slice().sort((a, b) => {
        for (const o of this.orders) {
          const x = resolve(a, o.col)
          const y = resolve(b, o.col)
          if (x === y) continue
          const c = x < y ? -1 : 1
          return o.asc ? c : -c
        }
        return 0
      })
    }
    if (this.rangeArg) rows = rows.slice(this.rangeArg[0], this.rangeArg[1] + 1)
    if (this.limitN !== undefined) rows = rows.slice(0, this.limitN)
    const out = rows.map((r) => {
      const c = clone(r)
      for (const rel of this.embeds) {
        const x = relRow(r, rel)
        c[rel] = x ? clone(x) : null
      }
      return c
    })
    if (this.singleMode) {
      if (out.length === 1) return { data: out[0], error: null }
      if (out.length === 0 && this.singleMode === 'maybe') return { data: null, error: null }
      return { data: null, error: { message: `single() got ${out.length} rows` } }
    }
    return { data: out, error: null }
  }
}

export const fakeSupabase = {
  from: (table: string) => new Q(table),
  rpc: () => {
    throw new Error('rpc not faked')
  },
}

// ---------------------------------------------------------------- helpers

export function addEntity(over: Row = {}): Row {
  const e: Row = {
    id: newId(),
    code: 'ACME',
    name: 'Acme',
    tin: '000-000-000',
    default_pay_frequency: 'semi_monthly',
    minimum_wage_region: 'NCR',
    minimum_wage_daily: 755,
    standard_hours_per_day: 8,
    working_days_divisor: 261,
    grace_period_minutes: 0,
    night_diff_rate: 0.1,
    contribution_deduction_timing: 'split',
    net_pay_rounding: 'none',
    rounding_scope: 'cash_only',
    pay_date_lag_days: 5,
    ...over,
  }
  db.t.entities.push(e)
  return e
}

export const MON_FRI = { days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00', break_minutes: 60 }

export function addEmployee(entity: Row, over: Row = {}): Row {
  const e: Row = {
    id: newId(),
    entity_id: entity.id,
    employee_no: 'E1',
    first_name: 'Juan',
    middle_name: null,
    last_name: 'Cruz',
    suffix: null,
    hire_date: '2020-01-01',
    separation_date: null,
    separation_reason: null,
    employment_status: 'regular',
    position: 'Staff',
    department: 'Ops',
    pay_type: 'monthly',
    pay_frequency: 'semi_monthly',
    monthly_rate: 30000,
    daily_rate: 0,
    days_per_year: null,
    is_minimum_wage_earner: false,
    payment_method: 'bank_transfer',
    work_schedule: MON_FRI,
    rounding_balance: 0,
    payroll_seq: 0,
    tin: '123-456-789',
    ...over,
  }
  db.t.employees.push(e)
  return e
}

/** Full attendance 08:00–17:00 Manila on every scheduled day in [start, end]. */
export function addAttendance(emp: Row, start: string, end: string) {
  for (const d of eachDate(start, end)) {
    if (!emp.work_schedule.days.includes(isoWeekday(d))) continue
    if (emp.separation_date && d > emp.separation_date) continue
    if (d < emp.hire_date) continue
    db.t.time_entries.push({
      id: newId(),
      entity_id: emp.entity_id,
      employee_id: emp.id,
      work_date: d,
      clock_in: `${d}T00:00:00.000Z`,
      clock_out: `${d}T09:00:00.000Z`,
    })
  }
}

export function addRun(entity: Row, over: Row & { period_start: string; period_end: string; pay_date: string }): Row {
  const freq = over.pay_frequency ?? 'semi_monthly'
  const runType = over.run_type ?? 'regular'
  const slot = runType === 'thirteenth_month'
    ? { month: `${over.period_end.slice(0, 7)}-01`, index: 1, count: 1 }
    : slotFor(freq, over.period_end)
  const r: Row = {
    id: newId(),
    entity_id: entity.id,
    run_type: runType,
    pay_frequency: runType === 'thirteenth_month' ? null : freq,
    period_month: slot.month,
    period_index: slot.index,
    periods_in_month: slot.count,
    employee_ids: null,
    annualize: false,
    status: 'draft',
    notes: '',
    totals: {},
    ...over,
  }
  // payroll_runs_annualize_december: the year-end adjustment is a December pay date's
  if (r.annualize && String(r.pay_date).slice(5, 7) !== '12') throw new Error('payroll_runs_annualize_december')
  db.t.payroll_runs.push(r)
  return r
}

/** Mirror of finalize_payroll_run (status flip, carry chain, seq, loans, guards). */
export function finalize(runId: string) {
  const run = db.t.payroll_runs.find((r) => r.id === runId)!
  if (run.status !== 'draft') throw new Error('not a draft')
  const slips = db.t.payslips.filter((p) => p.payroll_run_id === runId)
  if (run.totals?.employees !== slips.length) throw new Error('draft out of date')
  if (slips.length === 0) throw new Error('Nothing to finalize')
  const orphan = db.t.payroll_adjustments.find(
    (a) => a.payroll_run_id === runId && !slips.some((p) => p.employee_id === a.employee_id),
  )
  if (orphan) throw new Error('An adjustment belongs to an employee without a payslip in this run')
  for (const p of slips) {
    const e = db.t.employees.find((x) => x.id === p.employee_id)!
    if (Number(e.rounding_balance) !== Number(p.rounding_carry_in) || e.payroll_seq !== p.employee_payroll_seq) {
      throw new Error(`stale draft for ${e.first_name}`)
    }
  }
  if (run.run_type !== 'thirteenth_month') {
    for (const p of slips) {
      const clash = db.t.payslips.find((q) => {
        if (q.employee_id !== p.employee_id || q.payroll_run_id === runId) return false
        const r = db.t.payroll_runs.find((x) => x.id === q.payroll_run_id)!
        return ['finalized', 'paid'].includes(r.status) && r.run_type !== 'thirteenth_month' &&
          r.period_start <= run.period_end && r.period_end >= run.period_start
      })
      if (clash) throw new Error('Already paid for an overlapping period')
    }
  }
  run.status = 'finalized'
  for (const p of slips) {
    const e = db.t.employees.find((x) => x.id === p.employee_id)!
    e.rounding_balance = p.rounding_carry_out
    e.payroll_seq += 1
    for (const l of p.deductions) {
      if (!String(l.code).startsWith('other:') || !l.meta) continue
      const d = db.t.recurring_deductions.find((x) => x.id === l.meta && x.employee_id === p.employee_id)
      if (d && d.balance != null) {
        d.balance = Math.round((Number(d.balance) - Number(l.amount)) * 100) / 100
        d.active = d.active && d.balance > 0
      }
    }
  }
}

export function slipsOf(runId: string, empId?: string): Row[] {
  return db.t.payslips.filter((p) => p.payroll_run_id === runId && (!empId || p.employee_id === empId))
}
