// Management reports (BIR & Reports → Insights): pick a report, a period,
// a department and how to group it; the key figures, what stands out, the
// charts and the tables behind them follow, and the whole report downloads
// as CSV or PDF. The choice lives in the URL, so a report can be bookmarked
// or sent to another admin of the client. Figures: src/lib/insights.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Download, FileDown, Info, Lightbulb } from 'lucide-react'
import { InsightChart } from '../../components/InsightChart'
import { Button, Card, Field, Input, LoadFailed, Select, Spinner, StatCard, StatGroup, TableShell, Td, Th } from '../../components/ui'
import { downloadCsv } from '../../lib/api'
import type { Entity } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import {
  advancesReport,
  attendanceReport,
  cellText,
  costReport,
  customReport,
  DEFAULT_MEASURES,
  GROUP_LABELS,
  headcountReport,
  leaveReport,
  MEASURES,
  noDepartment,
  overtimeReport,
  presetRange,
  PRESETS,
  rangeEnd,
  rangeLabel,
  rangeStart,
  reportCsv,
  type AdvanceRow,
  type DayFact,
  type EntitlementRow,
  type GroupBy,
  type LeaveRow,
  type MonthRange,
  type PersonRow,
  type PresetKey,
  type RepaymentRow,
  type Report,
  type SlipFact,
  type Table,
} from '../../lib/insights'
import { fetchAdvances, fetchAttendance, fetchLeave, fetchPeople, fetchSlipFacts } from '../../lib/insightsData'
import type { LeaveType } from '../../lib/db'
import { addMonths, todayManila } from '../../lib/manila'
import { generateInsightsPdf } from '../../pdf/insightsPdf'

type ReportKey = 'cost' | 'overtime' | 'attendance' | 'headcount' | 'leave' | 'advances' | 'custom'

const REPORTS: Record<ReportKey, { label: string; title: string; groups: GroupBy[]; about: string; periodless?: boolean }> = {
  cost: {
    label: 'Payroll cost',
    title: 'Payroll cost report',
    groups: ['month', 'department', 'position', 'employee', 'pay_type'],
    about: 'What payroll costs the business — gross pay plus employer SSS, PhilHealth and Pag-IBIG — what it is made of, and what moved it. Finalized payrolls, by payroll month.',
  },
  overtime: {
    label: 'Overtime',
    title: 'Overtime report',
    groups: ['employee', 'department', 'position', 'month'],
    about: 'Who works overtime, how much it costs, and whether it has become routine. Finalized payrolls, by payroll month.',
  },
  attendance: {
    label: 'Attendance',
    title: 'Attendance report',
    groups: ['employee', 'department', 'position', 'month', 'weekday'],
    about: "Absences without leave, late arrivals and undertime on scheduled workdays, from finalized payrolls' own day-by-day computation.",
  },
  headcount: {
    label: 'Headcount & turnover',
    title: 'Headcount and turnover report',
    groups: [],
    about: 'Headcount, hires, separations and why people left, tenure, probation deadlines and pay below the minimum wage setting — from the employee records.',
  },
  leave: {
    label: 'Leave',
    title: 'Leave report',
    groups: ['leave_type', 'department', 'employee', 'month'],
    about: "Approved leave by when it starts, and this year's unused service incentive leave with what it will cost in cash.",
  },
  advances: {
    label: 'Cash advances & loans',
    title: 'Cash advances and loans report',
    groups: [],
    about: 'What employees owe the business, what was released and collected in the period, how old the balances are and who owes most against their pay.',
  },
  custom: {
    label: 'Custom report',
    title: 'Custom payroll report',
    groups: ['month', 'department', 'position', 'employee', 'pay_type', 'run_type'],
    about: 'Any payslip figures, grouped your way. Pick the columns below; the first one is charted.',
  },
}
const REPORT_KEYS = Object.keys(REPORTS) as ReportKey[]
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

interface Data {
  key: string
  people: PersonRow[]
  slips: SlipFact[]
  days: DayFact[]
  leave?: { requests: LeaveRow[]; types: Pick<LeaveType, 'id' | 'code' | 'name' | 'paid' | 'default_annual_days' | 'min_service_months' | 'active'>[]; entitlements: EntitlementRow[] }
  advances?: { deductions: AdvanceRow[]; repayments: RepaymentRow[] }
}

export default function Insights({ entity }: { entity: Entity }) {
  const today = todayManila()
  const thisMonth = today.slice(0, 7)
  const [params, setParams] = useSearchParams()
  const set = useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '') next.delete(k)
            else next.set(k, v)
          }
          return next
        },
        { replace: true },
      ),
    [setParams],
  )

  const report = (REPORT_KEYS as string[]).includes(params.get('r') ?? '') ? (params.get('r') as ReportKey) : 'cost'
  const def = REPORTS[report]
  const presetParam = params.get('p') ?? 'last_6'
  const preset: PresetKey | 'custom' = presetParam === 'custom' || presetParam in PRESETS ? (presetParam as PresetKey | 'custom') : 'last_6'
  const [rFrom, rTo] = (() => {
    if (preset !== 'custom') {
      const r = presetRange(preset, today)
      return [r.from, r.to]
    }
    const a = MONTH_RE.test(params.get('from') ?? '') ? params.get('from')! : presetRange('last_6', today).from
    const b = MONTH_RE.test(params.get('to') ?? '') ? params.get('to')! : thisMonth
    return a <= b ? [a, b] : [b, a]
  })()
  const range: MonthRange = useMemo(() => ({ from: rFrom, to: rTo }), [rFrom, rTo])
  const by = (def.groups as string[]).includes(params.get('by') ?? '') ? (params.get('by') as GroupBy) : def.groups[0]
  const department = params.get('dept') ?? ''
  const measureKeys = useMemo(() => {
    const picked = (params.get('m') ?? '').split(',').filter((k) => MEASURES.some((m) => m.key === k))
    return picked.length ? picked : DEFAULT_MEASURES
  }, [params])

  // what to load: the pay reports share their payslips
  const kind = report === 'cost' || report === 'overtime' || report === 'custom' ? 'pay' : report
  // the advances report also looks at each employee's latest payrolls
  const advancesFrom = [range.from, addMonths(`${thisMonth}-01`, -6).slice(0, 7)].sort()[0]
  const dataKey = `${entity.id}|${kind}|${kind === 'headcount' ? '' : `${range.from}|${range.to}`}`
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setError('')
    try {
      const year = Number(today.slice(0, 4))
      const [people, slips, attendance, leave, advances] = await Promise.all([
        fetchPeople(entity.id),
        kind === 'pay'
          ? fetchSlipFacts(entity.id, range)
          : kind === 'advances'
            ? fetchSlipFacts(entity.id, { from: advancesFrom, to: range.to > thisMonth ? range.to : thisMonth })
            : Promise.resolve([] as SlipFact[]),
        kind === 'attendance' ? fetchAttendance(entity.id, range) : Promise.resolve(null),
        kind === 'leave'
          ? fetchLeave(
              entity.id,
              [rangeStart(range), `${year}-01-01`].sort()[0],
              [rangeEnd(range), `${year}-12-31`].sort()[1],
              year,
            )
          : Promise.resolve(undefined),
        kind === 'advances' ? fetchAdvances(entity.id) : Promise.resolve(undefined),
      ])
      if (my !== seq.current) return
      setData({
        key: dataKey,
        people,
        slips: attendance ? attendance.slips : slips,
        days: attendance ? attendance.days : [],
        leave,
        advances,
      })
    } catch (err) {
      if (my === seq.current) setError(errorMessage(err, 'Could not load the report'))
    }
  }, [dataKey, entity.id, kind, range, advancesFrom, thisMonth, today])

  useEffect(() => {
    load()
  }, [load])

  const departments = useMemo(() => {
    const s = new Set<string>()
    for (const e of data?.people ?? []) s.add(noDepartment(e.department.trim()))
    for (const f of data?.slips ?? []) s.add(noDepartment(f.department))
    return [...s].sort()
  }, [data])

  const built = useMemo((): Report | null => {
    if (!data || data.key !== dataKey) return null
    const inDept = <T extends { department: string }>(xs: T[]) => (department ? xs.filter((x) => noDepartment(x.department) === department) : xs)
    const pay = {
      workingDaysPerYear: Number(entity.working_days_divisor) || 261,
      minimumWageDaily: Number(entity.minimum_wage_daily) || 0,
      minimumWageRegion: entity.minimum_wage_region,
    }
    switch (report) {
      case 'cost':
        return costReport(inDept(data.slips), range, by)
      case 'overtime':
        return overtimeReport(inDept(data.slips), range, by, { standardHours: Number(entity.standard_hours_per_day) || 8, workingDaysPerYear: pay.workingDaysPerYear })
      case 'custom':
        return customReport(inDept(data.slips), range, by, measureKeys)
      case 'attendance':
        return attendanceReport(inDept(data.days), inDept(data.slips), range, by)
      case 'headcount':
        return headcountReport(data.people, range, today, pay, department)
      case 'leave':
        return data.leave ? leaveReport(data.leave.requests, data.leave.types, data.people, data.leave.entitlements, range, by, today, pay, department) : null
      case 'advances':
        return data.advances ? advancesReport(data.advances.deductions, data.advances.repayments, data.slips, data.people, range, today, pay, department) : null
    }
  }, [data, dataKey, report, range, by, department, measureKeys, entity, today])

  // a refetch keeps the last report on screen, dimmed
  const [last, setLast] = useState<Report | null>(null)
  if (built && built !== last) setLast(built)
  const shown = built ?? last
  const loading = !built && !error

  const period = `${rangeLabel(range)}${department ? ` · ${department}` : ''}${def.groups.length ? ` · by ${GROUP_LABELS[by].toLowerCase()}` : ''}`
  const company = { name: entity.name, registered_address: entity.registered_address, tin: entity.tin, tin_branch_code: entity.tin_branch_code }
  const slug = def.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Report" className="w-full sm:w-auto">
            <Select value={report} onChange={(e) => set({ r: e.target.value, by: null })} className="w-full sm:w-56">
              {REPORT_KEYS.map((k) => (
                <option key={k} value={k}>{REPORTS[k].label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Period" className="w-full sm:w-auto">
            <Select
              value={preset}
              onChange={(e) =>
                set(e.target.value === 'custom' ? { p: 'custom', from: range.from, to: range.to } : { p: e.target.value, from: null, to: null })
              }
              className="w-full sm:w-44"
            >
              {Object.entries(PRESETS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
              <option value="custom">Choose months…</option>
            </Select>
          </Field>
          {preset === 'custom' && (
            <>
              <Field label="From">
                <Input type="month" value={range.from} max={thisMonth} onChange={(e) => MONTH_RE.test(e.target.value) && set({ from: e.target.value })} className="w-40" />
              </Field>
              <Field label="To">
                <Input type="month" value={range.to} onChange={(e) => MONTH_RE.test(e.target.value) && set({ to: e.target.value })} className="w-40" />
              </Field>
            </>
          )}
          {def.groups.length > 0 && (
            <Field label="Group by" className="w-full sm:w-auto">
              <Select value={by} onChange={(e) => set({ by: e.target.value })} className="w-full sm:w-40">
                {def.groups.map((g) => (
                  <option key={g} value={g}>{GROUP_LABELS[g]}</option>
                ))}
              </Select>
            </Field>
          )}
          {departments.length > 1 && (
            <Field label="Department" className="w-full sm:w-auto">
              <Select value={department} onChange={(e) => set({ dept: e.target.value })} className="w-full sm:w-44">
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="secondary" disabled={!built} onClick={() => built && downloadCsv(`${slug}_${entity.code}_${range.from}_${range.to}.csv`, reportCsv(def.title, period, built))}>
              <Download className="size-4" /> CSV
            </Button>
            <Button variant="secondary" disabled={!built} onClick={() => built && generateInsightsPdf(company, def.title, period, built)}>
              <FileDown className="size-4" /> PDF
            </Button>
          </div>
        </div>
        {report === 'custom' && (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="mb-2 text-xs font-semibold text-slate-600">Columns ({measureKeys.length} of up to 8; the first is charted)</p>
            <div className="flex flex-wrap gap-1.5">
              {MEASURES.map((m) => {
                const on = measureKeys.includes(m.key)
                return (
                  <button
                    key={m.key}
                    type="button"
                    aria-pressed={on}
                    disabled={!on && measureKeys.length >= 8}
                    onClick={() => {
                      const next = on ? measureKeys.filter((k) => k !== m.key) : [...measureKeys, m.key]
                      set({ m: (next.length ? next : DEFAULT_MEASURES).join(',') })
                    }}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-40 ${
                      on ? 'bg-ink-900 text-white' : 'bg-slate-100 text-slate-600 hover:text-ink-900'
                    }`}
                  >
                    {on && measureKeys[0] === m.key ? '★ ' : ''}
                    {m.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">{def.about}</p>
      </Card>

      {error ? (
        <LoadFailed message={error} onRetry={load} />
      ) : !shown ? (
        <Spinner />
      ) : (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-50' : ''}`} aria-busy={loading}>
          <StatGroup>
            {shown.kpis.map((k) => (
              <StatCard key={k.label} label={k.label} value={k.value} sub={k.sub} tone={k.tone === 'default' ? undefined : k.tone} />
            ))}
          </StatGroup>

          {shown.insights.length > 0 && (
            <Card title="What stands out" icon={<Lightbulb />}>
              <ul className="space-y-2.5">
                {shown.insights.map((i, n) => (
                  <li key={n} className="flex items-start gap-2.5 text-sm text-slate-700">
                    {i.tone === 'warn' ? (
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label="Needs attention" />
                    ) : i.tone === 'good' ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-leaf-600" aria-label="Good" />
                    ) : (
                      <Info className="mt-0.5 size-4 shrink-0 text-slate-400" aria-label="Note" />
                    )}
                    <span>{i.text}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {shown.charts.length > 0 && (
            <div className={`grid gap-5 ${shown.charts.length > 1 ? 'xl:grid-cols-2' : ''}`}>
              {shown.charts.map((c) => (
                <InsightChart key={c.title} chart={c} />
              ))}
            </div>
          )}

          {shown.tables.map((t) => (
            <ReportTable key={t.title} table={t} />
          ))}
        </div>
      )}
    </div>
  )
}

function ReportTable({ table: t }: { table: Table }) {
  const right = (kind: string) => kind !== 'text'
  return (
    <section>
      <h3 className="mb-2 text-sm font-bold text-ink-900">{t.title}</h3>
      {t.rows.length === 0 ? (
        <p className="rounded-xl border border-slate-200/80 bg-white px-5 py-6 text-sm text-slate-500">{t.empty ?? 'Nothing to show.'}</p>
      ) : (
        <TableShell>
          <thead>
            <tr>
              {t.columns.map((c) => (
                <Th key={c.key} className={right(c.kind) ? 'text-right' : ''}>{c.label}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i}>
                {t.columns.map((c, j) => (
                  <Td key={c.key} className={`${right(c.kind) ? 'text-right tabular-nums' : ''} ${j === 0 ? 'whitespace-nowrap font-semibold text-ink-900' : ''}`}>
                    {cellText(r[c.key], c.kind)}
                  </Td>
                ))}
              </tr>
            ))}
            {t.total && (
              <tr className="bg-slate-50">
                {t.columns.map((c) => (
                  <Td key={c.key} className={`font-bold text-ink-900 ${right(c.kind) ? 'text-right tabular-nums' : ''}`}>
                    {cellText(t.total![c.key], c.kind)}
                  </Td>
                ))}
              </tr>
            )}
          </tbody>
        </TableShell>
      )}
    </section>
  )
}
