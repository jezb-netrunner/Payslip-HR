// Schedules: who works which shift on which date. The weekly roster shows,
// for every employee of the client, the shift payroll will measure each day
// against — their weekly pattern, or a change for that date (a swapped
// shift, a moved rest day) — and changes single dates. Shifts keeps the
// client's shift templates. An employee's weekly pattern itself is set from
// a date on, on their Schedule tab.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, CalendarRange, ChevronLeft, ChevronRight, Clock, Lock, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { ShiftChooser, ShiftFields, NEW_SHIFT, cleanShift, shiftProblem } from '../../components/ShiftPicker'
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
  NoClient,
  PageHeader,
  Select,
  Spinner,
  Tabs,
  Toggle,
} from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, getHolidaysBetween } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, Holiday } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, fullName, plural } from '../../lib/format'
import { lockedKeys } from '../../lib/locks'
import { addDays, eachDate, isoWeekday, todayManila } from '../../lib/manila'
import { fetchScheduleRows, fetchShiftTemplates, resolversFor, type ScheduleRows, type ShiftTemplate } from '../../lib/schedules'
import { DAY_LABELS, shiftDetail, shiftLabel, shiftShort } from '../../lib/shiftText'
import { supabase } from '../../lib/supabase'
import { sameShift } from '../../payroll/schedule'
import type { Shift } from '../../payroll/types'

export default function Schedules() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const [tab, setTab] = useState('roster')
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return (
    <div>
      <PageHeader
        title="Schedules"
        subtitle="The shift each employee works on each date. Payroll measures lateness, undertime, overtime and absences against it."
      />
      <Tabs
        tabs={[
          { key: 'roster', label: 'Weekly roster', icon: <CalendarRange /> },
          { key: 'shifts', label: 'Shifts', icon: <Clock /> },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'roster' && <Roster key={entity.id} entity={entity} onShifts={() => setTab('shifts')} />}
      {tab === 'shifts' && <Shifts key={entity.id} entity={entity} />}
    </div>
  )
}

const mondayOf = (date: string) => addDays(date, 1 - isoWeekday(date))

function employedOn(e: Employee, date: string) {
  return e.hire_date <= date && (!e.separation_date || e.separation_date >= date)
}

interface RosterData {
  week: string
  employees: Employee[]
  rows: ScheduleRows
  templates: ShiftTemplate[]
  holidays: Holiday[]
  /** employee|date → leave name */
  leaves: Map<string, string>
  locked: Set<string>
}

// ---------- weekly roster ----------

function Roster({ entity, onShifts }: { entity: Entity; onShifts: () => void }) {
  const today = todayManila()
  const [week, setWeek] = useState(mondayOf(today))
  const weekEnd = addDays(week, 6)
  const dates = useMemo(() => eachDate(week, addDays(week, 6)), [week])
  const [data, setData] = useState<RosterData | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [department, setDepartment] = useState('')
  const [day, setDay] = useState(today)
  const [editing, setEditing] = useState<{ employee: Employee; date: string } | null>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const my = ++seq.current
    setLoadError('')
    try {
      const [emps, rows, templates, holidays, leaves, locked] = await Promise.all([
        getEmployees(entity.id),
        fetchScheduleRows({ entityId: entity.id }, week, weekEnd),
        fetchShiftTemplates(entity.id),
        getHolidaysBetween(entity.id, week, weekEnd),
        fetchAll<{ employee_id: string; start_date: string; end_date: string; leave_types: { name: string } | null }>((f, t) =>
          supabase
            .from('leave_requests')
            .select('employee_id, start_date, end_date, leave_types(name)')
            .eq('entity_id', entity.id)
            .eq('status', 'approved')
            .lte('start_date', weekEnd)
            .gte('end_date', week)
            .order('id')
            .range(f, t),
        ),
        lockedKeys(entity.id, week, weekEnd),
      ])
      if (my !== seq.current) return
      const leaveBy = new Map<string, string>()
      for (const l of leaves) {
        for (const d of eachDate(l.start_date > week ? l.start_date : week, l.end_date < weekEnd ? l.end_date : weekEnd)) {
          leaveBy.set(`${l.employee_id}|${d}`, l.leave_types?.name ?? 'Leave')
        }
      }
      setData({
        week,
        employees: emps.filter((e) => e.hire_date <= weekEnd && (!e.separation_date || e.separation_date >= week)),
        rows,
        templates,
        holidays,
        leaves: leaveBy,
        locked,
      })
    } catch (err) {
      if (my === seq.current) setLoadError(errorMessage(err, 'Could not load the roster'))
    }
  }, [entity.id, week, weekEnd])

  useEffect(() => {
    load()
  }, [load])

  const current = data && data.week === week ? data : null
  const resolvers = useMemo(() => (current ? resolversFor(current.employees, current.rows) : new Map()), [current])
  const changed = useMemo(
    () => new Map((current?.rows.overrides ?? []).map((o) => [`${o.employee_id}|${o.work_date}`, o])),
    [current],
  )
  const departments = [...new Set((current?.employees ?? []).map((e) => e.department).filter(Boolean))].sort()
  const q = query.trim().toLowerCase()
  const shown = (current?.employees ?? []).filter(
    (e) =>
      (!department || e.department === department) &&
      (!q || `${fullName(e)} ${e.employee_no} ${e.position}`.toLowerCase().includes(q)),
  )
  const go = (n: number) => {
    const next = addDays(week, n * 7)
    setWeek(next)
    setDay(n === 0 ? today : next)
  }
  const dayInWeek = day >= week && day <= weekEnd ? day : week

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-end gap-1.5">
            <IconButton label="Previous week" onClick={() => go(-1)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <Field label="Week of">
              <Input
                type="date"
                value={week}
                onChange={(e) => {
                  if (!e.target.value) return
                  const w = mondayOf(e.target.value)
                  setWeek(w)
                  setDay(e.target.value)
                }}
                className="w-44"
              />
            </Field>
            <IconButton label="Next week" onClick={() => go(1)}>
              <ChevronRight className="size-4" />
            </IconButton>
          </div>
          <Button variant="ghost" size="sm" className="mb-0.5" onClick={() => go(0)} disabled={week === mondayOf(today)}>
            This week
          </Button>
          <div className="relative w-full sm:ml-auto sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
            <Input aria-label="Search employees" placeholder="Search employees" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
          </div>
          {departments.length > 1 && (
            <Select aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full sm:w-44">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </Select>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Each day shows the shift from the employee's weekly schedule; click a day to change just that date
          (highlighted). Set an employee's regular schedule on their Schedule tab.{' '}
          {current && current.templates.filter((t) => t.active).length === 0 && (
            <button type="button" onClick={onShifts} className="font-semibold text-brand-700 underline">
              Add the client's shifts
            </button>
          )}
        </p>
      </Card>

      {loadError ? (
        <LoadFailed message={loadError} onRetry={load} />
      ) : !current ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title={current.employees.length ? 'No employees match' : 'Nobody is employed this week'} />
        </Card>
      ) : (
        <>
          {/* phones: one day at a time */}
          <div className="md:hidden">
            <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {dates.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  aria-pressed={d === dayInWeek}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-center text-xs font-semibold ${
                    d === dayInWeek ? 'bg-ink-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'
                  }`}
                >
                  {DAY_LABELS[i]}
                  <span className="block text-sm">{Number(d.slice(8, 10))}</span>
                </button>
              ))}
            </div>
            <DayHoliday holidays={current.holidays} date={dayInWeek} />
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200/80 bg-white">
              {shown.map((e) => {
                const shift = resolvers.get(e.id)?.(dayInWeek).shift ?? null
                const key = `${e.id}|${dayInWeek}`
                const locked = current.locked.has(key)
                const employed = employedOn(e, dayInWeek)
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      disabled={locked || !employed}
                      onClick={() => setEditing({ employee: e, date: dayInWeek })}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:cursor-not-allowed ${
                        changed.has(key) ? 'bg-accent-100/70' : ''
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-ink-900">{fullName(e)}</span>
                        <span className="block truncate text-xs text-slate-400">{e.position || e.employee_no}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <CellLabel shift={shift} employed={employed} changed={changed.has(key)} locked={locked} leave={current.leaves.get(key)} />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* the week as a grid */}
          <div className="scroll-thin hidden overflow-x-auto rounded-xl border border-slate-200/80 bg-white md:block">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-100 text-xs font-semibold text-slate-600">
                  <th className="sticky left-0 z-10 bg-slate-100 px-4 py-2.5 text-left">Employee</th>
                  {dates.map((d, i) => {
                    const h = current.holidays.find((x) => x.holiday_date === d)
                    return (
                      <th key={d} className={`px-1.5 py-2 text-center ${d === today ? 'text-ink-900' : ''}`}>
                        {DAY_LABELS[i]} {Number(d.slice(8, 10))}
                        {h && (
                          <span className={`mx-auto mt-0.5 block max-w-24 truncate text-[10px] font-medium ${h.kind === 'regular' ? 'text-rose-600' : 'text-amber-700'}`} title={h.name}>
                            {h.name}
                          </span>
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((e) => {
                  const resolve = resolvers.get(e.id)
                  const shifts = dates.map((d) => resolve?.(d).shift ?? null)
                  // Art. 91: a rest day of 24 hours after six workdays
                  const noRest = dates.every((d) => employedOn(e, d)) && shifts.every((s) => s !== null)
                  return (
                    <tr key={e.id}>
                      <td className="sticky left-0 z-10 bg-white px-4 py-2">
                        <Link to={`/admin/employees/${e.id}`} className="block max-w-44 truncate text-sm font-semibold text-ink-900 hover:underline">
                          {fullName(e)}
                        </Link>
                        <span className="block max-w-44 truncate text-xs text-slate-400">{e.position || e.employee_no}</span>
                        {noRest && (
                          <span className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700" title="Labor Code Art. 91: at least 24 consecutive hours of rest after every six consecutive workdays">
                            <AlertTriangle className="size-3" /> no rest day this week
                          </span>
                        )}
                      </td>
                      {dates.map((d, i) => {
                        const key = `${e.id}|${d}`
                        const locked = current.locked.has(key)
                        const employed = employedOn(e, d)
                        const change = changed.get(key)
                        const h = current.holidays.find((x) => x.holiday_date === d)
                        return (
                          <td key={d} className={`px-1 py-1 ${h && h.kind !== 'special_working' ? 'bg-slate-50/80' : ''}`}>
                            <button
                              type="button"
                              disabled={locked || !employed}
                              onClick={() => setEditing({ employee: e, date: d })}
                              title={
                                !employed
                                  ? 'Not employed on this date'
                                  : locked
                                    ? 'Paid in a finalized payroll — reopen it to change this date'
                                    : `${fullName(e)}, ${fmtDate(d)}: ${shiftLabel(shifts[i])}${change ? ' (changed for this date)' : ''}${change?.note ? ` — ${change.note}` : ''}`
                              }
                              className={`flex h-12 w-full min-w-16 flex-col items-center justify-center rounded-lg px-1 text-xs transition-colors disabled:cursor-not-allowed ${
                                change ? 'bg-accent-100 ring-1 ring-accent-400 hover:bg-accent-200' : 'hover:bg-slate-100'
                              }`}
                            >
                              <CellLabel shift={shifts[i]} employed={employed} changed={!!change} locked={locked} leave={current.leaves.get(key)} />
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-400">
            Highlighted = changed for that date only. A lock means the day was paid in a finalized payroll. Times are
            Philippine time; an end before the start is the next morning.
          </p>
        </>
      )}

      {editing && current && (
        <RosterDayModal
          employee={editing.employee}
          date={editing.date}
          regular={(() => {
            // the weekly pattern's shift, ignoring any change for the date
            const withoutChange = resolversFor([editing.employee], {
              versions: current.rows.versions,
              overrides: current.rows.overrides.filter((o) => !(o.employee_id === editing.employee.id && o.work_date === editing.date)),
            })
            return withoutChange.get(editing.employee.id)?.(editing.date).shift ?? null
          })()}
          change={changed.get(`${editing.employee.id}|${editing.date}`)}
          templates={current.templates}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function DayHoliday({ holidays, date }: { holidays: Holiday[]; date: string }) {
  const h = holidays.find((x) => x.holiday_date === date)
  if (!h) return null
  return (
    <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
      {fmtDate(date)} is {h.name} ({h.kind.replaceAll('_', ' ')}).
    </p>
  )
}

function CellLabel({
  shift,
  employed,
  changed,
  locked,
  leave,
}: {
  shift: Shift | null
  employed: boolean
  changed: boolean
  locked: boolean
  leave?: string
}) {
  if (!employed) return <span className="text-slate-300">—</span>
  return (
    <>
      <span className={`flex items-center gap-1 whitespace-nowrap font-semibold ${shift ? 'text-ink-900' : 'text-slate-400'}`}>
        {locked && <Lock className="size-3 text-slate-400" aria-label="paid" />}
        {shift ? shiftShort(shift) : 'Rest'}
        {changed && <span className="sr-only"> (changed for this date)</span>}
      </span>
      {leave ? (
        <span className="max-w-20 truncate text-[10px] font-medium text-violet-700" title={leave}>{leave}</span>
      ) : shift?.name ? (
        <span className="max-w-20 truncate text-[10px] text-slate-400">{shift.name}</span>
      ) : null}
    </>
  )
}

function RosterDayModal({
  employee,
  date,
  regular,
  change,
  templates,
  onClose,
  onSaved,
}: {
  employee: Employee
  date: string
  /** the shift the weekly schedule gives that date */
  regular: Shift | null
  change?: { id: string; shift: Shift | null; note: string }
  templates: ShiftTemplate[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [mode, setMode] = useState<'regular' | 'change'>(change ? 'change' : 'regular')
  const [shift, setShift] = useState<Shift | null>(change ? change.shift : regular)
  const [note, setNote] = useState(change?.note ?? '')
  const [busy, setBusy] = useState(false)
  const problem = mode === 'change' && shift ? shiftProblem(shift) : ''

  async function save() {
    if (busy || problem) return
    setBusy(true)
    try {
      // the same as the weekly schedule is no change at all
      if (mode === 'regular' || (sameShift(shift, regular) && !note.trim())) {
        if (change) {
          const { error } = await supabase.from('schedule_overrides').delete().eq('id', change.id)
          if (error) throw error
        }
      } else {
        const { error } = await supabase
          .from('schedule_overrides')
          .upsert({ employee_id: employee.id, work_date: date, shift, note: note.trim() }, { onConflict: 'employee_id,work_date' })
        if (error) throw error
      }
      toast('success', 'Schedule saved (audit-logged). Recompute any draft payroll for this date.')
      await onSaved()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not save the schedule'))
    } finally {
      setBusy(false)
    }
  }

  const option = (key: 'regular' | 'change', title: string, sub: string) => (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${mode === key ? 'border-brand-600 bg-brand-50/60' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" className="mt-0.5 size-4 accent-brand-700" checked={mode === key} onChange={() => setMode(key)} />
      <span>
        <span className="block text-sm font-semibold text-ink-900">{title}</span>
        <span className="block text-xs text-slate-500">{sub}</span>
      </span>
    </label>
  )

  return (
    <Modal open onClose={onClose} title={`${fullName(employee)} · ${new Date(`${date}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })}`}>
      <div className="space-y-4">
        <div className="space-y-2">
          {option('regular', 'Weekly schedule', regular ? `${shiftLabel(regular)} · ${shiftDetail(regular)}` : 'Rest day')}
          {option('change', 'Change this date only', 'A swapped shift, a moved rest day, a one-off schedule')}
        </div>
        {mode === 'change' && (
          <>
            <ShiftChooser value={shift} onChange={setShift} templates={templates} label="Shift on this date" />
            <Field label="Note (optional)">
              <Input value={note} maxLength={300} placeholder="e.g. covers for Ana" onChange={(e) => setNote(e.target.value)} />
            </Field>
          </>
        )}
        {problem && <p className="text-xs font-semibold text-rose-600">{problem}</p>}
        <Button className="w-full" disabled={busy || !!problem} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- shift templates ----------

interface TemplateForm {
  id?: string
  name: string
  shift: Shift
  active: boolean
}

function Shifts({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [templates, setTemplates] = useState<ShiftTemplate[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<TemplateForm | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoadError('')
    try {
      setTemplates(await fetchShiftTemplates(entity.id))
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the shifts'))
    }
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  async function save(f: TemplateForm) {
    if (busy) return
    const name = f.name.trim()
    const problem = !name ? 'Give the shift a name.' : shiftProblem(f.shift)
    if (problem) {
      toast('error', problem)
      return
    }
    setBusy(true)
    try {
      const row = { name, shift: cleanShift(f.shift), active: f.active }
      const { error } = f.id
        ? await supabase.from('shift_templates').update(row).eq('id', f.id)
        : await supabase.from('shift_templates').insert({ ...row, entity_id: entity.id, sort_order: templates?.length ?? 0 })
      if (error) throw error
      toast('success', f.id ? 'Shift updated. Schedules already set keep their times.' : 'Shift added.')
      setEditing(null)
      await load()
    } catch (err) {
      const msg = errorMessage(err, 'Could not save the shift')
      toast('error', /name_unique/.test(msg) ? 'Another shift already has this name.' : msg)
    } finally {
      setBusy(false)
    }
  }

  async function remove(t: ShiftTemplate) {
    if (!confirm(`Delete the shift "${t.name}"? Schedules that use it keep their times.`)) return
    const { error } = await supabase.from('shift_templates').delete().eq('id', t.id)
    if (error) toast('error', errorMessage(error, 'Could not delete the shift'))
    else await load()
  }

  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!templates) return <Spinner />
  return (
    <Card
      title="Shift templates"
      icon={<Clock />}
      actions={
        <Button variant="secondary" onClick={() => setEditing({ name: '', shift: NEW_SHIFT, active: true })}>
          <Plus className="size-4" /> Add shift
        </Button>
      }
    >
      {templates.length === 0 ? (
        <EmptyState
          title="No shifts yet"
          sub="Add the shifts this client uses (e.g. Opening 6:00 AM–3:00 PM, Closing 2:00 PM–11:00 PM, Half day Saturday) to pick them in the roster and in each employee's schedule."
        />
      ) : (
        <ul className="divide-y divide-slate-100">
          {templates.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-900">
                  {t.name} {!t.active && <Badge tone="slate">not offered</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {shiftLabel(t.shift)} · {shiftDetail(t.shift)}
                </p>
              </div>
              <div className="flex gap-1">
                <IconButton size="sm" label={`Edit ${t.name}`} onClick={() => setEditing({ id: t.id, name: t.name, shift: t.shift, active: t.active })}>
                  <Pencil className="size-4" />
                </IconButton>
                <IconButton size="sm" label={`Delete ${t.name}`} onClick={() => remove(t)} className="text-rose-600">
                  <Trash2 className="size-4" />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        A schedule keeps the times it was given: editing a shift here changes what is offered next, not schedules
        already set. Overtime starts after {plural(Number(entity.standard_hours_per_day) || 8, 'hour')} unless the shift is a
        compressed workweek day.
      </p>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? 'Edit shift' : 'Add shift'}>
        {editing && (
          <div className="space-y-4">
            <Field label="Name">
              <Input value={editing.name} maxLength={60} placeholder="e.g. Opening" onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <ShiftFields value={editing.shift} onChange={(shift) => setEditing({ ...editing, shift })} />
            <Toggle checked={editing.active} onChange={(active) => setEditing({ ...editing, active })} label="Offer this shift when scheduling" />
            <Button className="w-full" disabled={busy} onClick={() => save(editing)}>
              {busy ? 'Saving…' : 'Save shift'}
            </Button>
          </div>
        )}
      </Modal>
    </Card>
  )
}
