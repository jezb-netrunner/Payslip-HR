// Admin-entered time in / time out. Two grids over the same row editor:
// one date for every employee (daily logbook entry), or one employee over a
// date range (a DTR for the cutoff). Times are Manila wall time; an out time
// earlier than the in time is the next morning (overnight shift). Paid
// periods are locked by the database.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Lock, Save, Wand2, XCircle } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, NoClient, PageHeader, Select, Spinner, TableShell, Tabs, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, getHolidaysBetween, isActiveOn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, Holiday, TimeCorrectionRequest, TimeEntry } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtDateTime, fmtHours, fullName, plural } from '../../lib/format'
import { addDays, eachDate, hhmmToMinutes, isoWeekday, manilaDateStr, manilaHHMM, manilaWallToIso, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'

export default function Timesheets() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  const [tab, setTab] = useState('daily')
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return (
    <div>
      <PageHeader
        title="Time In / Out"
        subtitle="Enter each employee's actual time in and time out (Philippine time). Attendance feeds payroll directly; paid periods lock automatically."
      />
      <Tabs
        tabs={[
          { key: 'daily', label: 'Daily sheet' },
          { key: 'employee', label: 'Per employee (cutoff)' },
          { key: 'corrections', label: 'Correction requests' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'daily' && <DailySheet key={entity.id} entity={entity} />}
      {tab === 'employee' && <EmployeeSheet key={entity.id} entity={entity} />}
      {tab === 'corrections' && <Corrections key={entity.id} entity={entity} />}
    </div>
  )
}

// ---------- shared row model ----------

interface Row {
  key: string
  employee: Employee
  date: string
  entry: TimeEntry | null
  extra: TimeEntry[]
  timeIn: string
  timeOut: string
  locked: boolean
  holiday?: Holiday
}

function rowKey(employeeId: string, date: string) {
  return `${employeeId}|${date}`
}

function isScheduled(e: Employee, date: string) {
  return e.work_schedule.days.includes(isoWeekday(date))
}

/** Minutes worked (before break) for an in/out pair; out ≤ in = next day. */
function spanMinutes(timeIn: string, timeOut: string): number | null {
  if (!timeIn || !timeOut) return null
  let m = hhmmToMinutes(timeOut) - hhmmToMinutes(timeIn)
  if (m <= 0) m += 1440
  return m
}

async function lockedKeys(entityId: string, start: string, end: string): Promise<Set<string>> {
  const { data: runs } = await supabase
    .from('payroll_runs')
    .select('id, period_start, period_end')
    .eq('entity_id', entityId)
    .in('status', ['finalized', 'paid'])
    .in('run_type', ['regular', 'special', 'final_pay'])
    .lte('period_start', end)
    .gte('period_end', start)
  const out = new Set<string>()
  if (!runs?.length) return out
  const { data: slips } = await supabase
    .from('payslips')
    .select('employee_id, payroll_run_id')
    .in('payroll_run_id', runs.map((r) => r.id))
  for (const s of slips ?? []) {
    const r = runs.find((x) => x.id === s.payroll_run_id)
    if (!r) continue
    for (const d of eachDate(r.period_start > start ? r.period_start : start, r.period_end < end ? r.period_end : end)) {
      out.add(rowKey(s.employee_id as string, d))
    }
  }
  return out
}

function buildRows(
  pairs: { employee: Employee; date: string }[],
  entries: TimeEntry[],
  locked: Set<string>,
  holidays: Holiday[],
): Row[] {
  const byKey = new Map<string, TimeEntry[]>()
  for (const t of entries) {
    const k = rowKey(t.employee_id, t.work_date)
    byKey.set(k, [...(byKey.get(k) ?? []), t].sort((a, b) => a.clock_in.localeCompare(b.clock_in)))
  }
  return pairs.map(({ employee, date }) => {
    const k = rowKey(employee.id, date)
    const list = byKey.get(k) ?? []
    const entry = list[0] ?? null
    return {
      key: k,
      employee,
      date,
      entry,
      extra: list.slice(1),
      timeIn: entry ? manilaHHMM(entry.clock_in) : '',
      timeOut: entry?.clock_out ? manilaHHMM(entry.clock_out) : '',
      locked: locked.has(k),
      holiday: holidays.find((h) => h.holiday_date === date),
    }
  })
}

/**
 * Time in after midnight on an overnight shift (e.g. 00:30 on a 22:00–06:00
 * schedule) falls on the day after the work date. An unchanged time keeps
 * the day it was stored with (corrections may have put it there).
 */
function timeInNextDay(r: Row): boolean {
  if (r.entry && manilaHHMM(r.entry.clock_in) === r.timeIn) {
    return manilaDateStr(new Date(r.entry.clock_in)) > r.date
  }
  const { start, end } = r.employee.work_schedule
  return hhmmToMinutes(end) <= hhmmToMinutes(start) && hhmmToMinutes(r.timeIn) < hhmmToMinutes(end)
}

function changed(r: Row): boolean {
  const origIn = r.entry ? manilaHHMM(r.entry.clock_in) : ''
  const origOut = r.entry?.clock_out ? manilaHHMM(r.entry.clock_out) : ''
  return r.timeIn !== origIn || r.timeOut !== origOut
}

/** Persist edited rows; returns the number saved and per-row errors. */
async function saveRows(rows: Row[]): Promise<{ saved: number; errors: string[] }> {
  let saved = 0
  const errors: string[] = []
  for (const r of rows.filter(changed)) {
    const label = `${fullName(r.employee)} ${fmtDate(r.date)}`
    try {
      if (!r.timeIn && !r.timeOut) {
        if (r.entry) {
          const { error } = await supabase.from('time_entries').delete().eq('id', r.entry.id)
          if (error) throw error
        }
      } else {
        if (!r.timeIn) throw new Error('time in is required')
        const inNext = timeInNextDay(r)
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
      errors.push(`${label}: ${errorMessage(err, 'failed')}`)
    }
  }
  return { saved, errors }
}

function RowCells({ row, onChange }: { row: Row; onChange: (patch: Partial<Row>) => void }) {
  const mins = spanMinutes(row.timeIn, row.timeOut)
  const net = mins === null ? null : mins >= 360 ? Math.max(0, mins - row.employee.work_schedule.break_minutes) : mins
  const inNext = !!row.timeIn && timeInNextDay(row)
  const overnight = !!row.timeIn && !!row.timeOut && (inNext || hhmmToMinutes(row.timeOut) <= hhmmToMinutes(row.timeIn))
  const disabled = row.locked || row.extra.length > 0
  return (
    <>
      <Td>
        <Input
          type="time"
          value={row.timeIn}
          disabled={disabled}
          onChange={(e) => onChange({ timeIn: e.target.value })}
          className={`w-32 ${changed(row) ? 'border-accent-400 bg-accent-50' : ''}`}
        />
        {inNext && <p className="mt-0.5 text-[10px] text-violet-600">next day</p>}
      </Td>
      <Td>
        <Input
          type="time"
          value={row.timeOut}
          disabled={disabled}
          onChange={(e) => onChange({ timeOut: e.target.value })}
          className={`w-32 ${changed(row) ? 'border-accent-400 bg-accent-50' : ''}`}
        />
        {overnight && <p className="mt-0.5 text-[10px] text-violet-600">next day</p>}
      </Td>
      <Td className="whitespace-nowrap text-xs text-slate-500">
        {net === null ? (row.timeIn && !row.timeOut ? <Badge tone="amber">no time out</Badge> : '—') : fmtHours(net)}
      </Td>
      <Td>
        <div className="flex items-center gap-2">
          {row.locked ? (
            <span className="flex items-center gap-1 text-[11px] text-slate-400" title="Paid in a finalized payroll run — reopen the run to edit">
              <Lock className="size-3.5" /> paid
            </span>
          ) : row.extra.length > 0 ? (
            <span className="text-[11px] text-amber-700">
              split shift: +{row.extra.length} entr{row.extra.length > 1 ? 'ies' : 'y'} (
              {row.extra.map((x) => `${manilaHHMM(x.clock_in)}–${x.clock_out ? manilaHHMM(x.clock_out) : '?'}`).join(', ')})
            </span>
          ) : (
            <>
              <button
                onClick={() => onChange({ timeIn: row.employee.work_schedule.start, timeOut: row.employee.work_schedule.end })}
                className="text-[11px] font-semibold text-brand-600 hover:text-brand-800"
              >
                Schedule
              </button>
              {(row.timeIn || row.timeOut) && (
                <button
                  onClick={() => onChange({ timeIn: '', timeOut: '' })}
                  className="text-[11px] font-semibold text-slate-400 hover:text-rose-600"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>
      </Td>
    </>
  )
}

// ---------- daily sheet: every employee, one date ----------

function DailySheet({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [date, setDate] = useState(todayManila())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [onlyScheduled, setOnlyScheduled] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [emps, { data: ent }, locked, hols] = await Promise.all([
      getEmployees(entity.id),
      supabase.from('time_entries').select('*').eq('entity_id', entity.id).eq('work_date', date),
      lockedKeys(entity.id, date, date),
      getHolidaysBetween(entity.id, date, date),
    ])
    const active = emps.filter((e) => e.hire_date <= date && isActiveOn(e, date))
    setRows(buildRows(active.map((employee) => ({ employee, date })), (ent ?? []) as TimeEntry[], locked, hols))
    setLoading(false)
  }, [entity.id, date])

  useEffect(() => {
    load()
  }, [load])

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const shown = rows.filter((r) => !onlyScheduled || isScheduled(r.employee, date))
  const dirty = rows.filter(changed).length

  function fillScheduled() {
    setRows((rs) =>
      rs.map((r) =>
        !r.locked && !r.extra.length && !r.timeIn && !r.timeOut && isScheduled(r.employee, date)
          ? { ...r, timeIn: r.employee.work_schedule.start, timeOut: r.employee.work_schedule.end }
          : r,
      ),
    )
  }

  async function save() {
    setBusy(true)
    const { saved, errors } = await saveRows(rows)
    setBusy(false)
    if (errors.length) toast('error', errors.slice(0, 3).join(' · ') + (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''))
    if (saved) toast('success', `Saved ${saved} row/s (audit-logged).`)
    await load()
  }

  const holiday = rows[0]?.holiday
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Work date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
          </Field>
          <div className="flex gap-1 pb-0.5">
            <Button variant="ghost" onClick={() => setDate(addDays(date, -1))}>‹ Prev</Button>
            <Button variant="ghost" onClick={() => setDate(addDays(date, 1))}>Next ›</Button>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={onlyScheduled} onChange={(e) => setOnlyScheduled(e.target.checked)} className="rounded border-slate-300" />
            Scheduled today only
          </label>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={fillScheduled}>
            <Wand2 className="size-4" /> Fill scheduled with shift times
          </Button>
          <Button disabled={busy || dirty === 0} onClick={save}>
            <Save className="size-4" /> {busy ? 'Saving…' : `Save${dirty ? ` (${dirty})` : ''}`}
          </Button>
        </div>
      </div>
      {holiday && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fmtDate(date)} is {holiday.name} ({holiday.kind.replaceAll('_', ' ')}) — work today earns holiday premiums.
        </p>
      )}
      {loading ? (
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
            {shown.map((r) => (
              <tr key={r.key} className={r.locked ? 'bg-slate-50/70' : ''}>
                <Td>
                  <p className="font-semibold text-slate-800">{fullName(r.employee)}</p>
                  <p className="text-xs text-slate-400">{r.employee.employee_no}</p>
                </Td>
                <Td className="text-xs">
                  {isScheduled(r.employee, date) ? (
                    `${r.employee.work_schedule.start}–${r.employee.work_schedule.end}`
                  ) : (
                    <Badge tone="slate">rest day</Badge>
                  )}
                </Td>
                <RowCells row={r} onChange={(p) => patch(r.key, p)} />
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
      <p className="mt-3 text-[11px] text-slate-400">
        Leave a scheduled day blank for an absence (or file the employee's leave). Every change is audit-logged.
      </p>
    </Card>
  )
}

// ---------- per-employee sheet: one employee, a date range ----------

function EmployeeSheet({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState(addDays(todayManila(), -14))
  const [to, setTo] = useState(todayManila())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getEmployees(entity.id).then((emps) => {
      setEmployees(emps)
      setEmployeeId((cur) => cur || emps.find((e) => isActiveOn(e, todayManila()))?.id || '')
    })
  }, [entity.id])

  const employee = useMemo(() => employees.find((e) => e.id === employeeId) ?? null, [employees, employeeId])

  const load = useCallback(async () => {
    if (!employee || to < from) {
      setRows([])
      return
    }
    setLoading(true)
    const [{ data: ent }, locked, hols] = await Promise.all([
      supabase.from('time_entries').select('*').eq('employee_id', employee.id).gte('work_date', from).lte('work_date', to),
      lockedKeys(entity.id, from, to),
      getHolidaysBetween(entity.id, from, to),
    ])
    const dates = eachDate(from, to).filter((d) => d >= employee.hire_date && isActiveOn(employee, d))
    setRows(buildRows(dates.map((date) => ({ employee, date })), (ent ?? []) as TimeEntry[], locked, hols))
    setLoading(false)
  }, [employee, from, to, entity.id])

  useEffect(() => {
    load()
  }, [load])

  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const dirty = rows.filter(changed).length

  async function save() {
    setBusy(true)
    const { saved, errors } = await saveRows(rows)
    setBusy(false)
    if (errors.length) toast('error', errors.slice(0, 3).join(' · '))
    if (saved) toast('success', `Saved ${plural(saved, 'day')} (audit-logged).`)
    await load()
  }

  const totalMinutes = rows.reduce((s, r) => {
    const m = spanMinutes(r.timeIn, r.timeOut)
    if (m === null) return s
    return s + (m >= 360 ? Math.max(0, m - r.employee.work_schedule.break_minutes) : m)
  }, 0)

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Employee">
            <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="w-64">
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {fullName(e)} ({e.employee_no}){isActiveOn(e, todayManila()) ? '' : ' — separated'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </Field>
        </div>
        <Button disabled={busy || dirty === 0} onClick={save}>
          <Save className="size-4" /> {busy ? 'Saving…' : `Save${dirty ? ` (${dirty})` : ''}`}
        </Button>
      </div>
      {!employee ? (
        <EmptyState title="Pick an employee" />
      ) : loading ? (
        <Spinner />
      ) : (
        <>
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
              {rows.map((r) => (
                <tr key={r.key} className={r.locked ? 'bg-slate-50/70' : ''}>
                  <Td className="whitespace-nowrap font-semibold">{fmtDate(r.date)}</Td>
                  <Td className="text-xs">
                    {new Date(`${r.date}T00:00:00`).toLocaleDateString('en-PH', { weekday: 'short' })}{' '}
                    {!isScheduled(r.employee, r.date) && <Badge tone="slate">rest</Badge>}
                    {r.holiday && <Badge tone={r.holiday.kind === 'regular' ? 'red' : 'amber'}>{r.holiday.name}</Badge>}
                  </Td>
                  <RowCells row={r} onChange={(p) => patch(r.key, p)} />
                </tr>
              ))}
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
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('time_correction_requests')
      .select('*, employees(*)')
      .eq('entity_id', entity.id)
      .order('created_at', { ascending: false })
      .limit(100)
    setRequests((data ?? []) as RequestWithEmployee[])
    setLoading(false)
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  async function review(id: string, approve: boolean) {
    const { error } = await supabase.rpc('review_time_correction', {
      p_request_id: id,
      p_approve: approve,
      p_notes: notes[id] || null,
    })
    if (error) toast('error', error.message)
    else {
      toast('success', approve ? 'Correction applied.' : 'Request rejected.')
      await load()
    }
  }

  if (loading) return <Spinner />
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
            <div>
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
              <p className="mt-1 text-xs italic text-slate-500">“{r.reason}”</p>
            </div>
            {r.status === 'pending' && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Review note (optional)"
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                  className="w-52"
                />
                <Button onClick={() => review(r.id, true)}>
                  <CheckCircle2 className="size-4" /> Approve
                </Button>
                <Button variant="danger" onClick={() => review(r.id, false)}>
                  <XCircle className="size-4" /> Reject
                </Button>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
