// An employee's work schedule: the weekly pattern in force and since when,
// the changes ahead and before it, and the single dates changed in the
// roster. A new pattern starts on a date and never reaches back into paid
// days (the database refuses that too); dates are changed on the Schedules
// page's roster.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CalendarClock, CalendarRange, Copy, History, Trash2 } from 'lucide-react'
import { ShiftChooser, cleanShift, shiftProblem } from '../../components/ShiftPicker'
import { Badge, Button, Card, EmptyState, Field, IconButton, Input, LoadFailed, Modal, Spinner } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Employee, Entity } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fmtDate, fmtDateTime, plural } from '../../lib/format'
import { lastPaidDate } from '../../lib/locks'
import { todayManila } from '../../lib/manila'
import { fetchScheduleRows, fetchShiftTemplates, type ScheduleRows, type ScheduleVersionRow, type ShiftTemplate } from '../../lib/schedules'
import { DAY_LABELS, DAY_NAMES, earliestScheduleChange, patternSummary, shiftDetail, shiftLabel } from '../../lib/shiftText'
import { supabase } from '../../lib/supabase'
import { patternFromWorkSchedule, patternOn } from '../../payroll/schedule'
import type { WeekPattern } from '../../payroll/types'

interface Loaded {
  rows: ScheduleRows
  templates: ShiftTemplate[]
  lastPaid: string | null
}

export function ScheduleTab({ employee, entity }: { employee: Employee; entity: Entity }) {
  const toast = useToast()
  const today = todayManila()
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState('')
  const [changing, setChanging] = useState(false)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const [rows, templates, lastPaid] = await Promise.all([
        // every pattern, and the single-date changes from today on
        fetchScheduleRows({ entityId: employee.entity_id, employeeId: employee.id }, today, '9999-12-31'),
        fetchShiftTemplates(employee.entity_id),
        lastPaidDate(employee.id),
      ])
      setData({ rows, templates, lastPaid })
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the schedule'))
    }
  }, [employee.entity_id, employee.id, today])

  useEffect(() => {
    load()
  }, [load])

  const base = useMemo(() => patternFromWorkSchedule(employee.work_schedule), [employee.work_schedule])

  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!data) return <Spinner />

  const versions = data.rows.versions
  const earliest = earliestScheduleChange(employee.hire_date, data.lastPaid)
  // as of today, or the first day of work for someone who hasn't started
  const asOf = today < employee.hire_date ? employee.hire_date : today
  const inForce = [...versions].reverse().find((v) => v.effective_from <= asOf)
  const current = inForce?.pattern ?? base
  const ahead = versions.filter((v) => v.effective_from > asOf)
  const sevenDays = current.every((s) => s !== null)

  async function removeVersion(v: ScheduleVersionRow) {
    if (!confirm(`Remove the schedule starting ${fmtDate(v.effective_from)}? The schedule before it continues instead.`)) return
    const { error } = await supabase.from('employee_schedules').delete().eq('id', v.id)
    if (error) toast('error', errorMessage(error, 'Could not remove the schedule'))
    else {
      toast('success', 'Schedule removed (audit-logged). Recompute any draft payroll it covered.')
      await load()
    }
  }

  async function removeDate(id: string, date: string) {
    if (!confirm(`Put ${fmtDate(date)} back on the weekly schedule?`)) return
    const { error } = await supabase.from('schedule_overrides').delete().eq('id', id)
    if (error) toast('error', errorMessage(error, 'Could not change the date'))
    else await load()
  }

  return (
    <div className="space-y-5">
      <Card
        title="Weekly schedule"
        icon={<CalendarClock />}
        actions={
          <Button variant="secondary" onClick={() => setChanging(true)} disabled={!!employee.separation_date && employee.separation_date < earliest}>
            Change schedule
          </Button>
        }
      >
        <p className="mb-3 text-xs text-slate-500">
          {inForce
            ? `In force since ${fmtDate(inForce.effective_from)}${inForce.note ? ` — ${inForce.note}` : ''}.`
            : 'As set when the employee was added.'}{' '}
          Payroll measures each day against the shift scheduled for it: lateness and undertime from its start and end,
          overtime past {plural(Number(entity.standard_hours_per_day) || 8, 'hour')} of work (or past the shift on a compressed workweek), absences on its workdays.
        </p>
        <PatternTable pattern={current} />
        {sevenDays && <RestDayWarning />}
        {ahead.length > 0 && (
          <div className="mt-4 rounded-lg bg-accent-50 p-3 text-sm">
            {ahead.map((v) => (
              <p key={v.id} className="text-ink-900">
                <span className="font-semibold">From {fmtDate(v.effective_from)}:</span> {patternSummary(v.pattern)}
                {v.note && <span className="text-slate-500"> — {v.note}</span>}
              </p>
            ))}
          </div>
        )}
        {data.lastPaid && (
          <p className="mt-3 text-[11px] text-slate-400">
            Paid through {fmtDate(data.lastPaid)}: a change can start on {fmtDate(earliest)} at the earliest. To change a
            paid period, reopen its payroll first.
          </p>
        )}
      </Card>

      <Card title="Changes for single dates" icon={<CalendarRange />}>
        {data.rows.overrides.length === 0 ? (
          <EmptyState
            title="No dates changed from today on"
            sub="A swapped shift or a moved rest day is set for its date in the weekly roster."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.rows.overrides.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 text-sm">
                  <span className="font-semibold text-ink-900">{fmtDate(o.work_date)}</span>{' '}
                  <span className="text-slate-600">{shiftLabel(o.shift)}</span>
                  {o.note && <span className="block truncate text-xs text-slate-400">{o.note}</span>}
                </div>
                <IconButton size="sm" label={`Put ${fmtDate(o.work_date)} back on the weekly schedule`} onClick={() => removeDate(o.id, o.work_date)} className="text-rose-600">
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <Link to="/admin/schedules" className="mt-3 inline-block text-sm font-semibold text-brand-700 hover:underline">
          Open the weekly roster →
        </Link>
      </Card>

      <Card title="Schedule history" icon={<History />}>
        <ul className="divide-y divide-slate-100">
          {[...versions].reverse().map((v) => (
            <li key={v.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0 text-sm">
                <p className="font-semibold text-ink-900">
                  From {fmtDate(v.effective_from)}{' '}
                  {v === inForce && <Badge tone="solid">current</Badge>}
                  {v.effective_from > asOf && <Badge tone="amber">upcoming</Badge>}
                </p>
                <p className="text-slate-600">{patternSummary(v.pattern)}</p>
                <p className="text-xs text-slate-400">
                  {v.note ? `${v.note} · ` : ''}set {fmtDateTime(v.created_at)}
                </p>
              </div>
              {(!data.lastPaid || v.effective_from > data.lastPaid) && (
                <IconButton size="sm" label={`Remove the schedule from ${fmtDate(v.effective_from)}`} onClick={() => removeVersion(v)} className="text-rose-600">
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
          {(!versions.length || versions[0].effective_from > employee.hire_date) && (
            <li className="py-2.5 text-sm">
              <p className="font-semibold text-ink-900">
                From {fmtDate(employee.hire_date)} {!inForce && <Badge tone="solid">current</Badge>}
              </p>
              <p className="text-slate-600">{patternSummary(base)}</p>
              <p className="text-xs text-slate-400">as set when the employee was added</p>
            </li>
          )}
        </ul>
      </Card>

      {changing && (
        <ChangeScheduleModal
          employee={employee}
          versions={versions}
          base={base}
          earliest={earliest}
          defaultFrom={earliest > today ? earliest : today}
          templates={data.templates}
          onClose={() => setChanging(false)}
          onSaved={async () => {
            setChanging(false)
            await load()
          }}
        />
      )}
    </div>
  )
}

function PatternTable({ pattern }: { pattern: WeekPattern }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200/80">
      {pattern.map((s, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-3 py-2 text-sm">
          <span className="w-24 font-semibold text-ink-900">{DAY_NAMES[i]}</span>
          <span className={s ? 'text-ink-900' : 'text-slate-400'}>
            {shiftLabel(s)}
            {s?.name && <span className="text-slate-400"> · {s.name}</span>}
          </span>
          {s && <span className="text-xs text-slate-500 sm:ml-auto">{shiftDetail(s)}</span>}
        </li>
      ))}
    </ul>
  )
}

function RestDayWarning() {
  return (
    <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-amber-700">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      Seven workdays: every employee is owed a rest day of at least 24 consecutive hours after six consecutive workdays
      (Labor Code Art. 91). Work on it is paid as rest-day work.
    </p>
  )
}

function ChangeScheduleModal({
  employee,
  versions,
  base,
  earliest,
  defaultFrom,
  templates,
  onClose,
  onSaved,
}: {
  employee: Employee
  versions: ScheduleVersionRow[]
  base: WeekPattern
  earliest: string
  defaultFrom: string
  templates: ShiftTemplate[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [from, setFrom] = useState(defaultFrom)
  // starts as the pattern in force on the default date; editing the date keeps the edits
  const [pattern, setPattern] = useState<WeekPattern>(() => patternOn(base, versions, defaultFrom))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const replaces = versions.find((v) => v.effective_from === from)
  const dateProblem = !from
    ? 'Choose the first day of the new schedule.'
    : from < earliest
      ? `Pay through the day before ${fmtDate(earliest)} is final or before the start of employment: start on ${fmtDate(earliest)} or later.`
      : employee.separation_date && from > employee.separation_date
        ? `That is after the last day of employment (${fmtDate(employee.separation_date)}).`
        : ''
  const dayProblem = pattern.map((s, i) => (s && shiftProblem(s) ? `${DAY_NAMES[i]}: ${shiftProblem(s)}` : '')).find(Boolean) ?? ''
  const problem = dateProblem || dayProblem
  const setDay = (i: number, s: WeekPattern[number]) => setPattern(pattern.map((x, j) => (j === i ? s : x)))

  async function save() {
    if (busy || problem) return
    setBusy(true)
    try {
      const { error } = await supabase.from('employee_schedules').upsert(
        {
          employee_id: employee.id,
          entity_id: employee.entity_id,
          effective_from: from,
          pattern: pattern.map((s) => (s ? cleanShift(s, s.name) : null)),
          note: note.trim(),
        },
        { onConflict: 'employee_id,effective_from' },
      )
      if (error) throw error
      toast('success', `Schedule set from ${fmtDate(from)} (audit-logged). Recompute any draft payroll from that date.`)
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not save the schedule'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Change the weekly schedule" wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starting on" hint={`Days before it keep the schedule they had. Earliest: ${fmtDate(earliest)}`}>
            <Input type="date" value={from} min={earliest} max={employee.separation_date ?? undefined} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Reason (optional)">
            <Input value={note} maxLength={300} placeholder="e.g. moved to the night shift" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        {replaces && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Replaces the schedule already set to start on {fmtDate(from)} ({patternSummary(replaces.pattern)}).
          </p>
        )}
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200/80">
          {pattern.map((s, i) => (
            <li key={i} className="grid gap-2 px-3 py-3 sm:grid-cols-[6rem_1fr_auto] sm:items-start">
              <span className="pt-2 text-sm font-semibold text-ink-900">{DAY_NAMES[i]}</span>
              <ShiftChooser value={s} onChange={(v) => setDay(i, v)} templates={templates} label={`${DAY_NAMES[i]} shift`} />
              {s && (
                <IconButton
                  size="sm"
                  label={`Use ${DAY_LABELS[i]}'s shift on every workday`}
                  onClick={() => setPattern(pattern.map((x) => (x ? s : null)))}
                >
                  <Copy className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
        {pattern.every((s) => s !== null) && <RestDayWarning />}
        {pattern.every((s) => s === null) && (
          <p className="text-xs font-medium text-amber-700">No workdays: every day the employee works would be rest-day work.</p>
        )}
        <p className="text-[11px] text-slate-400">
          The copy button puts that day's shift on every other day that has one. Pick “Rest day” to make a day a rest day.
          Shift times are saved with the schedule: editing a client shift later doesn't change it.
        </p>
        {problem && <p className="text-xs font-semibold text-rose-600">{problem}</p>}
        <Button className="w-full" disabled={busy || !!problem} onClick={save}>
          {busy ? 'Saving…' : `Set this schedule from ${from ? fmtDate(from) : '…'}`}
        </Button>
      </div>
    </Modal>
  )
}
