import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ban, CalendarDays, Check, Hourglass, ListChecks, Plus, Save, Tags, X } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, NoClient, PageHeader, Select, Spinner, TableShell, Tabs, Td, Textarea, Th, Toggle } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, getHolidaysBetween, isActiveOn } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, Holiday, LeaveRequest, LeaveType } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { errorMessage } from '../../lib/errors'
import { fmtDate, fullName, plural } from '../../lib/format'
import { countsCalendarDays, eligibleFrom, leaveDays, leaveDaysInYear, notYetUsable, showsBalance, usableOn } from '../../lib/leave'
import { fetchScheduleRows, resolversFor } from '../../lib/schedules'
import { useEmployeeSchedule } from '../../lib/useEmployeeSchedule'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { useQuickAction } from '../../lib/quickAction'
import { notifyPendingChanged } from '../../lib/pending'

type RequestFull = LeaveRequest & { employees: Employee; leave_types: LeaveType }

export default function LeavesAdmin() {
  const { entity } = useEntity()
  const { isCompanyAdmin } = useAuth()
  if (!entity) return <NoClient companyAdmin={isCompanyAdmin} />
  return <Leaves key={entity.id} entity={entity} />
}

function Leaves({ entity }: { entity: Entity }) {
  const toast = useToast()
  const [tab, setTab] = useState('pending')
  const [pending, setPending] = useState<RequestFull[]>([])
  const [recent, setRecent] = useState<RequestFull[]>([])
  const [types, setTypes] = useState<LeaveType[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingType, setEditingType] = useState<Partial<LeaveType> | null>(null)
  const [filing, setFiling] = useState(false)

  useQuickAction('leave', () => setFiling(true), !loading)

  const load = useCallback(async () => {
    setLoadError('')
    // every pending request however old, plus the latest of any status
    const [p, r, t] = await Promise.all([
      supabase
        .from('leave_requests')
        .select('*, employees(*), leave_types(*)')
        .eq('entity_id', entity.id)
        .eq('status', 'pending')
        .order('created_at'),
      supabase
        .from('leave_requests')
        .select('*, employees(*), leave_types(*)')
        .eq('entity_id', entity.id)
        .order('created_at', { ascending: false })
        .limit(300),
      supabase.from('leave_types').select('*').eq('entity_id', entity.id).order('code'),
    ])
    const err = p.error ?? r.error ?? t.error
    if (err) setLoadError(errorMessage(err, 'Failed to load'))
    else {
      setPending((p.data ?? []) as RequestFull[])
      setRecent((r.data ?? []) as RequestFull[])
      setTypes((t.data ?? []) as LeaveType[])
    }
    setLoading(false)
  }, [entity.id])

  useEffect(() => {
    load()
  }, [load])

  async function review(id: string, approve: boolean) {
    if (busyId) return
    setBusyId(id)
    try {
      const { data: userData } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('leave_requests')
        .update({
          status: approve ? 'approved' : 'rejected',
          reviewed_by: userData.user?.id ?? null,
          reviewed_at: new Date().toISOString(),
          review_notes: notes[id] || null,
        })
        .eq('id', id)
        .eq('status', 'pending')
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) toast('error', 'This request is no longer pending (the employee may have cancelled it).')
      else toast('success', approve ? 'Leave approved — payroll will treat these days accordingly.' : 'Leave rejected.')
    } catch (err) {
      toast('error', errorMessage(err, 'Review failed'))
    } finally {
      setBusyId(null)
      notifyPendingChanged()
      await load()
    }
  }

  /** Withdraw an approved leave (the database refuses it once its days were paid). */
  async function revoke(r: RequestFull) {
    if (busyId) return
    if (!confirm(`Revoke ${r.employees ? fullName(r.employees) : 'this'} leave (${fmtDate(r.start_date)} → ${fmtDate(r.end_date)})? Payroll will treat those days as worked or absent again.`)) return
    setBusyId(r.id)
    try {
      const { data, error } = await supabase
        .from('leave_requests')
        .update({ status: 'cancelled', review_notes: notes[r.id] || 'Revoked by admin' })
        .eq('id', r.id)
        .eq('status', 'approved')
        .select('id')
      if (error) throw error
      if (!data || data.length === 0) toast('error', 'This leave is no longer approved.')
      else toast('success', 'Leave revoked.')
    } catch (err) {
      toast('error', errorMessage(err, 'Could not revoke the leave'))
    } finally {
      setBusyId(null)
      notifyPendingChanged()
      await load()
    }
  }

  async function saveType() {
    if (!editingType?.code || !editingType.name) {
      toast('error', 'Code and name are required.')
      return
    }
    const months = Number(editingType.min_service_months ?? 0)
    if (!Number.isInteger(months) || months < 0 || months > 120) {
      toast('error', 'Months of service: a whole number from 0 to 120.')
      return
    }
    const payload = {
      entity_id: entity.id,
      code: editingType.code.trim().toUpperCase(),
      name: editingType.name.trim(),
      default_annual_days: Number(editingType.default_annual_days ?? 0),
      paid: editingType.paid ?? true,
      active: editingType.active ?? true,
      min_service_months: months,
    }
    const { error } = editingType.id
      ? await supabase.from('leave_types').update(payload).eq('id', editingType.id)
      : await supabase.from('leave_types').insert(payload)
    if (error) toast('error', errorMessage(error, 'Save failed'))
    else {
      setEditingType(null)
      await load()
    }
  }

  const shown = tab === 'pending' ? pending : recent

  return (
    <div>
      <PageHeader
        title="Leave Management"
        subtitle="Approved paid leaves count as paid days in payroll; unpaid leaves are deducted."
        actions={
          <Button onClick={() => setFiling(true)}>
            <Plus className="size-4" /> File leave
          </Button>
        }
      />
      <Tabs
        tabs={[
          { key: 'pending', label: 'Pending', count: pending.length, icon: <Hourglass /> },
          { key: 'all', label: 'All requests', icon: <ListChecks /> },
          { key: 'entitlements', label: 'Entitlements', icon: <CalendarDays /> },
          { key: 'types', label: 'Leave types', icon: <Tags /> },
        ]}
        active={tab}
        onChange={setTab}
      />

      {loading ? (
        <Spinner />
      ) : loadError ? (
        <Card>
          <p className="text-sm text-rose-600">
            {loadError}{' '}
            <button type="button" onClick={load} className="font-semibold underline">
              Try again
            </button>
          </p>
        </Card>
      ) : tab === 'entitlements' ? (
        <Entitlements entity={entity} types={types} />
      ) : tab === 'types' ? (
        <Card
          title={`Leave types — ${entity.name}`}
          actions={
            <Button variant="secondary" onClick={() => setEditingType({ paid: true, active: true, default_annual_days: 0, min_service_months: 0 })}>
              <Plus className="size-4" /> Add type
            </Button>
          }
        >
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th className="text-right">Days / year</Th>
                <Th>Usable after</Th>
                <Th>Paid</Th>
                <Th>Active</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {types.map((t) => (
                <tr key={t.id}>
                  <Td className="font-mono text-xs font-bold">{t.code}</Td>
                  <Td>{t.name}</Td>
                  <Td className="text-right">{Number(t.default_annual_days)}</Td>
                  <Td>{t.min_service_months > 0 ? `${t.min_service_months} months of service` : 'Day one'}</Td>
                  <Td>{t.paid ? <Badge tone="green">paid</Badge> : <Badge tone="slate">unpaid</Badge>}</Td>
                  <Td>{t.active ? 'Yes' : 'No'}</Td>
                  <Td>
                    <button type="button" onClick={() => setEditingType(t)} className="text-xs font-semibold text-brand-600">Edit</button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <p className="mt-3 text-xs text-slate-400">
            Seeded with the statutory leaves: SIL 5 days after 12 months of service (Art. 95), Maternity 105 calendar days
            (RA 11210), Paternity 7 (RA 8187), Solo Parent 7 after 6 months of service (RA 11861), VAWC 10 (RA 9262),
            Special Leave for Women 60 after 6 months of service (RA 9710). Add
            company leaves (e.g. VL/SL credits) as needed. Set individual credits under Entitlements — credits set for a
            year also let that employee use the leave before the service requirement is met.
          </p>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title={tab === 'pending' ? 'No pending leave requests' : 'No leave requests'} />
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-800">
                    {r.employees ? fullName(r.employees) : '—'}
                    <span className="ml-2 font-normal text-slate-500">
                      {r.leave_types?.name} · {plural(Number(r.days), 'day')}
                    </span>{' '}
                    <Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'amber' : 'slate'}>
                      {r.status}
                    </Badge>
                  </p>
                  <p className="mt-0.5 break-words text-xs text-slate-500">
                    {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
                    {r.reason ? ` · “${r.reason}”` : ''}
                  </p>
                  {r.review_notes && <p className="mt-0.5 break-words text-xs text-slate-400">Note: {r.review_notes}</p>}
                </div>
                {r.status === 'pending' && (
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <Input
                      aria-label="Review note"
                      placeholder="Note (optional)"
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                      className="w-full sm:w-48"
                    />
                    <Button variant="dark" disabled={busyId !== null} onClick={() => review(r.id, true)}>
                      <Check className="size-4" /> Approve
                    </Button>
                    <Button variant="secondary" disabled={busyId !== null} onClick={() => review(r.id, false)}>
                      <X className="size-4 text-rose-600" /> Reject
                    </Button>
                  </div>
                )}
                {r.status === 'approved' && (
                  <Button variant="ghost" disabled={busyId !== null} onClick={() => revoke(r)}>
                    <Ban className="size-4" /> Revoke
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={editingType !== null} onClose={() => setEditingType(null)} title={editingType?.id ? 'Edit leave type' : 'Add leave type'}>
        {editingType && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Code">
                <Input value={editingType.code ?? ''} onChange={(e) => setEditingType({ ...editingType, code: e.target.value })} className="uppercase" />
              </Field>
              <Field label="Name" className="sm:col-span-2">
                <Input value={editingType.name ?? ''} onChange={(e) => setEditingType({ ...editingType, name: e.target.value })} />
              </Field>
              <Field label="Days per year">
                <Input type="number" value={String(editingType.default_annual_days ?? 0)} onChange={(e) => setEditingType({ ...editingType, default_annual_days: Number(e.target.value) })} />
              </Field>
              <Field
                label="Usable after (months of service)"
                className="sm:col-span-2"
                hint="0 = from the first day. Service Incentive Leave: 12 (Labor Code Art. 95)."
              >
                <Input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  inputMode="numeric"
                  value={String(editingType.min_service_months ?? 0)}
                  onChange={(e) => setEditingType({ ...editingType, min_service_months: e.target.value === '' ? 0 : Number(e.target.value) })}
                />
              </Field>
            </div>
            <Toggle checked={editingType.paid ?? true} onChange={(v) => setEditingType({ ...editingType, paid: v })} label="Paid leave" />
            <Toggle checked={editingType.active ?? true} onChange={(v) => setEditingType({ ...editingType, active: v })} label="Active (employees can request it)" />
            <Button className="w-full" onClick={saveType}>Save</Button>
          </div>
        )}
      </Modal>

      {filing && (
        <FileLeaveModal
          entity={entity}
          types={types.filter((t) => t.active)}
          onClose={() => setFiling(false)}
          onFiled={async () => {
            setFiling(false)
            notifyPendingChanged()
            await load()
          }}
        />
      )}
    </div>
  )
}

// ---------- file a leave on an employee's behalf ----------

function FileLeaveModal({
  entity,
  types,
  onClose,
  onFiled,
}: {
  entity: Entity
  types: LeaveType[]
  onClose: () => void
  onFiled: () => void
}) {
  const toast = useToast()
  const today = todayManila()
  const [employees, setEmployees] = useState<Employee[]>([])
  // holidays of the range they were loaded for: the day count must never use another range's
  const [holidays, setHolidays] = useState<{ range: string; list: Holiday[] } | null>(null)
  const [f, setF] = useState({ employeeId: '', typeId: '', start: today, end: today, reason: '', approve: true })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getEmployees(entity.id)
      .then((emps) => setEmployees(emps.filter((e) => isActiveOn(e, today))))
      .catch((err) => toast('error', errorMessage(err, 'Failed to load employees')))
  }, [entity.id, today, toast])

  const range = `${f.start}|${f.end}`
  useEffect(() => {
    if (!f.start || !f.end || f.end < f.start) return
    let cancelled = false
    const r = `${f.start}|${f.end}`
    getHolidaysBetween(entity.id, f.start, f.end)
      .then((list) => {
        if (!cancelled) setHolidays({ range: r, list })
      })
      .catch((err) => {
        if (!cancelled) toast('error', errorMessage(err, 'Could not load holidays for the day count'))
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, f.start, f.end, toast])

  const employee = employees.find((e) => e.id === f.employeeId)
  const type = types.find((t) => t.id === f.typeId)
  // the database refuses it unless this year's credits were set: say so before saving
  const opens = employee && type && f.start && !usableOn(type, employee.hire_date, f.start, undefined) ? eligibleFrom(type, employee.hire_date) : null
  // workdays follow the employee's schedule for those dates (patterns, roster changes)
  const sched = useEmployeeSchedule(employee ?? null, f.start, f.end)
  const counted = holidays?.range === range && sched.ready
  const days =
    employee && counted && f.end >= f.start ? leaveDays(type, f.start, f.end, sched.resolve ?? employee.work_schedule, holidays.list) : 0

  async function save() {
    if (!counted) return
    if (!employee || !f.typeId || days <= 0) {
      toast('error', 'Pick the employee, the leave type and dates that include a scheduled workday.')
      return
    }
    setBusy(true)
    try {
      const { data: userData } = await supabase.auth.getUser()
      const { error } = await supabase.from('leave_requests').insert({
        employee_id: employee.id,
        leave_type_id: f.typeId,
        start_date: f.start,
        end_date: f.end,
        days,
        reason: f.reason.trim(),
        status: f.approve ? 'approved' : 'pending',
        ...(f.approve
          ? { reviewed_by: userData.user?.id ?? null, reviewed_at: new Date().toISOString(), review_notes: 'Filed by admin' }
          : {}),
      })
      if (error) throw error
      toast('success', f.approve ? 'Leave recorded as approved.' : 'Leave filed for review.')
      onFiled()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed to file the leave'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="File leave for an employee">
      <div className="space-y-4">
        <Field label="Employee">
          <Select value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>
            <option value="">Select…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {fullName(e)} ({e.employee_no})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Leave type">
          <Select value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}>
            <option value="">Select…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}{t.paid ? '' : ' (unpaid)'}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From">
            <Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label="To">
            <Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
        </div>
        {opens && type && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {notYetUsable(type, opens)} It can be filed sooner only if this employee has {f.start.slice(0, 4)} credits
            for it under Entitlements.
          </p>
        )}
        <p className="text-xs text-slate-500">
          {!employee
            ? 'Pick an employee to count the workdays.'
            : f.end < f.start
              ? 'The end date is before the start date.'
              : sched.error
                ? `${sched.error} — close and reopen to try again.`
                : !counted
                ? 'Counting workdays…'
                : countsCalendarDays(type)
                  ? `${plural(days, 'calendar day')} (${type?.name ?? 'this leave'} runs in calendar days).`
                  : `${plural(days, 'scheduled workday')} (holidays and rest days not counted).`}
        </p>
        <Field label="Reason">
          <Textarea rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </Field>
        <Toggle checked={f.approve} onChange={(v) => setF({ ...f, approve: v })} label="Record as approved (otherwise it waits in Pending)" />
        <Button className="w-full" disabled={busy || !counted} onClick={save}>
          {busy ? 'Saving…' : 'File leave'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- per-employee entitlements ----------

function Entitlements({ entity, types }: { entity: Entity; types: LeaveType[] }) {
  const toast = useToast()
  const thisYear = Number(todayManila().slice(0, 4))
  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState('')
  const [year, setYear] = useState(thisYear)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [used, setUsed] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    getEmployees(entity.id)
      .then((emps) => {
        setEmployees(emps)
        setEmployeeId((cur) => cur || emps.find((e) => isActiveOn(e, todayManila()))?.id || '')
      })
      .catch((err) => toast('error', errorMessage(err, 'Failed to load employees')))
  }, [entity.id, toast])

  const employee = useMemo(() => employees.find((e) => e.id === employeeId) ?? null, [employees, employeeId])

  const load = useCallback(async () => {
    const my = ++seq.current
    if (!employee) return
    setLoading(true)
    try {
      const [ents, leaves, hols, schedules] = await Promise.all([
        supabase.from('employee_leave_entitlements').select('*').eq('employee_id', employee.id).eq('year', year),
        supabase
          .from('leave_requests')
          .select('*')
          .eq('employee_id', employee.id)
          .eq('status', 'approved')
          .lte('start_date', `${year}-12-31`)
          .gte('end_date', `${year}-01-01`),
        getHolidaysBetween(entity.id, `${year}-01-01`, `${year}-12-31`),
        fetchScheduleRows({ entityId: entity.id, employeeId: employee.id }, `${year}-01-01`, `${year}-12-31`),
      ])
      if (ents.error) throw ents.error
      if (leaves.error) throw leaves.error
      if (my !== seq.current) return
      const v: Record<string, string> = {}
      for (const e of ents.data ?? []) v[e.leave_type_id as string] = String(Number(e.days))
      const u: Record<string, number> = {}
      const schedule = resolversFor([employee], schedules).get(employee.id) ?? employee.work_schedule
      for (const l of (leaves.data ?? []) as LeaveRequest[]) {
        u[l.leave_type_id] = (u[l.leave_type_id] ?? 0) + leaveDaysInYear(l, year, schedule, hols, types.find((t) => t.id === l.leave_type_id))
      }
      setValues(v)
      setSaved(v)
      setUsed(u)
    } catch (err) {
      if (my === seq.current) toast('error', errorMessage(err, 'Failed to load entitlements'))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [employee, year, entity.id, types, toast])

  useEffect(() => {
    load()
  }, [load])
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const dirty = types.filter((t) => (values[t.id] ?? '') !== (saved[t.id] ?? ''))

  async function save() {
    if (!employee) return
    for (const t of dirty) {
      const v = (values[t.id] ?? '').trim()
      if (v !== '' && !(Number(v) >= 0 && Number(v) <= 366)) {
        toast('error', `${t.name}: enter 0–366 days, or leave it blank for the default.`)
        return
      }
    }
    setBusy(true)
    try {
      for (const t of dirty) {
        const v = (values[t.id] ?? '').trim()
        const { error } =
          v === ''
            ? await supabase
                .from('employee_leave_entitlements')
                .delete()
                .eq('employee_id', employee.id)
                .eq('leave_type_id', t.id)
                .eq('year', year)
            : await supabase
                .from('employee_leave_entitlements')
                .upsert(
                  { employee_id: employee.id, leave_type_id: t.id, year, days: Number(v) },
                  { onConflict: 'employee_id,leave_type_id,year' },
                )
        if (error) throw error
      }
      toast('success', 'Entitlements saved.')
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
    } finally {
      setBusy(false)
      await loadRef.current()
    }
  }

  return (
    <Card
      title="Leave credits per employee"
      actions={
        <Button disabled={busy || loading || dirty.length === 0} onClick={save}>
          <Save className="size-4" /> {busy ? 'Saving…' : 'Save'}
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Employee">
          <Select
            value={employeeId}
            disabled={busy}
            onChange={(e) => {
              if (dirty.length === 0 || confirm('Discard unsaved changes?')) setEmployeeId(e.target.value)
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
        <Field label="Year">
          <Select
            value={year}
            disabled={busy}
            onChange={(e) => {
              if (dirty.length === 0 || confirm('Discard unsaved changes?')) setYear(Number(e.target.value))
            }}
            className="w-28"
          >
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        </Field>
      </div>
      {!employee ? (
        <EmptyState title="No employees yet" />
      ) : loading ? (
        <Spinner />
      ) : (
        <TableShell>
          <thead className="bg-slate-50">
            <tr>
              <Th>Leave type</Th>
              <Th className="text-right">Default</Th>
              <Th>Credits {year}</Th>
              <Th className="text-right">Used</Th>
              <Th className="text-right">Left</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {types.map((t) => {
              const set = (values[t.id] ?? '') !== ''
              const credit = set ? Number(values[t.id]) : Number(t.default_annual_days)
              // event-based statutory leaves and unpaid types are not a yearly balance until HR sets one
              const balance = t.paid && showsBalance(t, set ? Number(values[t.id]) : undefined)
              const u = used[t.id] ?? 0
              const from = eligibleFrom(t, employee.hire_date)
              // opens after Jan 1 of the year shown: usable only from then, unless a credit is set
              const opensInYear = from && from > `${year}-01-01` && !set ? from : null
              const notThisYear = opensInYear && opensInYear > `${year}-12-31`
              return (
                <tr key={t.id}>
                  <Td>
                    {t.name}
                    {!t.active && <span className="ml-1 text-xs text-slate-400">(inactive)</span>}
                    {opensInYear && (
                      <span className="block text-xs text-amber-700">
                        {notThisYear ? 'Not yet eligible this year — ' : ''}usable from {fmtDate(opensInYear)}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right text-slate-500">{Number(t.default_annual_days)}</Td>
                  <Td>
                    <Input
                      type="number"
                      min={0}
                      step="0.5"
                      aria-label={`${t.name} credits for ${year}`}
                      placeholder={showsBalance(t, undefined) ? `default ${Number(t.default_annual_days)}` : 'per event'}
                      value={values[t.id] ?? ''}
                      onChange={(e) => setValues({ ...values, [t.id]: e.target.value })}
                      className="w-28"
                    />
                  </Td>
                  <Td className="text-right">{u}</Td>
                  <Td className={`text-right font-semibold ${balance && credit - u < 0 ? 'text-rose-600' : 'text-slate-700'}`}>
                    {balance && !notThisYear ? credit - u : '—'}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </TableShell>
      )}
      <p className="mt-3 text-xs text-slate-400">
        Blank = the leave type's default. Event-based statutory leaves (maternity, paternity, solo parent, VAWC,
        special leave for women) show on the employee's portal only once a credit is set here. A leave that needs
        months of service (SIL: 12) opens on that anniversary; a credit set here for a year lets the employee use it
        sooner.
      </p>
    </Card>
  )
}
