// Admin-entered time in / time out. Two grids over the same row editor:
// one date for every employee (daily logbook entry), or one employee over a
// date range (a DTR for the cutoff). Each row is one in/out pair; a split
// shift adds pairs to the day. Times are Manila wall time; an out time
// earlier than the in time is the next morning (overnight shift). Approved
// leaves and holidays are shown and skipped by Fill. Paid periods are
// locked by the database. The Report tab (TimeReport.tsx) summarizes and
// prints the attendance of a period.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarDays, Check, FileChartColumn, FilePen, Lock, Save, UserRound, Wand2, X } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, NoClient, PageHeader, Select, Spinner, TableShell, Tabs, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, getHolidaysBetween, isActiveOn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, Holiday, TimeCorrectionRequest, TimeEntry } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtDateTime, fmtHours, fullName, plural } from '../../lib/format'
import { addDays, eachDate, hhmmToMinutes, manilaDateStr, manilaHHMM, manilaWallToIso, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { FREQUENCY_LABELS } from '../../lib/labels'
import { lockedKeys } from '../../lib/locks'
import { notifyPendingChanged, onPendingChanged } from '../../lib/pending'
import { fetchScheduleRows, resolversFor } from '../../lib/schedules'
import { shiftLabel } from '../../lib/shiftText'
import { unpaidBreak } from '../../payroll/schedule'
import type { PayFrequency, ScheduleResolver, Shift } from '../../payroll/types'
import TimeReport, { type ReportPreset } from './TimeReport'

interface SheetPreset {
  employeeId: string
  from?: string
  to?: string
}

// a real calendar date (2026-02-30 is not)
const isDate = (v: string | null) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : undefined
const isFrequency = (v: string | null) => (v && Object.keys(FREQUENCY_LABELS).includes(v) ? (v as PayFrequency) : undefined)

export default function Timesheets() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const [params, setParams] = useSearchParams()
  // "Edit time in / out" on an employee's Attendance tab opens their sheet for that month
  const [preset] = useState<SheetPreset | null>(() => {
    const employeeId = params.get('employee')
    return employeeId ? { employeeId, from: isDate(params.get('from')), to: isDate(params.get('to')) } : null
  })
  // ?tab=corrections (the dashboard's "corrections pending") opens the review queue;
  // ?tab=report&from&to&frequency (a pay run's "time report") the report for its period
  const [linkedTab] = useState(() => {
    const t = params.get('tab')
    return t === 'corrections' || t === 'report' ? t : null
  })
  const [reportPreset, setReportPreset] = useState<ReportPreset | null>(() =>
    linkedTab === 'report'
      ? { from: isDate(params.get('from')), to: isDate(params.get('to')), frequency: isFrequency(params.get('frequency')) }
      : null,
  )
  const [tab, setTab] = useState(linkedTab ?? (preset ? 'employee' : 'daily'))
  // the link's dates and frequency belong to the client it was opened for
  const linkedClient = useRef(entity?.id)
  useEffect(() => {
    if (entity?.id !== linkedClient.current) setReportPreset(null)
  }, [entity?.id])
  useEffect(() => {
    if (!preset && !linkedTab) return
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const k of ['employee', 'from', 'to', 'tab', 'frequency']) next.delete(k)
        return next
      },
      { replace: true },
    )
  }, [preset, linkedTab, setParams])
  // the report's "edit" links open an employee's sheet: a new sheet for each jump
  const [sheet, setSheet] = useState({ preset, n: 0 })
  const openSheet = useCallback((employeeId: string, from: string, to: string) => {
    setSheet((s) => ({ preset: { employeeId, from, to }, n: s.n + 1 }))
    setTab('employee')
  }, [])
  // pending correction requests, shown on their tab (the menu's red count lands on the daily sheet)
  const [pendingCount, setPendingCount] = useState<{ entityId: string; n: number } | null>(null)
  const [pendingTick, setPendingTick] = useState(0)
  useEffect(() => onPendingChanged(() => setPendingTick((n) => n + 1)), [])
  const entityId = entity?.id
  useEffect(() => {
    if (!entityId) return
    let stale = false
    supabase
      .from('time_correction_requests')
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', entityId)
      .eq('status', 'pending')
      .then(({ count }) => {
        if (!stale) setPendingCount({ entityId, n: count ?? 0 })
      })
    return () => {
      stale = true
    }
  }, [entityId, pendingTick])
  // unsaved edits in the open sheet: switching tabs or closing the page asks first
  const dirty = useRef(0)
  const onDirty = useCallback((n: number) => {
    dirty.current = n
  }, [])
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current > 0) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return (
    <div>
      <PageHeader
        title="Time In / Out"
        subtitle="Enter each employee's actual time in and time out (Philippine time). Attendance feeds payroll directly; paid periods lock automatically."
      />
      <Tabs
        tabs={[
          { key: 'daily', label: 'Daily sheet', icon: <CalendarDays /> },
          { key: 'employee', label: 'Per employee (cutoff)', icon: <UserRound /> },
          {
            key: 'corrections',
            label: 'Correction requests',
            icon: <FilePen />,
            count: pendingCount && pendingCount.entityId === entityId ? pendingCount.n : 0,
          },
          { key: 'report', label: 'Report', icon: <FileChartColumn /> },
        ]}
        active={tab}
        onChange={(t) => {
          if (t === tab) return
          if (dirty.current > 0 && !window.confirm(`Discard ${plural(dirty.current, 'unsaved change')}?`)) return
          dirty.current = 0
          // a pay run's link opens the report once; coming back shows the current cutoff
          if (tab === 'report') setReportPreset(null)
          setTab(t)
        }}
      />
      {tab === 'daily' && <DailySheet key={entity.id} entity={entity} onDirty={onDirty} />}
      {tab === 'employee' && <EmployeeSheet key={`${entity.id}:${sheet.n}`} entity={entity} onDirty={onDirty} preset={sheet.preset} />}
      {tab === 'corrections' && <Corrections key={entity.id} entity={entity} />}
      {tab === 'report' && <TimeReport key={entity.id} entity={entity} preset={reportPreset} onEditTimes={openSheet} />}
    </div>
  )
}

// ---------- shared row model ----------

/** An approved leave covering a row's date. */
interface LeaveMark {
  name: string
  paid: boolean
}

/** One time in/out pair. A day can hold several (split shift). */
interface Row {
  key: string
  /** employee|date — paid-period locks and leaves are per day */
  dayKey: string
  employee: Employee
  date: string
  /** the shift scheduled that date (null = rest day) */
  shift: Shift | null
  /** the break deducted from a day of 6 hours or more */
  breakMinutes: number
  entry: TimeEntry | null
  timeIn: string
  timeOut: string
  locked: boolean
  holiday?: Holiday
  leave?: LeaveMark
}

function rowKey(employeeId: string, date: string) {
  return `${employeeId}|${date}`
}


/** Holidays nobody is expected to work: a blank day there is not an absence. */
function isDayOff(h: Holiday | undefined): boolean {
  return !!h && h.kind !== 'special_working'
}

/** Minutes worked (before break) for an in/out pair; out ≤ in = next day. */
function spanMinutes(timeIn: string, timeOut: string): number | null {
  if (!timeIn || !timeOut) return null
  let m = hhmmToMinutes(timeOut) - hhmmToMinutes(timeIn)
  if (m <= 0) m += 1440
  return m
}

/** Approved leaves in a date range, by employee|date. */
async function leaveMarks(entityId: string, start: string, end: string, employeeId?: string): Promise<Map<string, LeaveMark>> {
  let q = supabase
    .from('leave_requests')
    .select('employee_id, start_date, end_date, leave_types(name, paid)')
    .eq('entity_id', entityId)
    .eq('status', 'approved')
    .lte('start_date', end)
    .gte('end_date', start)
  if (employeeId) q = q.eq('employee_id', employeeId)
  const { data, error } = await q
  if (error) throw error
  const out = new Map<string, LeaveMark>()
  for (const l of (data ?? []) as unknown as { employee_id: string; start_date: string; end_date: string; leave_types: { name: string; paid: boolean } | null }[]) {
    for (const d of eachDate(l.start_date > start ? l.start_date : start, l.end_date < end ? l.end_date : end)) {
      out.set(rowKey(l.employee_id, d), { name: l.leave_types?.name ?? 'Leave', paid: l.leave_types?.paid ?? false })
    }
  }
  return out
}

function buildRows(
  pairs: { employee: Employee; date: string }[],
  entries: TimeEntry[],
  locked: Set<string>,
  holidays: Holiday[],
  leaves: Map<string, LeaveMark>,
  schedules: Map<string, ScheduleResolver>,
): Row[] {
  const byKey = new Map<string, TimeEntry[]>()
  for (const t of entries) {
    const k = rowKey(t.employee_id, t.work_date)
    byKey.set(k, [...(byKey.get(k) ?? []), t].sort((a, b) => a.clock_in.localeCompare(b.clock_in)))
  }
  return pairs.flatMap(({ employee, date }): Row[] => {
    const dayKey = rowKey(employee.id, date)
    const list = byKey.get(dayKey) ?? []
    const sched = schedules.get(employee.id)?.(date)
    const shift = sched ? sched.shift : null
    const base = {
      dayKey,
      employee,
      date,
      shift,
      breakMinutes: unpaidBreak(shift ? shift.break_minutes : (sched?.restDayBreakMinutes ?? 60)),
      locked: locked.has(dayKey),
      holiday: holidays.find((h) => h.holiday_date === date),
      leave: leaves.get(dayKey),
    }
    if (list.length === 0) return [{ ...base, key: `${dayKey}|new`, entry: null, timeIn: '', timeOut: '' }]
    return list.map((entry) => ({
      ...base,
      key: `${dayKey}|${entry.id}`,
      entry,
      timeIn: manilaHHMM(entry.clock_in),
      timeOut: entry.clock_out ? manilaHHMM(entry.clock_out) : '',
    }))
  })
}

/** A blank extra pair for the same day, right after that day's last row. */
function withExtraPair(rows: Row[], after: Row): Row[] {
  const last = rows.map((r) => r.dayKey).lastIndexOf(after.dayKey)
  const extra: Row = { ...after, key: `${after.dayKey}|new${Date.now()}`, entry: null, timeIn: '', timeOut: '' }
  return [...rows.slice(0, last + 1), extra, ...rows.slice(last + 1)]
}

/** Fill blank rows of scheduled working days with the shift (not leaves, holidays or paid days). */
function filledWithSchedule(rows: Row[]): Row[] {
  const daysWithTimes = new Set(rows.filter((r) => r.timeIn || r.timeOut).map((r) => r.dayKey))
  return rows.map((r) =>
    !r.locked && !daysWithTimes.has(r.dayKey) && !r.leave && !isDayOff(r.holiday) && r.shift
      ? { ...r, timeIn: r.shift.start, timeOut: r.shift.end }
      : r,
  )
}

/**
 * Whether each row's time in falls on the day after its work date. A stored,
 * unchanged time keeps the day it was saved with (corrections may have put
 * it there). The day's first pair follows the schedule (a late start after
 * midnight on a 22:00–06:00 shift); a later pair that starts earlier on the
 * clock than the pair before it — or follows a pair already past midnight —
 * has crossed midnight. Rows must be grouped by day in display order.
 */
function nextDayFlags(rows: Row[]): Map<string, boolean> {
  const out = new Map<string, boolean>()
  let day = ''
  let prevIn: number | null = null
  let prevNext = false
  for (const r of rows) {
    if (r.dayKey !== day) {
      day = r.dayKey
      prevIn = null
      prevNext = false
    }
    if (!r.timeIn) {
      out.set(r.key, false)
      continue
    }
    let next: boolean
    if (r.entry && manilaHHMM(r.entry.clock_in) === r.timeIn) {
      next = manilaDateStr(new Date(r.entry.clock_in)) > r.date
    } else if (prevIn === null) {
      next = !!r.shift && hhmmToMinutes(r.shift.end) <= hhmmToMinutes(r.shift.start) && hhmmToMinutes(r.timeIn) < hhmmToMinutes(r.shift.end)
    } else {
      next = prevNext || hhmmToMinutes(r.timeIn) < prevIn
    }
    out.set(r.key, next)
    prevIn = hhmmToMinutes(r.timeIn)
    prevNext = next
  }
  return out
}

function changed(r: Row): boolean {
  const origIn = r.entry ? manilaHHMM(r.entry.clock_in) : ''
  const origOut = r.entry?.clock_out ? manilaHHMM(r.entry.clock_out) : ''
  return r.timeIn !== origIn || r.timeOut !== origOut
}

/** Leaving a page or switching date/employee drops unsaved edits: ask first. */
function discardOk(rows: Row[]): boolean {
  const dirty = rows.filter(changed).length
  return dirty === 0 || window.confirm(`Discard ${plural(dirty, 'unsaved change')}?`)
}

/**
 * Persist edited rows; returns the number saved and per-row errors.
 * Deletions go first and the rest in time order, so moving one pair over a
 * pair cleared in the same save doesn't trip the overlap check halfway.
 */
async function saveRows(rows: Row[]): Promise<{ saved: number; errors: string[] }> {
  let saved = 0
  const errors: string[] = []
  const flags = nextDayFlags(rows)
  const at = (r: Row) => (r.timeIn ? manilaWallToIso(r.date, r.timeIn, flags.get(r.key)) : '')
  const work = rows
    .filter(changed)
    .sort((a, b) => {
      const da = !a.timeIn && !a.timeOut ? 0 : 1
      const db = !b.timeIn && !b.timeOut ? 0 : 1
      return da - db || at(a).localeCompare(at(b))
    })
  for (const r of work) {
    const label = `${fullName(r.employee)} ${fmtDate(r.date)}`
    try {
      if (!r.timeIn && !r.timeOut) {
        if (r.entry) {
          const { error } = await supabase.from('time_entries').delete().eq('id', r.entry.id)
          if (error) throw error
        }
      } else {
        if (!r.timeIn) throw new Error('time in is required')
        const inNext = flags.get(r.key) ?? false
        const clockIn = manilaWallToIso(r.date, r.timeIn, inNext)
        const clockOut = r.timeOut
          ? manilaWallToIso(r.date, r.timeOut, inNext || hhmmToMinutes(r.timeOut) <= hhmmToMinutes(r.timeIn))
          : null
        if (r.entry) {
          const { error } = await supabase
            .from('time_entries')
            .update({ clock_in: clockIn, clock_out: clockOut, manually_edited: true })
            .eq('id', r.entry.id)
          if (error) throw error
        } else {
          const { error } = await supabase.from('time_entries').insert({
            employee_id: r.employee.id,
            work_date: r.date,
            clock_in: clockIn,
            clock_out: clockOut,
            source: 'admin',
          })
          if (error) throw error
        }
      }
      saved += 1
    } catch (err) {
      const msg = errorMessage(err, 'failed')
      errors.push(
        `${label}: ${
          /one_open_per_employee/.test(msg)
            ? 'only one entry per employee can be left without a time out — enter the time out'
            : msg
        }`,
      )
    }
  }
  return { saved, errors }
}

function RowCells({
  row,
  first,
  last,
  inNext,
  disabled,
  onChange,
  onAddPair,
}: {
  row: Row
  /** first pair of its day */
  first: boolean
  /** last pair of its day */
  last: boolean
  /** time in falls on the day after the work date */
  inNext: boolean
  /** a save is running */
  disabled: boolean
  onChange: (patch: Partial<Row>) => void
  onAddPair: () => void
}) {
  const mins = spanMinutes(row.timeIn, row.timeOut)
  const net = mins === null ? null : mins >= 360 ? Math.max(0, mins - row.breakMinutes) : mins
  const overnight = !!row.timeIn && !!row.timeOut && (inNext || hhmmToMinutes(row.timeOut) <= hhmmToMinutes(row.timeIn))
  const label = `${fullName(row.employee)} ${fmtDate(row.date)}`
  return (
    <>
      <Td>
        <Input
          type="time"
          aria-label={`Time in, ${label}`}
          value={row.timeIn}
          disabled={row.locked || disabled}
          onChange={(e) => onChange({ timeIn: e.target.value })}
          className={`w-32 ${changed(row) ? 'border-accent-400 bg-accent-50' : ''}`}
        />
        {inNext && <p className="mt-0.5 text-[10px] text-violet-600">next day</p>}
      </Td>
      <Td>
        <Input
          type="time"
          aria-label={`Time out, ${label}`}
          value={row.timeOut}
          disabled={row.locked || disabled}
          onChange={(e) => onChange({ timeOut: e.target.value })}
          className={`w-32 ${changed(row) ? 'border-accent-400 bg-accent-50' : ''}`}
        />
        {overnight && <p className="mt-0.5 text-[10px] text-violet-600">next day</p>}
      </Td>
      <Td className="whitespace-nowrap text-xs text-slate-500">
        {net === null ? (row.timeIn && !row.timeOut ? <Badge tone="amber">no time out</Badge> : '—') : fmtHours(net)}
      </Td>
      <Td>
        <div className="flex items-center gap-2 whitespace-nowrap">
          {row.locked ? (
            <span className="flex items-center gap-1 text-[11px] text-slate-400" title="Paid in a finalized payroll run — reopen the run to edit">
              <Lock className="size-3.5" /> paid
            </span>
          ) : (
            <>
              {first && last && row.shift && (
                <button
                  type="button"
                  onClick={() => row.shift && onChange({ timeIn: row.shift.start, timeOut: row.shift.end })}
                  className="text-[11px] font-semibold text-brand-600 hover:text-brand-800"
                >
                  Schedule
                </button>
              )}
              {(row.timeIn || row.timeOut) && (
                <button
                  type="button"
                  onClick={() => onChange({ timeIn: '', timeOut: '' })}
                  className="text-[11px] font-semibold text-slate-400 hover:text-rose-600"
                >
                  Clear
                </button>
              )}
              {last && (row.timeIn || row.entry) && (
                <button
                  type="button"
                  onClick={onAddPair}
                  title="Add another time in/out for this day (split shift)"
                  className="text-[11px] font-semibold text-brand-600 hover:text-brand-800"
                >
                  + pair
                </button>
              )}
            </>
          )}
        </div>
      </Td>
    </>
  )
}

/** Day notes shown next to a row: approved leave, holiday, rest day. */
function DayBadges({ row, showHoliday }: { row: Row; showHoliday: boolean }) {
  return (
    <>
      {!row.shift && <Badge tone="slate">rest day</Badge>}
      {showHoliday && row.holiday && (
        <Badge tone={row.holiday.kind === 'regular' ? 'red' : 'amber'}>{row.holiday.name}</Badge>
      )}
      {row.leave && (
        <Badge tone="violet">
          {row.leave.name}
          {row.leave.paid ? '' : ' (unpaid)'}
        </Badge>
      )}
    </>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700">
      Couldn't load attendance: {message}{' '}
      <button type="button" onClick={onRetry} className="font-semibold underline">
        Try again
      </button>
    </div>
  )
}

// ---------- daily sheet: every employee, one date ----------

function DailySheet({ entity, onDirty }: { entity: Entity; onDirty: (n: number) => void }) {
  const toast = useToast()
  const [date, setDate] = useState(todayManila())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [onlyScheduled, setOnlyScheduled] = useState(false)
  // only the latest request may fill the grid: an older response arriving
  // last would put one day's rows under another day's date
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoading(true)
    setLoadError('')
    setRows([])
    try {
      const [emps, { data: ent, error: entErr }, locked, hols, leaves, schedules] = await Promise.all([
        getEmployees(entity.id),
        supabase.from('time_entries').select('*').eq('entity_id', entity.id).eq('work_date', date),
        lockedKeys(entity.id, date, date),
        getHolidaysBetween(entity.id, date, date),
        leaveMarks(entity.id, date, date),
        fetchScheduleRows({ entityId: entity.id }, date, date),
      ])
      if (entErr) throw entErr
      if (my !== seq.current) return
      const active = emps.filter((e) => e.hire_date <= date && isActiveOn(e, date))
      setRows(
        buildRows(
          active.map((employee) => ({ employee, date })),
          (ent ?? []) as TimeEntry[],
          locked,
          hols,
          leaves,
          resolversFor(active, schedules),
        ),
      )
    } catch (err) {
      if (my === seq.current) setLoadError(errorMessage(err, 'Failed to load'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [entity.id, date])

  useEffect(() => {
    load()
  }, [load])
  // the reload after a save must be for the date shown now
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const shown = rows.filter((r) => !onlyScheduled || r.shift)
  const dirty = rows.filter(changed).length
  const flags = useMemo(() => nextDayFlags(rows), [rows])
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  const goTo = (d: string) => {
    if (!busy && d && d !== date && discardOk(rows)) setDate(d)
  }

  async function save() {
    setBusy(true)
    const { saved, errors } = await saveRows(rows)
    setBusy(false)
    if (errors.length) toast('error', errors.slice(0, 3).join(' · ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''))
    if (saved) toast('success', `Saved ${plural(saved, 'row')} (audit-logged).`)
    await loadRef.current()
  }

  const holiday = rows[0]?.holiday
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Work date">
            <Input type="date" value={date} disabled={busy} onChange={(e) => goTo(e.target.value)} className="w-44" />
          </Field>
          <div className="flex gap-1 pb-0.5">
            <Button variant="ghost" disabled={busy} onClick={() => goTo(addDays(date, -1))}>‹ Prev</Button>
            <Button variant="ghost" disabled={busy} onClick={() => goTo(addDays(date, 1))}>Next ›</Button>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={onlyScheduled} onChange={(e) => setOnlyScheduled(e.target.checked)} className="rounded border-slate-300" />
            Scheduled today only
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={loading || busy} onClick={() => setRows(filledWithSchedule)}>
            <Wand2 className="size-4" /> Fill scheduled with shift times
          </Button>
          <Button disabled={busy || loading || dirty === 0} onClick={save}>
            <Save className="size-4" /> {busy ? 'Saving…' : `Save${dirty ? ` (${dirty})` : ''}`}
          </Button>
        </div>
      </div>
      {holiday && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtDate(date)} is {holiday.name} ({holiday.kind.replaceAll('_', ' ')}).{' '}
          {isDayOff(holiday)
            ? 'Fill skips it: enter times only for those who actually worked — work today earns holiday premiums.'
            : 'A working holiday: regular pay for work today.'}
        </p>
      )}
      {loadError ? (
        <LoadError message={loadError} onRetry={load} />
      ) : loading ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <EmptyState title="No employees" sub="Nobody is employed on this date." />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Employee</Th>
              <Th>Schedule</Th>
              <Th>Time in</Th>
              <Th>Time out</Th>
              <Th>Worked</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((r, i) => {
              const first = shown[i - 1]?.dayKey !== r.dayKey
              const last = shown[i + 1]?.dayKey !== r.dayKey
              return (
                <tr key={r.key} className={r.locked ? 'bg-slate-50/70' : ''}>
                  <Td>
                    {first ? (
                      <>
                        <p className="font-semibold text-slate-800">{fullName(r.employee)}</p>
                        <p className="text-xs text-slate-400">{r.employee.employee_no}</p>
                      </>
                    ) : (
                      <p className="pl-3 text-xs text-slate-400">↳ another pair</p>
                    )}
                  </Td>
                  <Td className="text-xs">
                    {first && (
                      <div className="flex flex-wrap items-center gap-1">
                        {r.shift && (
                          <span className="whitespace-nowrap" title={r.shift.name}>{shiftLabel(r.shift)}</span>
                        )}
                        <DayBadges row={r} showHoliday={false} />
                      </div>
                    )}
                  </Td>
                  <RowCells
                    row={r}
                    first={first}
                    last={last}
                    inNext={flags.get(r.key) ?? false}
                    disabled={busy}
                    onChange={(p) => patch(r.key, p)}
                    onAddPair={() => setRows((rs) => withExtraPair(rs, r))}
                  />
                </tr>
              )
            })}
          </tbody>
        </TableShell>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        Leave a scheduled day blank for an absence (or file the employee's leave). Use “+ pair” for a split shift.
        Every change is audit-logged.
      </p>
    </Card>
  )
}

// ---------- per-employee sheet: one employee, a date range ----------

function EmployeeSheet({
  entity,
  onDirty,
  preset,
}: {
  entity: Entity
  onDirty: (n: number) => void
  preset?: SheetPreset | null
}) {
  const toast = useToast()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState(preset?.employeeId ?? '')
  const [from, setFrom] = useState(preset?.from ?? addDays(todayManila(), -14))
  const [to, setTo] = useState(preset?.to ?? todayManila())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const loadEmployees = useCallback(async () => {
    setLoadError('')
    try {
      const emps = await getEmployees(entity.id)
      setEmployees(emps)
      // a linked employee of another client (the client was switched since) falls back too
      setEmployeeId((cur) =>
        cur && emps.some((e) => e.id === cur) ? cur : emps.find((e) => isActiveOn(e, todayManila()))?.id || '',
      )
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load employees'))
    }
  }, [entity.id])

  useEffect(() => {
    loadEmployees()
  }, [loadEmployees])

  const employee = useMemo(() => employees.find((e) => e.id === employeeId) ?? null, [employees, employeeId])

  const load = useCallback(async () => {
    const my = ++seq.current
    setRows([])
    if (!employee || to < from) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const [{ data: ent, error: entErr }, locked, hols, leaves, schedules] = await Promise.all([
        supabase.from('time_entries').select('*').eq('employee_id', employee.id).gte('work_date', from).lte('work_date', to),
        lockedKeys(entity.id, from, to),
        getHolidaysBetween(entity.id, from, to),
        leaveMarks(entity.id, from, to, employee.id),
        fetchScheduleRows({ entityId: entity.id, employeeId: employee.id }, from, to),
      ])
      if (entErr) throw entErr
      if (my !== seq.current) return
      const dates = eachDate(from, to).filter((d) => d >= employee.hire_date && isActiveOn(employee, d))
      setRows(
        buildRows(
          dates.map((date) => ({ employee, date })),
          (ent ?? []) as TimeEntry[],
          locked,
          hols,
          leaves,
          resolversFor([employee], schedules),
        ),
      )
    } catch (err) {
      if (my === seq.current) setLoadError(errorMessage(err, 'Failed to load'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [employee, from, to, entity.id])

  useEffect(() => {
    load()
  }, [load])

  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const dirty = rows.filter(changed).length
  const flags = useMemo(() => nextDayFlags(rows), [rows])
  useEffect(() => onDirty(dirty), [dirty, onDirty])
  const guarded = (fn: () => void) => () => {
    if (!busy && discardOk(rows)) fn()
  }

  async function save() {
    setBusy(true)
    const { saved, errors } = await saveRows(rows)
    setBusy(false)
    if (errors.length) toast('error', errors.slice(0, 3).join(' · ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''))
    if (saved) toast('success', `Saved ${plural(saved, 'row')} (audit-logged).`)
    await loadRef.current()
  }

  const totalMinutes = rows.reduce((s, r) => {
    const m = spanMinutes(r.timeIn, r.timeOut)
    if (m === null) return s
    return s + (m >= 360 ? Math.max(0, m - r.breakMinutes) : m)
  }, 0)

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Employee">
            <Select
              value={employeeId}
              disabled={busy}
              onChange={(e) => {
                const id = e.target.value
                guarded(() => setEmployeeId(id))()
              }}
              className="w-64 max-w-full"
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {fullName(e)} ({e.employee_no}){isActiveOn(e, todayManila()) ? '' : ' — separated'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input
              type="date"
              value={from}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value
                guarded(() => setFrom(v))()
              }}
              className="w-40"
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value
                guarded(() => setTo(v))()
              }}
              className="w-40"
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={loading || busy || rows.length === 0} onClick={() => setRows(filledWithSchedule)}>
            <Wand2 className="size-4" /> Fill scheduled days
          </Button>
          <Button disabled={busy || loading || dirty === 0} onClick={save}>
            <Save className="size-4" /> {busy ? 'Saving…' : `Save${dirty ? ` (${dirty})` : ''}`}
          </Button>
        </div>
      </div>
      {loadError ? (
        <LoadError message={loadError} onRetry={employees.length ? load : loadEmployees} />
      ) : !employee ? (
        <EmptyState title="Pick an employee" />
      ) : to < from ? (
        <EmptyState title="The end date is before the start date" />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
          {employee && (
            <p className="mb-2 text-sm font-semibold text-slate-700">
              {fullName(employee)} <span className="font-normal text-slate-400">{employee.employee_no}</span>
              {employee.fixed_salary && (
                <span className="ml-2 font-normal text-slate-500">· Fixed salary: no time in/out needed, payroll doesn't use it</span>
              )}
            </p>
          )}
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Date</Th>
                <Th>Day</Th>
                <Th>Time in</Th>
                <Th>Time out</Th>
                <Th>Worked</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r, i) => {
                const first = rows[i - 1]?.dayKey !== r.dayKey
                const last = rows[i + 1]?.dayKey !== r.dayKey
                return (
                  <tr key={r.key} className={r.locked ? 'bg-slate-50/70' : ''}>
                    <Td className="whitespace-nowrap font-semibold">{first ? fmtDate(r.date) : ''}</Td>
                    <Td className="text-xs">
                      {first ? (
                        <div className="flex flex-wrap items-center gap-1">
                          <span>{new Date(`${r.date}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short' })}</span>
                          <DayBadges row={r} showHoliday />
                        </div>
                      ) : (
                        <span className="text-slate-400">↳ another pair</span>
                      )}
                    </Td>
                    <RowCells
                      row={r}
                      first={first}
                      last={last}
                      inNext={flags.get(r.key) ?? false}
                      disabled={busy}
                      onChange={(p) => patch(r.key, p)}
                      onAddPair={() => setRows((rs) => withExtraPair(rs, r))}
                    />
                  </tr>
                )
              })}
            </tbody>
          </TableShell>
          <p className="mt-3 text-xs text-slate-500">Total worked in range: <b>{fmtHours(totalMinutes)}</b> (after breaks)</p>
        </>
      )}
    </Card>
  )
}

// ---------- correction requests filed by employees ----------

type RequestWithEmployee = TimeCorrectionRequest & { employees: Employee }

function Corrections({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [requests, setRequests] = useState<RequestWithEmployee[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [reviewing, setReviewing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoadError('')
    // every pending request (however old), then the latest reviewed ones
    const [pending, recent] = await Promise.all([
      supabase
        .from('time_correction_requests')
        .select('*, employees(*)')
        .eq('entity_id', entity.id)
        .eq('status', 'pending')
        .order('created_at'),
      supabase
        .from('time_correction_requests')
        .select('*, employees(*)')
        .eq('entity_id', entity.id)
        .neq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(50),
    ])
    const err = pending.error ?? recent.error
    if (err) setLoadError(errorMessage(err, 'Failed to load'))
    else setRequests([...(pending.data ?? []), ...(recent.data ?? [])] as RequestWithEmployee[])
    setLoading(false)
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  async function review(id: string, approve: boolean) {
    if (reviewing) return
    setReviewing(id)
    const { error } = await supabase.rpc('review_time_correction', {
      p_request_id: id,
      p_approve: approve,
      p_notes: notes[id] || null,
    })
    setReviewing(null)
    if (error) toast('error', errorMessage(error, 'Review failed'))
    else {
      toast('success', approve ? 'Correction applied.' : 'Request rejected.')
      notifyPendingChanged()
      await load()
    }
  }

  if (loading) return <Spinner />
  if (loadError) return <LoadError message={loadError} onRetry={load} />
  if (requests.length === 0)
    return (
      <Card>
        <EmptyState title="No correction requests" sub="Employees can flag a wrong time in/out from their portal." />
      </Card>
    )
  return (
    <div className="space-y-3">
      {requests.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800">
                {r.employees ? fullName(r.employees) : '—'}
                <span className="ml-2 font-normal text-slate-500">{fmtDate(r.work_date)}</span>{' '}
                <Badge tone={r.status === 'pending' ? 'amber' : r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'slate'}>
                  {r.status}
                </Badge>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Requested: {r.requested_clock_in ? fmtDateTime(r.requested_clock_in) : '—'} →{' '}
                {r.requested_clock_out ? fmtDateTime(r.requested_clock_out) : '—'}{' '}
                {!r.time_entry_id && <Badge tone="blue">missing entry</Badge>}
              </p>
              <p className="mt-1 break-words text-xs italic text-slate-500">“{r.reason}”</p>
              {r.review_notes && <p className="mt-1 break-words text-xs text-slate-400">Note: {r.review_notes}</p>}
            </div>
            {r.status === 'pending' && (
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <Input
                  aria-label="Review note"
                  placeholder="Review note (optional)"
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                  className="w-full sm:w-52"
                />
                <Button variant="dark" disabled={reviewing !== null} onClick={() => review(r.id, true)}>
                  <Check className="size-4" /> Approve
                </Button>
                <Button variant="secondary" disabled={reviewing !== null} onClick={() => review(r.id, false)}>
                  <X className="size-4 text-rose-600" /> Reject
                </Button>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
