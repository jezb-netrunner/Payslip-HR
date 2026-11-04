// Time In/Out report for the selected client: attendance over a date range
// as totals per employee and each one's daily time record (DTR), on screen,
// as CSV, or as a printable PDF with signature lines. Figures come from
// payroll's own day computation (src/lib/timeReport.ts), so they match what
// payroll pays and docks.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, Download, FileDown, Pencil } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadFailed,
  Modal,
  Select,
  Spinner,
  StatCard,
  StatGroup,
  TableShell,
  Td,
  Th,
} from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadBlob, downloadCsv, getEmployees, getHolidaysBetween } from '../../lib/api'
import { logActivity } from '../../lib/activity'
import type { Employee, Entity, Holiday, PayrollRun } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtHours, fmtPeriod, fullName, plural } from '../../lib/format'
import { FREQUENCY_LABELS, RUN_TYPE_LABELS } from '../../lib/labels'
import { addDays, endOfMonth, todayManila } from '../../lib/manila'
import { suggestPeriod } from '../../lib/payPeriods'
import { fetchScheduleRows, resolversFor, type ScheduleRows } from '../../lib/schedules'
import { supabase } from '../../lib/supabase'
import {
  buildTimeReport,
  dayName,
  detailCsv,
  pairTimes,
  shortDate,
  sumTotals,
  summaryCsv,
  type EmployeeTimeReport,
  type ReportDay,
  type ReportEntry,
  type ReportLeave,
  type ReportTotals,
} from '../../lib/timeReport'
import { buildDtrDoc, buildTimeSummaryDoc, timeReportFileName } from '../../pdf/timeReportPdf'
import type { PayFrequency } from '../../payroll/types'
import { useReportStamp } from '../../lib/useReportStamp'

/** Dates (and pay frequency) to open the report with, e.g. from a pay run. */
export interface ReportPreset {
  from?: string
  to?: string
  frequency?: PayFrequency
}

type RunPick = Pick<PayrollRun, 'id' | 'run_type' | 'pay_frequency' | 'period_start' | 'period_end' | 'status'>

interface PeriodOption {
  key: string
  label: string
  from: string
  to: string
  frequency?: PayFrequency
}

interface ReportData {
  from: string
  to: string
  entries: ReportEntry[]
  leaves: ReportLeave[]
  holidays: Holiday[]
  schedules: ScheduleRows
}

/** A year of days at most: longer ranges are slow to load and unreadable on screen. */
const MAX_DAYS = 366

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1
}

function employedBetween(e: Employee, from: string, to: string): boolean {
  return e.hire_date <= to && (!e.separation_date || e.separation_date >= from)
}

/**
 * The pay period being worked on: the regular run covering today (a draft
 * being prepared included), else the period after the last one that ended
 * before today — stepped forward past any periods nobody ran.
 */
function currentCutoff(runs: RunPick[], frequency: PayFrequency, today: string): { start: string; end: string } {
  const regular = runs
    .filter((r) => r.run_type === 'regular' && r.pay_frequency === frequency)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
  const covering = regular.find((r) => r.period_start <= today && r.period_end >= today)
  if (covering) return { start: covering.period_start, end: covering.period_end }
  let previous: { period_end: string }[] = regular.filter((r) => r.period_end < today)
  let next = suggestPeriod(frequency, previous, today)
  for (let i = 0; i < 60 && next.end < today; i++) {
    previous = [{ period_end: next.end }, ...previous]
    next = suggestPeriod(frequency, previous, today)
  }
  return next
}

export default function TimeReport({
  entity,
  preset,
  onEditTimes,
}: {
  entity: Entity
  preset?: ReportPreset | null
  /** open the employee's time in/out sheet for a date range */
  onEditTimes: (employeeId: string, from: string, to: string) => void
}) {
  const today = todayManila()
  const [employees, setEmployees] = useState<Employee[] | null>(null)
  const [runs, setRuns] = useState<RunPick[]>([])
  const [setupError, setSetupError] = useState('')
  const [period, setPeriod] = useState(preset?.from && preset.to ? 'custom' : '')
  const [from, setFrom] = useState(preset?.from && preset.to ? preset.from : '')
  const [to, setTo] = useState(preset?.from && preset.to ? preset.to : '')
  const [frequency, setFrequency] = useState<PayFrequency | ''>(preset?.frequency ?? '')
  const [employeeId, setEmployeeId] = useState('')
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [exporting, setExporting] = useState(false)
  const seq = useRef(0)
  // dates given (a pay run's link) or defaulted once: a retry must not reset them
  const dated = useRef(!!(preset?.from && preset.to))

  const loadSetup = useCallback(async () => {
    setSetupError('')
    try {
      const [emps, { data: r, error }] = await Promise.all([
        getEmployees(entity.id),
        supabase
          .from('payroll_runs')
          .select('id, run_type, pay_frequency, period_start, period_end, status')
          .eq('entity_id', entity.id)
          .neq('run_type', 'thirteenth_month')
          .order('period_start', { ascending: false })
          .order('id')
          .limit(24),
      ])
      if (error) throw error
      const list = (r ?? []) as RunPick[]
      setEmployees(emps)
      setRuns(list)
      // a pay run's link: show it as that run in the period list
      const linked = preset?.from && preset.to ? list.find((x) => x.period_start === preset.from && x.period_end === preset.to) : undefined
      if (linked) setPeriod((cur) => (cur === 'custom' ? `run:${linked.id}` : cur))
      if (!dated.current) {
        // no dates given: open on the cutoff being worked on
        dated.current = true
        const current = currentCutoff(list, entity.default_pay_frequency, todayManila())
        setPeriod('current')
        setFrom(current.start)
        setTo(current.end)
      }
    } catch (err) {
      setSetupError(errorMessage(err, 'Could not load the employees'))
    }
  }, [entity.id, entity.default_pay_frequency, preset])

  useEffect(() => {
    loadSetup()
  }, [loadSetup])

  const options = useMemo((): PeriodOption[] => {
    const current = currentCutoff(runs, entity.default_pay_frequency, today)
    const thisMonth = `${today.slice(0, 7)}-01`
    const lastMonth = `${addDays(thisMonth, -1).slice(0, 7)}-01`
    return [
      { key: 'current', label: `Current cutoff · ${fmtPeriod(current.start, current.end)}`, from: current.start, to: current.end },
      { key: 'this_month', label: `This month · ${fmtPeriod(thisMonth, endOfMonth(thisMonth))}`, from: thisMonth, to: endOfMonth(thisMonth) },
      { key: 'last_month', label: `Last month · ${fmtPeriod(lastMonth, endOfMonth(lastMonth))}`, from: lastMonth, to: endOfMonth(lastMonth) },
      ...runs.map((r) => ({
        key: `run:${r.id}`,
        label: `${fmtPeriod(r.period_start, r.period_end)} · ${RUN_TYPE_LABELS[r.run_type]}${r.pay_frequency ? `, ${FREQUENCY_LABELS[r.pay_frequency].toLowerCase()}` : ''}${r.status === 'draft' ? ' (draft)' : ''}`,
        from: r.period_start,
        to: r.period_end,
        frequency: r.pay_frequency ?? undefined,
      })),
    ]
  }, [runs, today, entity.default_pay_frequency])

  function pickPeriod(key: string) {
    setPeriod(key)
    const o = options.find((x) => x.key === key)
    if (!o) return
    setFrom(o.from)
    setTo(o.to)
    // a pay run's people; one employee's record just moves to the run's dates
    if (key.startsWith('run:') && !employeeId) setFrequency(o.frequency ?? '')
  }

  const rangeProblem = !from || !to ? '' : to < from ? 'The end date is before the start date.' : daysBetween(from, to) > MAX_DAYS ? 'Choose a range of up to one year.' : ''

  // every employee's days at once: switching between the summary and one
  // person's record needs no new request
  const load = useCallback(async () => {
    if (!from || !to || rangeProblem) return
    const my = ++seq.current
    setLoading(true)
    setLoadError('')
    try {
      const [entries, leaves, holidays, schedules] = await Promise.all([
        fetchAll<ReportEntry>((f, t) =>
          supabase
            .from('time_entries')
            .select('employee_id, work_date, clock_in, clock_out, flags')
            .eq('entity_id', entity.id)
            .gte('work_date', from)
            .lte('work_date', to)
            .order('work_date')
            .order('id')
            .range(f, t),
        ),
        fetchAll<{ employee_id: string; start_date: string; end_date: string; leave_types: { name: string; paid: boolean } | null }>((f, t) =>
          supabase
            .from('leave_requests')
            .select('employee_id, start_date, end_date, leave_types(name, paid)')
            .eq('entity_id', entity.id)
            .eq('status', 'approved')
            .lte('start_date', to)
            .gte('end_date', from)
            .order('id')
            .range(f, t),
        ),
        getHolidaysBetween(entity.id, from, to),
        fetchScheduleRows({ entityId: entity.id }, from, to),
      ])
      if (my !== seq.current) return
      setData({
        from,
        to,
        entries,
        holidays,
        schedules,
        leaves: leaves.map((l) => ({
          employee_id: l.employee_id,
          start_date: l.start_date,
          end_date: l.end_date,
          name: l.leave_types?.name ?? 'Leave',
          paid: l.leave_types?.paid ?? false,
        })),
      })
    } catch (err) {
      if (my === seq.current) setLoadError(errorMessage(err, 'Could not load attendance'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [entity.id, from, to, rangeProblem])

  useEffect(() => {
    load()
  }, [load])

  const inRange = useMemo(
    () => (employees ?? []).filter((e) => employedBetween(e, from, to) && (!frequency || e.pay_frequency === frequency)),
    [employees, from, to, frequency],
  )
  const frequencies = new Set((employees ?? []).map((e) => e.pay_frequency))
  const current = data && data.from === from && data.to === to ? data : null
  const reports = useMemo(
    () =>
      current
        ? buildTimeReport({
            from,
            to,
            today,
            employees: employeeId ? inRange.filter((e) => e.id === employeeId) : inRange,
            entries: current.entries,
            leaves: current.leaves,
            holidays: current.holidays,
            schedules: resolversFor(inRange, current.schedules),
            standardHoursPerDay: Number(entity.standard_hours_per_day) || 8,
            gracePeriodMinutes: Number(entity.grace_period_minutes) || 0,
            workingDaysDivisor: Number(entity.working_days_divisor) || 261,
          })
        : [],
    [current, from, to, today, employeeId, inRange, entity.standard_hours_per_day, entity.grace_period_minutes, entity.working_days_divisor],
  )
  const totals = sumTotals(reports)
  const single = employeeId ? (reports[0] ?? null) : null
  const editUntil = (r: EmployeeTimeReport) => (r.to > today && r.from <= today ? today : r.to)

  if (setupError) return <LoadFailed message={setupError} onRetry={loadSetup} />
  if (!employees) return <Spinner />

  const missing = reports.filter((r) => r.totals.missingTimeOut > 0)
  // a finalized payroll keeps what it paid; this report recomputes with today's settings
  const paidRuns = runs.filter((r) => (r.status === 'finalized' || r.status === 'paid') && r.period_start <= to && r.period_end >= from)

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Period" className="w-full sm:w-auto">
            <Select value={period} onChange={(e) => pickPeriod(e.target.value)} className="w-full sm:w-80">
              {options.slice(0, 3).map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
              {options.length > 3 && (
                <optgroup label="Pay runs">
                  {options.slice(3).map((o) => (
                    <option key={o.key} value={o.key}>{o.label}</option>
                  ))}
                </optgroup>
              )}
              <option value="custom">Custom dates</option>
            </Select>
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPeriod('custom')
              }}
              className="w-40"
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
                setPeriod('custom')
              }}
              className="w-40"
            />
          </Field>
          {(frequencies.size > 1 || frequency) && (
            <Field label="Pay frequency">
              <Select
                value={frequency}
                onChange={(e) => {
                  setFrequency(e.target.value as PayFrequency | '')
                  setEmployeeId('')
                }}
                className="w-40"
              >
                <option value="">All</option>
                {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Employee" className="w-full sm:w-auto">
            <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="w-full sm:w-64">
              <option value="">All employees ({inRange.length})</option>
              {inRange.map((e) => (
                <option key={e.id} value={e.id}>
                  {fullName(e)} ({e.employee_no})
                </option>
              ))}
            </Select>
          </Field>
          <Button className="sm:ml-auto" variant="secondary" disabled={reports.length === 0} onClick={() => setExporting(true)}>
            <Download className="size-4" /> Download
          </Button>
        </div>
        {to > today && !rangeProblem && from <= to && (
          <p className="mt-3 text-xs text-slate-500">
            Days after today ({shortDate(addDays(today, 1))} onward) count as neither worked nor absent.
          </p>
        )}
      </Card>

      {!from || !to ? (
        <Card><EmptyState title="Choose the start and end dates" /></Card>
      ) : rangeProblem ? (
        <Card><EmptyState title={rangeProblem} /></Card>
      ) : loadError ? (
        <LoadFailed message={loadError} onRetry={load} />
      ) : loading || !current ? (
        <Spinner />
      ) : employeeId && !single ? (
        <Card>
          <EmptyState title="Not employed in this period" sub="Pick other dates, or another employee." />
          <div className="flex justify-center">
            <Button variant="secondary" onClick={() => setEmployeeId('')}>All employees</Button>
          </div>
        </Card>
      ) : reports.length === 0 ? (
        <Card><EmptyState title="No employees in this period" sub="Nobody matching the filters was employed between these dates." /></Card>
      ) : (
        <>
          <StatGroup>
            {!single && <StatCard label="Employees" value={reports.length} />}
            <StatCard label="Days worked" value={totals.daysWorked} sub={`${plural(totals.workdays, 'workday')} to date${totals.restDaysWorked ? ` · ${plural(totals.restDaysWorked, 'rest day')} worked` : ''}`} />
            <StatCard label="Hours worked" value={fmtHours(totals.workedMinutes)} sub={`${fmtHours(totals.otMinutes)} overtime · net of breaks`} />
            <StatCard label="Late" value={plural(totals.lateDays, 'time')} sub={`${totals.lateMinutes} min in total`} tone={totals.lateDays ? 'warn' : 'default'} />
            <StatCard
              label="Absences"
              value={totals.absences}
              sub={`${plural(totals.paidLeaveDays, 'day')} paid leave · ${totals.unpaidLeaveDays} unpaid`}
              tone={totals.absences ? 'bad' : 'default'}
            />
            <StatCard label="No time out" value={totals.missingTimeOut} sub="not counted by payroll" tone={totals.missingTimeOut ? 'warn' : 'default'} />
          </StatGroup>

          {paidRuns.length > 0 && (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              Part of this range was paid in finalized payrolls. This report recomputes it with today's holidays, grace
              period and leave settings; each payslip keeps what was actually paid. If a setting changed since, the two can
              differ.
            </p>
          )}
          {missing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              <p className="font-bold">Time in without a time out</p>
              <p className="mt-0.5 text-xs">
                Payroll doesn't count these days (a scheduled one is an absence) until the time out is entered.
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                {missing.slice(0, 8).map((r) => (
                  <li key={r.employee.id}>
                    <button
                      type="button"
                      onClick={() => onEditTimes(r.employee.id, r.from, editUntil(r))}
                      className="font-semibold underline hover:text-amber-950"
                    >
                      {fullName(r.employee)}
                    </button>
                    : {r.days.filter((d) => d.missingTimeOut).map((d) => shortDate(d.date)).join(', ')}
                  </li>
                ))}
                {missing.length > 8 && <li>…and {plural(missing.length - 8, 'more employee')}</li>}
              </ul>
            </div>
          )}

          {single ? (
            <DailyRecord report={single} onBack={() => setEmployeeId('')} onEdit={() => onEditTimes(single.employee.id, single.from, editUntil(single))} />
          ) : (
            <SummaryTable
              reports={reports}
              totals={totals}
              from={from}
              to={to}
              onOpen={setEmployeeId}
              onEdit={(r) => onEditTimes(r.employee.id, r.from, editUntil(r))}
            />
          )}
          <p className="text-[11px] text-slate-400">
            Computed the way payroll computes attendance: hours are net of the unpaid break, lateness is waived when
            the standard day is completed, overtime counts beyond the standard day, and a scheduled workday without
            a complete time in/out or approved leave is an absence. Days before a hire or after a separation are left
            out. Times are Philippine time.
          </p>
        </>
      )}

      {exporting && (
        <ExportModal
          reports={reports}
          entity={entity}
          from={from}
          to={to}
          single={!!single}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  )
}

/** One line of a period's figures, for rows too narrow for the figure columns. */
function figuresLine(t: ReportTotals): string {
  return [
    `${t.daysWorked} of ${plural(t.workdays, 'workday')}`,
    fmtHours(t.workedMinutes),
    ...(t.otMinutes ? [`${fmtHours(t.otMinutes)} OT`] : []),
    ...(t.lateDays ? [`late ${plural(t.lateDays, 'time')}`] : []),
    ...(t.absences ? [plural(t.absences, 'absence')] : []),
    ...(t.paidLeaveDays + t.unpaidLeaveDays ? [`${plural(t.paidLeaveDays + t.unpaidLeaveDays, 'leave day')}`] : []),
  ].join(' · ')
}

function SummaryTable({
  reports,
  totals,
  from,
  to,
  onOpen,
  onEdit,
}: {
  reports: EmployeeTimeReport[]
  totals: ReportTotals
  from: string
  to: string
  onOpen: (employeeId: string) => void
  onEdit: (r: EmployeeTimeReport) => void
}) {
  const leave = (t: ReportTotals) =>
    t.paidLeaveDays || t.unpaidLeaveDays ? `${t.paidLeaveDays} paid${t.unpaidLeaveDays ? ` · ${t.unpaidLeaveDays} unpaid` : ''}` : '—'
  // below md the figures move under the name; night diff and undertime need xl, leave 2xl
  const wide = 'hidden whitespace-nowrap text-right md:table-cell'
  const wider = 'hidden whitespace-nowrap text-right xl:table-cell'
  const widest = 'hidden whitespace-nowrap text-right 2xl:table-cell'
  return (
    <TableShell>
      <thead>
        <tr>
          <Th>Employee</Th>
          <Th className={wide}>Days worked</Th>
          <Th className={wide}>Hours</Th>
          <Th className={wide}>Overtime</Th>
          <Th className={wider}>Night diff</Th>
          <Th className={wide}>Late</Th>
          <Th className={wider}>Undertime</Th>
          <Th className={wide}>Absent</Th>
          <Th className={widest}>Leave</Th>
          <Th></Th>
        </tr>
      </thead>
      <tbody>
        {reports.map((r) => {
          const t = r.totals
          return (
            <tr key={r.employee.id} className="cursor-pointer" onClick={() => onOpen(r.employee.id)}>
              <Td className="min-w-[11rem]">
                <p className="font-semibold text-ink-900">{fullName(r.employee)}</p>
                <p className="text-xs text-slate-400">
                  {r.employee.employee_no}
                  {r.employee.position ? ` · ${r.employee.position}` : ''}
                </p>
                {/* hired or separated within the range: only the days employed count */}
                {(r.from !== from || r.to !== to) && <p className="text-[11px] text-slate-500">employed {fmtPeriod(r.from, r.to)}</p>}
                <p className="mt-1 text-xs text-slate-600 md:hidden">{figuresLine(t)}</p>
                {t.missingTimeOut > 0 && (
                  <p className="mt-0.5 text-xs font-medium text-amber-700">{plural(t.missingTimeOut, 'day')} without a time out</p>
                )}
              </Td>
              <Td className={wide}>
                <p className="font-semibold text-ink-900">{t.daysWorked}</p>
                <p className="text-xs text-slate-400">of {plural(t.workdays, 'workday')}</p>
              </Td>
              <Td className={wide}>{fmtHours(t.workedMinutes)}</Td>
              <Td className={wide}>{t.otMinutes ? fmtHours(t.otMinutes) : '—'}</Td>
              <Td className={wider}>{t.nightDiffMinutes ? fmtHours(t.nightDiffMinutes) : '—'}</Td>
              <Td className={wide}>
                {t.lateDays ? (
                  <>
                    <p>{plural(t.lateDays, 'time')}</p>
                    <p className="text-xs text-slate-400">{t.lateMinutes} min</p>
                  </>
                ) : (
                  '—'
                )}
              </Td>
              <Td className={wider}>{t.undertimeMinutes ? `${t.undertimeMinutes} min` : '—'}</Td>
              <Td className={`${wide} ${t.absences ? 'font-semibold text-rose-600' : ''}`}>{t.absences}</Td>
              <Td className={`${widest} text-xs`}>{leave(t)}</Td>
              <Td>
                <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <IconButton size="sm" label={`${fullName(r.employee)}'s daily time record`} onClick={() => onOpen(r.employee.id)}>
                    <CalendarDays className="size-4" />
                  </IconButton>
                  <IconButton size="sm" label={`Edit ${fullName(r.employee)}'s time in / out`} onClick={() => onEdit(r)}>
                    <Pencil className="size-4" />
                  </IconButton>
                </div>
              </Td>
            </tr>
          )
        })}
        <tr className="bg-slate-50 font-bold">
          <Td>
            Total
            <p className="mt-1 text-xs font-medium text-slate-600 md:hidden">{figuresLine(totals)}</p>
          </Td>
          <Td className={wide}>{totals.daysWorked}</Td>
          <Td className={wide}>{fmtHours(totals.workedMinutes)}</Td>
          <Td className={wide}>{fmtHours(totals.otMinutes)}</Td>
          <Td className={wider}>{fmtHours(totals.nightDiffMinutes)}</Td>
          <Td className={wide}>{totals.lateMinutes} min</Td>
          <Td className={wider}>{totals.undertimeMinutes} min</Td>
          <Td className={wide}>{totals.absences}</Td>
          <Td className={`${widest} text-xs`}>{leave(totals)}</Td>
          <Td></Td>
        </tr>
      </tbody>
    </TableShell>
  )
}

function DayRemarks({ day }: { day: ReportDay }) {
  return (
    <div className="flex flex-wrap gap-1">
      {day.holiday && <Badge tone={day.holiday.kind === 'regular' ? 'red' : 'amber'}>{day.holiday.name}</Badge>}
      {!day.scheduled && <Badge tone="slate">rest day</Badge>}
      {day.leave && <Badge tone="violet">{day.leave.name}{day.leave.paid ? '' : ' (unpaid)'}</Badge>}
      {day.absent && <Badge tone="red">absent</Badge>}
      {day.missingTimeOut && <Badge tone="amber">no time out</Badge>}
      {day.corrected && <Badge tone="blue">corrected on request</Badge>}
    </div>
  )
}

/** A day's figures past its hours worked ("30m OT · 25 min late"). */
function extrasLine(d: ReportDay, nightDiff = true): string {
  return [
    ...(d.otMinutes ? [`${fmtHours(d.otMinutes)} OT`] : []),
    ...(nightDiff && d.nightDiffMinutes ? [`${fmtHours(d.nightDiffMinutes)} ND`] : []),
    ...(d.lateMinutes ? [`${d.lateMinutes} min late`] : []),
    ...(d.undertimeMinutes ? [`${d.undertimeMinutes} min undertime`] : []),
  ].join(' · ')
}

function DailyRecord({ report, onBack, onEdit }: { report: EmployeeTimeReport; onBack: () => void; onEdit: () => void }) {
  const e = report.employee
  const t = report.totals
  const shaded = (d: ReportDay) => (!d.scheduled || d.holiday ? 'bg-slate-50/70' : '')
  const totalsText = `${plural(t.daysWorked, 'day')} worked of ${plural(t.workdays, 'workday')} · ${plural(t.absences, 'absence')}${
    t.paidLeaveDays + t.unpaidLeaveDays > 0 ? ` · ${plural(t.paidLeaveDays + t.unpaidLeaveDays, 'leave day')}` : ''
  }`
  // overtime, lateness and undertime get their own columns from xl, night diff from 2xl;
  // narrower, they sit under the hours worked
  const xl = 'hidden whitespace-nowrap text-right xl:table-cell'
  return (
    <Card
      title={
        <span>
          {fullName(e)} <span className="text-sm font-normal text-slate-400">{e.employee_no}</span>
        </span>
      }
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="size-4" /> All employees
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="size-4" /> Edit time in / out
          </Button>
        </div>
      }
    >
      <p className="-mt-2 mb-4 text-xs text-slate-500">
        {report.schedule} · {fmtPeriod(report.from, report.to)}
      </p>

      {/* phones: a list, one day per item */}
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 md:hidden">
        {report.days.map((d) => {
          const extras = extrasLine(d)
          return (
            <li key={d.date} className={`space-y-1 px-4 py-3 ${shaded(d)}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p>
                  <span className="font-semibold text-ink-900">{shortDate(d.date)}</span>{' '}
                  <span className="text-xs text-slate-400">{dayName(d.date)}</span>
                </p>
                {d.workedMinutes > 0 && <p className="text-sm font-semibold text-ink-900">{fmtHours(d.workedMinutes)}</p>}
              </div>
              {d.pairs.map((p, i) => {
                const x = pairTimes(p)
                return (
                  <p key={i} className="text-sm text-slate-700">
                    {x.timeIn} – <span className={p.timeOut === null ? 'text-amber-700' : ''}>{x.timeOut}</span>
                  </p>
                )
              })}
              {extras && <p className="text-xs text-slate-600">{extras}</p>}
              <DayRemarks day={d} />
            </li>
          )
        })}
        <li className="bg-slate-50 px-4 py-3 text-sm">
          <p className="font-bold text-ink-900">
            Total {fmtHours(t.workedMinutes)}
            {t.otMinutes > 0 && <span className="font-semibold"> · {fmtHours(t.otMinutes)} OT</span>}
          </p>
          <p className="text-xs text-slate-600">{totalsText}</p>
          {(t.lateMinutes > 0 || t.undertimeMinutes > 0) && (
            <p className="text-xs text-slate-600">
              {t.lateMinutes} min late · {t.undertimeMinutes} min undertime
            </p>
          )}
        </li>
      </ul>

      <div className="hidden md:block">
        <TableShell>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Time in</Th>
              <Th>Time out</Th>
              <Th className="text-right">Worked</Th>
              <Th className={xl}>OT</Th>
              <Th className="hidden text-right 2xl:table-cell">ND</Th>
              <Th className={xl}>Late</Th>
              <Th className={xl}>Undertime</Th>
              <Th>Remarks</Th>
            </tr>
          </thead>
          <tbody>
            {report.days.map((d) => {
              const times = d.pairs.map((p) => pairTimes(p))
              return (
                <tr key={d.date} className={shaded(d)}>
                  <Td className="whitespace-nowrap">
                    <span className="font-semibold text-ink-900">{shortDate(d.date)}</span>{' '}
                    <span className="text-xs text-slate-400">{dayName(d.date)}</span>
                  </Td>
                  <Td className="whitespace-nowrap">
                    {times.length ? times.map((x, i) => <p key={i}>{x.timeIn}</p>) : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {times.length
                      ? times.map((x, i) => (
                          <p key={i} className={d.pairs[i].timeOut === null ? 'text-amber-700' : ''}>{x.timeOut}</p>
                        ))
                      : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {d.workedMinutes ? fmtHours(d.workedMinutes) : ''}
                    <span className="block text-xs text-slate-500 xl:hidden">{extrasLine(d)}</span>
                    {d.nightDiffMinutes > 0 && (
                      <span className="hidden text-xs text-slate-500 xl:block 2xl:hidden">{fmtHours(d.nightDiffMinutes)} ND</span>
                    )}
                  </Td>
                  <Td className={xl}>{d.otMinutes ? fmtHours(d.otMinutes) : ''}</Td>
                  <Td className="hidden whitespace-nowrap text-right 2xl:table-cell">{d.nightDiffMinutes ? fmtHours(d.nightDiffMinutes) : ''}</Td>
                  <Td className={xl}>{d.lateMinutes ? `${d.lateMinutes} min` : ''}</Td>
                  <Td className={xl}>{d.undertimeMinutes ? `${d.undertimeMinutes} min` : ''}</Td>
                  <Td>
                    <DayRemarks day={d} />
                  </Td>
                </tr>
              )
            })}
            <tr className="bg-slate-50 font-bold">
              <Td>Total</Td>
              <Td colSpan={2} className="text-xs font-semibold text-slate-600">
                {plural(t.daysWorked, 'day')} worked of {plural(t.workdays, 'workday')}
              </Td>
              <Td className="whitespace-nowrap text-right">
                {fmtHours(t.workedMinutes)}
                <span className="block text-xs font-semibold text-slate-500 xl:hidden">
                  {[
                    ...(t.otMinutes ? [`${fmtHours(t.otMinutes)} OT`] : []),
                    ...(t.lateMinutes ? [`${t.lateMinutes} min late`] : []),
                    ...(t.undertimeMinutes ? [`${t.undertimeMinutes} min undertime`] : []),
                  ].join(' · ')}
                </span>
              </Td>
              <Td className={xl}>{fmtHours(t.otMinutes)}</Td>
              <Td className="hidden whitespace-nowrap text-right 2xl:table-cell">{fmtHours(t.nightDiffMinutes)}</Td>
              <Td className={xl}>{t.lateMinutes} min</Td>
              <Td className={xl}>{t.undertimeMinutes} min</Td>
              <Td className="text-xs font-semibold text-slate-600">
                {plural(t.absences, 'absence')}
                {t.paidLeaveDays + t.unpaidLeaveDays > 0 && ` · ${plural(t.paidLeaveDays + t.unpaidLeaveDays, 'leave day')}`}
              </Td>
            </tr>
          </tbody>
        </TableShell>
      </div>
    </Card>
  )
}

function ExportModal({
  reports,
  entity,
  from,
  to,
  single,
  onClose,
}: {
  reports: EmployeeTimeReport[]
  entity: Entity
  from: string
  to: string
  single: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const stamp = useReportStamp(entity)
  const [content, setContent] = useState<'summary' | 'dtr'>(single ? 'dtr' : 'summary')
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf')
  const [done, setDone] = useState<number | null>(null)
  const busy = done !== null

  async function download() {
    if (busy) return
    setDone(0)
    try {
      const stem = timeReportFileName(
        content === 'dtr' ? 'dtr' : 'time_summary',
        entity.code,
        from,
        to,
        single ? reports[0].employee.employee_no : undefined,
      )
      if (format === 'csv') downloadCsv(`${stem}.csv`, content === 'dtr' ? detailCsv(reports) : summaryCsv(reports), stamp(content === 'dtr' ? 'Daily time records' : 'Time summary'))
      else {
        const title = content === 'dtr' ? 'Daily time records' : 'Time summary'
        const doc = content === 'dtr' ? await buildDtrDoc(reports, entity, setDone, stamp(title)) : buildTimeSummaryDoc(reports, entity, from, to, stamp(title))
        downloadBlob(`${stem}.pdf`, doc.output('blob'))
        void logActivity('export', entity.id, { report: title, file: `${stem}.pdf`, from, to, employees: reports.length })
      }
      toast('success', 'Report downloaded.')
      onClose()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not prepare the report'))
      setDone(null)
    }
  }

  const option = (checked: boolean, onPick: () => void, title: string, sub: string) => (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
        checked ? 'border-brand-600 bg-brand-50/60' : 'border-slate-200 hover:bg-slate-50'
      }`}
    >
      <input type="radio" className="mt-0.5 size-4 accent-brand-700" checked={checked} disabled={busy} onChange={onPick} />
      <span>
        <span className="block text-sm font-semibold text-ink-900">{title}</span>
        <span className="block text-xs text-slate-500">{sub}</span>
      </span>
    </label>
  )

  const who = single ? fullName(reports[0].employee) : plural(reports.length, 'employee')
  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Download time in / out report">
      <div className="space-y-5">
        <p className="text-sm text-slate-600">
          {who} · {fmtPeriod(from, to)}
        </p>
        <Field group label="Report">
          <div className="space-y-2">
            {option(content === 'summary', () => setContent('summary'), 'Summary', 'One row per employee: days, hours, overtime, lateness, absences, leave')}
            {option(
              content === 'dtr',
              () => setContent('dtr'),
              'Daily time records (DTR)',
              format === 'pdf'
                ? 'Every day with its time in and out; a page per employee with signature lines'
                : 'Every day with its time in and out, one row per employee-day',
            )}
          </div>
        </Field>
        <Field group label="Format">
          <div className="space-y-2">
            {option(format === 'pdf', () => setFormat('pdf'), 'PDF', 'Ready to print, sign and file')}
            {option(format === 'csv', () => setFormat('csv'), 'CSV', 'Opens in Excel or Google Sheets')}
          </div>
        </Field>
        <Button className="w-full" disabled={busy} onClick={download}>
          <FileDown className="size-4" />
          {busy ? (content === 'dtr' && format === 'pdf' && reports.length > 10 ? `Preparing… ${done} of ${reports.length}` : 'Preparing…') : 'Download'}
        </Button>
      </div>
    </Modal>
  )
}
