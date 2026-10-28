import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Building2,
  BriefcaseBusiness,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Copy,
  DoorOpen,
  Gift,
  HandCoins,
  History,
  KeyRound,
  Landmark,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  StickyNote,
  TrendingUp,
  UserCheck,
  UserRound,
  UserX,
  Wallet,
} from 'lucide-react'
import AttendanceTimeline, { type TimelineLeave } from '../../components/AttendanceTimeline'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Field,
  IconButton,
  Input,
  LoadFailed,
  Modal,
  Select,
  Spinner,
  StatCard,
  StatGroup,
  Tabs,
  Textarea,
  Toggle,
} from '../../components/ui'
import { useToast } from '../../components/toast'
import { callAdminUsers, getHolidaysBetween, isActiveOn } from '../../lib/api'
import { fetchAll } from '../../lib/fetchAll'
import type {
  CareerEvent,
  EmployeePayRate,
  Employee,
  EmployeeAllowance,
  EmployeeTaxYear,
  EmploymentStatus,
  Entity,
  Holiday,
  PaymentMethod,
  Profile,
  RecurringDeduction,
  SeparationReason,
  TimeEntry,
} from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { useRecordClient } from '../../lib/recordClient'
import { fmtDate, fmtDateTime, fmtHours, fullName, money, personInitials, plural } from '../../lib/format'
import {
  ALLOWANCE_BASIS_LABELS,
  ALLOWANCE_CATEGORY_LABELS,
  EMPLOYMENT_STATUS_LABELS,
  FREQUENCY_LABELS,
  OUTPUT_PAY_LABELS,
  PAYMENT_METHOD_LABELS,
  SEPARATION_REASON_LABELS,
  LIQUIDATABLE_CATEGORIES,
  PAY_ITEM_TYPE_LABELS,
  SUPPLEMENTARY_ITEM_TYPES,
} from '../../lib/labels'
import { AUTHORIZED_DEDUCTIONS, DEDUCTION_CATEGORY_LABELS, repaymentText } from '../../lib/advances'
import { leaveWorkdays } from '../../lib/leave'
import { generateCodePart, weakCodeReason } from '../../lib/loginCode'
import { useEmployeeSchedule } from '../../lib/useEmployeeSchedule'
import { ScheduleTab } from './EmployeeSchedule'
import { OutputsTab } from './OutputsTab'
import { PayHistoryTab, PayRateModal } from './PayHistoryTab'
import { currentAndUpcoming, rateText } from '../../lib/payHistory'
import { eachDate, endOfMonth, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { dayTimeline } from '../../lib/timeline'
import type { AllowanceBasis, AllowanceCategory, DeMinimisData, DeMinimisKind, OutputPayClass, PayFrequency, PayItemType } from '../../payroll/types'
import type { PayRateReason } from '../../payroll/payRates'
import { ALLOWANCE_DE_MINIMIS, ceilingText, DE_MINIMIS_LABELS, fetchDeMinimis } from '../../lib/deMinimis'
import { philhealthNgProblem } from '../../payroll/philhealth'
import { errorMessage } from '../../lib/errors'

const eventLabels: Record<string, string> = {
  hired: 'Hired',
  regularized: 'Regularized',
  promoted: 'Promoted',
  transferred: 'Transferred',
  salary_adjustment: 'Salary Adjustment',
  disciplinary: 'Disciplinary Action',
  recognition: 'Recognition',
  separated: 'Separated',
  other: 'Note',
}

/**
 * Prev/next only change the URL, so each employee gets a fresh, keyed record:
 * otherwise the tabs' forms (and a freshly issued login code) would carry one
 * person's data over to the next, and saving would write it there. The open
 * tab is kept across prev/next.
 */
export default function EmployeeDetail() {
  const { id } = useParams()
  const [tab, setTab] = useState('profile')
  return <EmployeeRecord key={id} tab={tab} onTab={setTab} />
}

function EmployeeRecord({ tab, onTab: setTab }: { tab: string; onTab: (tab: string) => void }) {
  const { id } = useParams()
  const { entities } = useEntity()
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [events, setEvents] = useState<CareerEvent[]>([])
  const [rates, setRates] = useState<EmployeePayRate[]>([])
  const [allowances, setAllowances] = useState<EmployeeAllowance[]>([])
  const [deductions, setDeductions] = useState<RecurringDeduction[]>([])
  const [account, setAccount] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [siblings, setSiblings] = useState<string[]>([])
  const navigate = useNavigate()

  const load = useCallback(async () => {
    if (!id) return
    const [{ data: emp }, { data: evs }, { data: alw }, { data: ded }, { data: prof }, { data: rts }] = await Promise.all([
      supabase.from('employees').select('*').eq('id', id).maybeSingle(),
      supabase.from('career_events').select('*').eq('employee_id', id).order('effective_date', { ascending: false }),
      supabase.from('employee_allowances').select('*').eq('employee_id', id).order('created_at'),
      supabase.from('recurring_deductions').select('*').eq('employee_id', id).order('created_at'),
      supabase.from('profiles').select('*').eq('employee_id', id).maybeSingle(),
      supabase.from('employee_pay_rates').select('*').eq('employee_id', id).order('effective_from'),
    ])
    setEmployee((emp as Employee) ?? null)
    setEvents((evs ?? []) as CareerEvent[])
    setRates((rts ?? []) as EmployeePayRate[])
    setAllowances((alw ?? []) as EmployeeAllowance[])
    setDeductions((ded ?? []) as RecurringDeduction[])
    setAccount((prof as Profile) ?? null)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  // prev / next walk the employees the list shows by default (its order, the
  // separated left out) — plus this one if separated, so it keeps its place
  const entityId = employee?.entity_id
  useEffect(() => {
    if (!entityId) return
    const today = todayManila()
    fetchAll<{ id: string; separation_date: string | null }>((from, to) =>
      supabase.from('employees').select('id, separation_date').eq('entity_id', entityId).order('last_name').order('id').range(from, to),
    )
      .then((rows) => setSiblings(rows.filter((r) => r.id === id || isActiveOn(r, today)).map((r) => r.id)))
      .catch(() => setSiblings([]))
  }, [entityId, id])

  useRecordClient(employee?.entity_id, '/admin/employees')

  if (loading) return <Spinner />
  if (!employee) return <p className="text-sm text-slate-500">Employee not found.</p>
  const entity = entities.find((e) => e.id === employee.entity_id)
  if (!entity) return <p className="text-sm text-slate-500">This employee's client is not available to you.</p>

  const name = fullName(employee)
  const separated = !!employee.separation_date && employee.separation_date < todayManila()
  const pos = siblings.indexOf(employee.id)
  const prev = pos > 0 ? siblings[pos - 1] : null
  const next = pos >= 0 && pos < siblings.length - 1 ? siblings[pos + 1] : null

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-center gap-4">
          <IconButton round label="All employees" onClick={() => navigate('/admin/employees')}>
            <ArrowLeft className="size-4" />
          </IconButton>
          <Avatar name={name} initials={personInitials(employee)} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold text-ink-900">{name}</h1>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {separated ? (
                <Badge tone="slate">Separated</Badge>
              ) : employee.separation_date ? (
                <Badge tone="amber">Leaving</Badge>
              ) : (
                <Badge tone="solid">Active</Badge>
              )}
              {employee.is_minimum_wage_earner && <Badge tone="orange" dot={false}>MWE</Badge>}
            </div>
          </div>
        </div>
        <span className="hidden h-12 w-px bg-slate-200 xl:block" />
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <HeaderFact label="Client" value={entity.name} />
          <HeaderFact label="Employee ID" value={employee.employee_no} />
          <HeaderFact label="Position" value={employee.position || '—'} />
          <HeaderFact label="Date started" value={fmtDate(employee.hire_date)} />
          {employee.separation_date && (
            <HeaderFact
              label={separated ? 'Last day' : 'Leaving on'}
              value={`${fmtDate(employee.separation_date)}${employee.separation_reason ? ` · ${SEPARATION_REASON_LABELS[employee.separation_reason]}` : ''}`}
            />
          )}
        </dl>
        {siblings.length > 1 && pos >= 0 && (
          <div className="ml-auto flex items-center gap-2">
            <IconButton round label="Previous employee" disabled={!prev} onClick={() => prev && navigate(`/admin/employees/${prev}`)}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <IconButton round label="Next employee" disabled={!next} onClick={() => next && navigate(`/admin/employees/${next}`)}>
              <ChevronRight className="size-4" />
            </IconButton>
            <span className="whitespace-nowrap text-sm text-slate-500">
              {pos + 1} of {siblings.length}
            </span>
          </div>
        )}
      </div>
      <Tabs
        tabs={[
          { key: 'profile', label: 'Profile & Employment', icon: <UserRound /> },
          { key: 'time', label: 'Attendance', icon: <Clock /> },
          { key: 'schedule', label: 'Schedule', icon: <CalendarClock /> },
          { key: 'pay', label: 'Pay & Policy', icon: <Wallet /> },
          { key: 'history', label: 'Pay History', icon: <TrendingUp /> },
          ...(employee.output_pay ? [{ key: 'outputs', label: 'Outputs', icon: <ClipboardCheck /> }] : []),
          { key: 'career', label: 'Career History', icon: <History /> },
          { key: 'login', label: 'Login Code', icon: <KeyRound /> },
          { key: 'bir', label: 'BIR / Tax Year', icon: <Landmark /> },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'profile' && <ProfileTab employee={employee} onSaved={load} onSchedule={() => setTab('schedule')} />}
      {tab === 'time' && <AttendanceTab employee={employee} entity={entity} />}
      {tab === 'schedule' && <ScheduleTab employee={employee} entity={entity} />}
      {tab === 'pay' && (
        <PayTab employee={employee} entity={entity} rates={rates} allowances={allowances} deductions={deductions} onChanged={load} />
      )}
      {tab === 'history' && <PayHistoryTab employee={employee} entity={entity} rates={rates} onChanged={load} />}
      {tab === 'outputs' && employee.output_pay && <OutputsTab employee={employee} />}
      {tab === 'career' && <CareerTab employee={employee} rates={rates} events={events} onChanged={load} />}
      {tab === 'login' && <LoginTab employee={employee} entity={entity} account={account} onChanged={load} />}
      {tab === 'bir' && <BirTab employee={employee} />}
    </div>
  )
}

function HeaderFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-w-[16rem]">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd title={value} className="mt-0.5 truncate text-sm font-semibold text-ink-900">{value}</dd>
    </div>
  )
}

function AttendanceTab({ employee, entity }: { employee: Employee; entity: Entity }) {
  const today = todayManila()
  const graceMinutes = Number(entity.grace_period_minutes) || 0
  const standardHoursPerDay = Number(entity.standard_hours_per_day) || 8
  const [month, setMonth] = useState(today.slice(0, 7))
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [leaves, setLeaves] = useState<TimelineLeave[]>([])
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const seq = useRef(0)
  const start = `${month}-01`
  const end = endOfMonth(start)
  // the shifts the month was scheduled (patterns, roster changes)
  const schedule = useEmployeeSchedule(employee, start, end)
  const scheduleOf = schedule.resolve ?? employee.work_schedule

  const load = useCallback(async () => {
    // quick month clicks: only the latest request may fill the page
    const my = ++seq.current
    setLoading(true)
    setLoadError('')
    const [ent, lv, hol] = await Promise.all([
      supabase
        .from('time_entries')
        .select('*')
        .eq('employee_id', employee.id)
        .gte('work_date', start)
        .lte('work_date', end)
        .order('clock_in'),
      supabase
        .from('leave_requests')
        .select('start_date, end_date, leave_types(name)')
        .eq('employee_id', employee.id)
        .eq('status', 'approved')
        .lte('start_date', end)
        .gte('end_date', start),
      getHolidaysBetween(employee.entity_id, start, end).then(
        (data) => ({ data, error: null }),
        (error: unknown) => ({ data: [] as Holiday[], error }),
      ),
    ])
    if (my !== seq.current) return
    if (ent.error || lv.error || hol.error) setLoadError(errorMessage(ent.error ?? lv.error ?? hol.error, 'Could not load attendance'))
    setEntries((ent.data ?? []) as TimeEntry[])
    setHolidays(hol.data)
    setLeaves(
      ((lv.data ?? []) as unknown as { start_date: string; end_date: string; leave_types: { name: string } | null }[]).map((l) => ({
        start_date: l.start_date,
        end_date: l.end_date,
        label: l.leave_types?.name ?? 'Leave',
      })),
    )
    setLoading(false)
  }, [employee.id, employee.entity_id, start, end])

  useEffect(() => {
    load()
  }, [load])

  const shift = (n: number) => {
    const [y, m] = month.split('-').map(Number)
    const t = y * 12 + (m - 1) + n
    setMonth(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  const days = [...new Set(entries.map((e) => e.work_date))]
  const worked = days.map((d) =>
    dayTimeline(
      d,
      entries.filter((e) => e.work_date === d),
      scheduleOf,
      { graceMinutes, standardHoursPerDay, holidays },
    ),
  )
  // charged leave days, as leave is counted elsewhere: scheduled workdays, not holidays
  const leaveDays = new Set(
    leaves.flatMap((l) =>
      eachDate(l.start_date < start ? start : l.start_date, l.end_date > end ? end : l.end_date).filter(
        (d) => leaveWorkdays(d, d, scheduleOf, holidays) > 0,
      ),
    ),
  ).size

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white">
      <div className="flex flex-wrap items-center gap-3 bg-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-ink-900">Attendance</p>
        <div className="mx-auto flex items-center gap-2">
          <IconButton label="Previous month" onClick={() => shift(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <Input type="month" aria-label="Month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-40" />
          <IconButton label="Next month" onClick={() => shift(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
        </div>
        {/* opens this employee's sheet for the month shown (up to today) */}
        <Link
          to={`/admin/timesheets?employee=${employee.id}&from=${start}&to=${end < today || start > today ? end : today}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-ink-800">
          <Clock className="size-4" /> Edit time in / out
        </Link>
      </div>
      <StatGroup bare className="border-b border-slate-200/80">
        <StatCard label="Days recorded" value={days.length} />
        <StatCard label="Hours worked" value={fmtHours(worked.reduce((sum, d) => sum + d.workedMinutes, 0))} sub="net of unpaid breaks" />
        <StatCard label="Late time in" value={worked.filter((d) => d.late).length} tone={worked.some((d) => d.late) ? 'warn' : 'default'} />
        <StatCard label="No time out" value={worked.filter((d) => d.open).length} tone={worked.some((d) => d.open) ? 'warn' : 'default'} />
        <StatCard label="Leave days" value={leaveDays} sub="approved" />
      </StatGroup>
      <div className="space-y-4 bg-canvas/60 p-4">
        {loadError ? (
          <LoadFailed message={loadError} onRetry={load} />
        ) : loading ? (
          <Spinner />
        ) : (
          <AttendanceTimeline
            entries={entries}
            schedule={scheduleOf}
            graceMinutes={graceMinutes}
            standardHoursPerDay={standardHoursPerDay}
            holidays={holidays}
            leaves={leaves}
            from={start}
            to={end}
            today={today}
            emptyTitle="No time entries this month"
            emptySub="Time in / out entered for this employee shows here day by day."
          />
        )}
      </div>
    </div>
  )
}

function ProfileTab({ employee, onSaved, onSchedule }: { employee: Employee; onSaved: () => Promise<void>; onSchedule: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ ...employee })
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Employee>(k: K, v: Employee[K]) => setF({ ...f, [k]: v })

  async function save() {
    if (!!f.separation_date !== !!f.separation_reason) {
      toast('error', 'A separation needs both the last day and the reason (or neither).')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase
        .from('employees')
        .update({
          employee_no: f.employee_no,
          first_name: f.first_name,
          middle_name: f.middle_name || null,
          last_name: f.last_name,
          suffix: f.suffix || null,
          email: f.email || null,
          phone: f.phone || null,
          address: f.address || null,
          zip_code: f.zip_code || null,
          birth_date: f.birth_date || null,
          gender: f.gender || null,
          civil_status: f.civil_status || null,
          nationality: f.nationality || 'Filipino',
          tin: f.tin || null,
          sss_no: f.sss_no || null,
          philhealth_no: f.philhealth_no || null,
          pagibig_no: f.pagibig_no || null,
          hire_date: f.hire_date,
          regularization_date: f.regularization_date || null,
          separation_date: f.separation_date || null,
          separation_reason: f.separation_reason || null,
          separation_remarks: f.separation_remarks || null,
          employment_status: f.employment_status,
          position: f.position,
          department: f.department,
          emergency_contact_name: f.emergency_contact_name || null,
          emergency_contact_phone: f.emergency_contact_phone || null,
          notes: f.notes || null,
        })
        .eq('id', employee.id)
      if (error) throw error
      toast('success', 'Saved (audit-logged).')
      await onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Save failed')
      toast('error', /tin_format/.test(msg) ? 'TIN must look like 000-000-000 or 000-000-000-00000.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Personal information" icon={<UserRound />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name"><Input value={f.first_name} onChange={(e) => set('first_name', e.target.value)} /></Field>
          <Field label="Middle name"><Input value={f.middle_name ?? ''} onChange={(e) => set('middle_name', e.target.value)} /></Field>
          <Field label="Last name"><Input value={f.last_name} onChange={(e) => set('last_name', e.target.value)} /></Field>
          <Field label="Suffix"><Input value={f.suffix ?? ''} onChange={(e) => set('suffix', e.target.value)} /></Field>
          <Field label="Birth date"><Input type="date" value={f.birth_date ?? ''} onChange={(e) => set('birth_date', e.target.value)} /></Field>
          <Field label="Nationality"><Input value={f.nationality} onChange={(e) => set('nationality', e.target.value)} /></Field>
          <Field label="Gender">
            <Select value={f.gender ?? ''} onChange={(e) => set('gender', e.target.value)}>
              <option value="">—</option>
              <option>Female</option>
              <option>Male</option>
              <option>Prefer not to say</option>
            </Select>
          </Field>
          <Field label="Civil status">
            <Select value={f.civil_status ?? ''} onChange={(e) => set('civil_status', e.target.value)}>
              <option value="">—</option>
              <option>Single</option>
              <option>Married</option>
              <option>Widowed</option>
              <option>Separated</option>
            </Select>
          </Field>
          <Field label="Phone"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Email (optional)"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <Field label="Registered address" className="sm:col-span-3">
            <Textarea rows={2} value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
          </Field>
          <Field label="ZIP code"><Input value={f.zip_code ?? ''} onChange={(e) => set('zip_code', e.target.value)} /></Field>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Emergency contact"><Input value={f.emergency_contact_name ?? ''} onChange={(e) => set('emergency_contact_name', e.target.value)} /></Field>
          <Field label="Emergency phone"><Input value={f.emergency_contact_phone ?? ''} onChange={(e) => set('emergency_contact_phone', e.target.value)} /></Field>
        </div>
        <h4 className="mt-5 mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Government IDs</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="TIN" hint="Required for BIR 1604-C / alphalist"><Input value={f.tin ?? ''} placeholder="000-000-000" onChange={(e) => set('tin', e.target.value)} /></Field>
          <Field label="SSS no."><Input value={f.sss_no ?? ''} onChange={(e) => set('sss_no', e.target.value)} /></Field>
          <Field label="PhilHealth no."><Input value={f.philhealth_no ?? ''} onChange={(e) => set('philhealth_no', e.target.value)} /></Field>
          <Field label="Pag-IBIG MID"><Input value={f.pagibig_no ?? ''} onChange={(e) => set('pagibig_no', e.target.value)} /></Field>
        </div>
      </Card>

      <div className="space-y-6">
        <Card title="Employment" icon={<BriefcaseBusiness />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Employee no."><Input value={f.employee_no} onChange={(e) => set('employee_no', e.target.value)} /></Field>
            <Field label="Employment status" hint="BIR codes R / P / C / CP / S / AL">
              <Select value={f.employment_status} onChange={(e) => set('employment_status', e.target.value as EmploymentStatus)}>
                {Object.entries(EMPLOYMENT_STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Position"><Input value={f.position} onChange={(e) => set('position', e.target.value)} /></Field>
            <Field label="Department"><Input value={f.department} onChange={(e) => set('department', e.target.value)} /></Field>
            <Field label="Date started"><Input type="date" value={f.hire_date} onChange={(e) => set('hire_date', e.target.value)} /></Field>
            <Field label="Regularization date"><Input type="date" value={f.regularization_date ?? ''} onChange={(e) => set('regularization_date', e.target.value)} /></Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Work schedule (shifts, rest days, changes from a date):{' '}
            <button type="button" onClick={onSchedule} className="font-semibold text-brand-700 underline">
              Schedule tab
            </button>
          </p>
        </Card>

        <Card title="Separation (resignation, termination, retirement…)" icon={<DoorOpen />}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Last day of employment">
              <Input type="date" value={f.separation_date ?? ''} onChange={(e) => set('separation_date', e.target.value)} />
            </Field>
            <Field label="Reason" hint="BIR codes: T resigned/terminated, TR transferred, R retired, D death">
              <Select
                value={f.separation_reason ?? ''}
                onChange={(e) => set('separation_reason', (e.target.value || null) as SeparationReason | null)}
              >
                <option value="">— still employed —</option>
                {Object.entries(SEPARATION_REASON_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label="Remarks" className="sm:col-span-2">
              <Input value={f.separation_remarks ?? ''} onChange={(e) => set('separation_remarks', e.target.value)} />
            </Field>
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            The employee stays on payroll through the last day; run their final pay (with annualization) and
            deactivate their login code when no longer needed.
          </p>
        </Card>

        <Card title="Notes" icon={<StickyNote />}>
          <Textarea rows={2} value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </Card>

        <Button disabled={busy} onClick={save} className="w-full">
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </div>
  )
}

function PayTab({
  employee,
  entity,
  rates,
  allowances,
  deductions,
  onChanged,
}: {
  employee: Employee
  entity: Entity
  rates: EmployeePayRate[]
  allowances: EmployeeAllowance[]
  deductions: RecurringDeduction[]
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  // cash advances have their own page (agreement, ledger, repayments)
  const advances = deductions.filter((d) => d.category === 'cash_advance')
  const owedOnAdvances = advances.reduce((s, d) => s + Number(d.balance ?? 0), 0)
  const openAdvances = advances.filter((d) => Number(d.balance ?? 0) > 0)
  const recurring = deductions.filter((d) => d.category !== 'cash_advance')
  const [changingRate, setChangingRate] = useState(false)
  const { current: rateNow, upcoming } = currentAndUpcoming(rates)
  const [f, setF] = useState({
    pay_frequency: employee.pay_frequency,
    days_per_year: employee.days_per_year === null ? '' : String(employee.days_per_year),
    is_mwe: employee.is_minimum_wage_earner,
    fixed_salary: employee.fixed_salary === true,
    thirteenth: employee.thirteenth_month_eligible !== false,
    output_pay: employee.output_pay ?? '',
    output_thirteenth: employee.output_thirteenth_month !== false,
    hazard_ref: employee.hazard_certification_ref ?? '',
    payment_method: employee.payment_method,
    bank_name: employee.bank_name ?? '',
    bank_account_no: employee.bank_account_no ?? '',
    ph_ng_type: employee.ph_ng_type ?? '',
    ph_ng_from_month: (employee.ph_ng_from_month ?? '').slice(0, 7),
    id_number: employee.id_number ?? '',
    id_valid_until: employee.id_valid_until ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [listBusy, setListBusy] = useState(false)
  const [editingAlw, setEditingAlw] = useState<AllowanceForm | null>(null)
  const [deMinimis, setDeMinimis] = useState<DeMinimisData | null>(null)
  useEffect(() => {
    fetchDeMinimis(todayManila()).then(setDeMinimis, () => setDeMinimis(null))
  }, [])
  const [editingDed, setEditingDed] = useState<DeductionForm | null>(null)

  async function savePay() {
    const dpy = f.days_per_year ? Number(f.days_per_year) : null
    if (dpy !== null && !(dpy > 0 && dpy <= 366)) {
      toast('error', 'Days-per-year factor must be between 1 and 366 (or blank for the client default).')
      return
    }
    const ngFrom = f.ph_ng_from_month ? `${f.ph_ng_from_month}-01` : ''
    const ngProblem = philhealthNgProblem(f.ph_ng_type, ngFrom, f.id_number, f.id_valid_until)
    if (ngProblem) {
      toast('error', ngProblem)
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase
        .from('employees')
        .update({
          pay_frequency: f.pay_frequency,
          days_per_year: f.days_per_year ? Number(f.days_per_year) : null,
          is_minimum_wage_earner: f.is_mwe,
          fixed_salary: f.fixed_salary,
          // the 13th month policy applies to a fixed salary only
          thirteenth_month_eligible: f.fixed_salary ? f.thirteenth : true,
          output_pay: f.output_pay || null,
          // and for output pay, to pay on top of the salary only
          output_thirteenth_month: f.output_pay && f.output_pay !== 'basic' ? f.output_thirteenth : true,
          hazard_certification_ref: f.hazard_ref.trim(),
          payment_method: f.payment_method,
          bank_name: f.bank_name || null,
          bank_account_no: f.bank_account_no || null,
          ph_ng_type: f.ph_ng_type || null,
          ph_ng_from_month: f.ph_ng_type ? ngFrom : null,
          id_number: f.ph_ng_type ? f.id_number.trim() : '',
          id_valid_until: f.ph_ng_type ? f.id_valid_until || null : null,
        })
        .eq('id', employee.id)
      if (error) throw error
      toast('success', 'Pay details saved.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  /** One write at a time: a double click must not add the same allowance or loan twice. */
  async function listWrite(fn: () => PromiseLike<{ error: unknown }>, ok: string): Promise<boolean> {
    if (listBusy) return false
    setListBusy(true)
    try {
      const { error } = await fn()
      if (error) throw error
      toast('success', ok)
      await onChanged()
      return true
    } catch (err) {
      toast('error', errorMessage(err, 'Save failed'))
      return false
    } finally {
      setListBusy(false)
    }
  }

  async function saveAllowance(a: AllowanceForm) {
    const amount = Number(a.amount)
    if (!a.label.trim() || !(amount > 0)) {
      toast('error', 'Enter a label and an amount above zero.')
      return
    }
    if (a.category === 'de_minimis' && !a.dm) {
      toast('error', 'Pick the de minimis benefit: only the benefits on the BIR list are de minimis (any other benefit is taxable).')
      return
    }
    const row = {
      label: a.label.trim(),
      amount,
      category: a.category,
      basis: a.basis,
      de_minimis_kind: a.category === 'de_minimis' ? a.dm || null : null,
      pay_item_type: itemTypeFor(a.category, a.itemType),
    }
    const done = await listWrite(
      () =>
        a.id
          ? supabase.from('employee_allowances').update(row).eq('id', a.id)
          : supabase.from('employee_allowances').insert({ ...row, employee_id: employee.id }),
      a.id ? 'Allowance updated (audit-logged).' : 'Allowance added.',
    )
    if (done) setEditingAlw(null)
  }

  async function saveDeduction(d: DeductionForm) {
    const amount = Number(d.amount)
    const balance = d.balance.trim() === '' ? null : Number(d.balance)
    if (!d.label.trim() || !(amount > 0)) {
      toast('error', 'Enter a label and an amount per payroll above zero.')
      return
    }
    if (balance !== null && !(balance >= 0)) {
      toast('error', 'The balance must be zero or more (blank = no limit).')
      return
    }
    if (d.start && d.end && d.end < d.start) {
      toast('error', 'The end date is before the start date.')
      return
    }
    if (AUTHORIZED_DEDUCTIONS.includes(d.category) && !d.authorized) {
      toast('error', 'Enter the date the employee signed the written authorization for this deduction (Labor Code Art. 113).')
      return
    }
    const row = {
      label: d.label.trim(),
      category: d.category,
      amount_per_period: amount,
      balance,
      start_date: d.start || null,
      end_date: d.end || null,
      authorized_on: d.authorized || null,
    }
    const done = await listWrite(
      () =>
        d.id
          ? supabase.from('recurring_deductions').update(row).eq('id', d.id)
          : supabase
              .from('recurring_deductions')
              .insert({ ...row, employee_id: employee.id, total_amount: balance }),
      d.id ? 'Deduction updated (audit-logged).' : 'Deduction added.',
    )
    if (done) setEditingDed(null)
  }

  const factor = f.days_per_year ? Number(f.days_per_year) : Number(entity.working_days_divisor)
  const daily = employee.pay_type === 'daily' ? Number(employee.daily_rate) : ((Number(employee.monthly_rate) || 0) * 12) / factor

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Pay and payroll policy" icon={<Wallet />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 px-3 py-2.5 sm:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm">
                <p className="text-xs text-slate-500">Pay rate{employee.pay_type === 'daily' ? ' (daily-rated: no work, no pay)' : ' (monthly-rated)'}</p>
                <p className="font-semibold text-ink-900">
                  {rateNow ? rateText(rateNow) : rateText({ pay_type: employee.pay_type, rate: employee.pay_type === 'monthly' ? employee.monthly_rate : employee.daily_rate })}
                  {rateNow && <span className="font-normal text-slate-500"> since {fmtDate(rateNow.effective_from)}</span>}
                </p>
                {upcoming.map((u) => (
                  <p key={u.id} className="text-xs text-slate-500">
                    From {fmtDate(u.effective_from)}: {rateText(u)}
                  </p>
                ))}
              </div>
              <Button size="sm" variant="secondary" onClick={() => setChangingRate(true)}>
                Change pay rate
              </Button>
            </div>
          </div>
          <Field label="Pay frequency" hint="The payroll runs this employee is included in">
            <Select value={f.pay_frequency} onChange={(e) => setF({ ...f, pay_frequency: e.target.value as PayFrequency })}>
              {Object.entries(FREQUENCY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Days-per-year factor" hint={`Blank = client default (${entity.working_days_divisor})`}>
            <Input type="number" min={1} max={366} value={f.days_per_year} placeholder={String(entity.working_days_divisor)} onChange={(e) => setF({ ...f, days_per_year: e.target.value })} />
          </Field>
          <Field label="Paid by">
            <Select value={f.payment_method} onChange={(e) => setF({ ...f, payment_method: e.target.value as PaymentMethod })}>
              {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <div />
          {f.payment_method !== 'cash' && (
            <>
              <Field label={f.payment_method === 'e_wallet' ? 'E-wallet provider' : 'Bank'}>
                <Input value={f.bank_name} onChange={(e) => setF({ ...f, bank_name: e.target.value })} />
              </Field>
              <Field label={f.payment_method === 'e_wallet' ? 'Wallet number' : 'Account no.'}>
                <Input value={f.bank_account_no} onChange={(e) => setF({ ...f, bank_account_no: e.target.value })} />
              </Field>
            </>
          )}
        </div>
        <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3">
          {employee.pay_type === 'monthly' ? (
            <>
              <Toggle
                checked={f.fixed_salary}
                onChange={(v) => setF({ ...f, fixed_salary: v })}
                label="Fixed salary, no timekeeping (executives, managers, field staff, consultants on an employee retainer)"
              />
              <p className="text-xs text-slate-500">
                The monthly rate pays each payroll: no time in/out needed, nothing docked for absence or lateness, no overtime,
                night differential or holiday premium. Leave without pay is still deducted. Service incentive leave follows
                the leave entitlements.
              </p>
              {f.fixed_salary && (
                <Toggle checked={f.thirteenth} onChange={(v) => setF({ ...f, thirteenth: v })} label="Gets 13th month pay (company policy)" />
              )}
            </>
          ) : (
            <p className="text-xs text-slate-500">A fixed salary without timekeeping needs a monthly rate (Pay History → Change pay rate).</p>
          )}
        </div>
        <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3">
          <Field label="Output pay" hint="Outputs are recorded on the Outputs tab, each once accepted, with its report; the payroll covering an output's date pays it.">
            <Select value={f.output_pay} onChange={(e) => setF({ ...f, output_pay: e.target.value as OutputPayClass | '' })}>
              <option value="">Not paid on output</option>
              {Object.entries(OUTPUT_PAY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          {f.output_pay === 'basic' && (
            <p className="text-xs text-slate-500">
              A worker paid by results (piece rate, or per deliverable without a salary): output pay is the basic pay. It counts
              toward the 13th month, PhilHealth is on at least the minimum wage, and each payroll warns when a period pays less
              than the minimum wage for the days worked. Any pay rate is paid on top.
            </p>
          )}
          {f.output_pay && f.output_pay !== 'basic' && (
            <>
              <p className="text-xs text-slate-500">
                Taxed as supplementary pay; SSS and Pag-IBIG count it, PhilHealth stays on the salary.
              </p>
              <Toggle
                checked={f.output_thirteenth}
                onChange={(v) => setF({ ...f, output_thirteenth: v })}
                label="Output pay counts toward the 13th month (company policy)"
              />
            </>
          )}
        </div>
        <div className="mt-4 space-y-2 rounded-lg bg-slate-50 p-3">
          <Toggle
            checked={f.is_mwe}
            onChange={(v) => setF({ ...f, is_mwe: v })}
            label="Minimum wage earner (SMW, holiday, OT, night differential, hazard pay tax-exempt)"
          />
          <p className="text-xs text-slate-500">
            Daily equivalent {money(daily)} vs client minimum {money(Number(entity.minimum_wage_daily))}
            {entity.minimum_wage_region ? ` (${entity.minimum_wage_region})` : ''}. Rest-day and special-day premiums
            of a minimum wage earner are taxable.
          </p>
          {f.is_mwe && (
            <Field
              label="Hazardous assignment certification (optional)"
              hint="DOLE or allied agency certification of an actual assignment to a danger, strife-torn or disease-infested area, or a distressed or isolated station. Without it, hazard pay is taxable."
            >
              <Input value={f.hazard_ref} maxLength={200} placeholder="Certification reference" onChange={(e) => setF({ ...f, hazard_ref: e.target.value })} />
            </Field>
          )}
          {Number(employee.rounding_balance) > 0 && (
            <p className="text-xs text-slate-500">
              Cash-rounding centavos owed to this employee: {money(Number(employee.rounding_balance))} (paid on the next payroll).
            </p>
          )}
        </div>
        <div className="mt-4 space-y-3 rounded-lg bg-slate-50 p-3">
          <Field
            label="PhilHealth employee half"
            hint="For a solo parent or a PWD the national government pays the employee half: nothing is deducted, the employer pays its usual half, and the government's half shows on the payslip as NG share – non-collectible (PhilHealth Circulars 2026-0015 and 2026-0017)."
          >
            <Select value={f.ph_ng_type} onChange={(e) => setF({ ...f, ph_ng_type: e.target.value as typeof f.ph_ng_type })}>
              <option value="">Deducted from pay</option>
              <option value="solo_parent">Paid by the government — solo parent</option>
              <option value="pwd">Paid by the government — person with disability</option>
            </Select>
          </Field>
          {f.ph_ng_type && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="First month"
                hint={
                  f.ph_ng_type === 'solo_parent'
                    ? 'The first month PhilHealth billing (SPA/EPRS) shows the solo-parent tag — not earlier than October 2026'
                    : 'The month the complete requirements were submitted to PhilHealth'
                }
              >
                <Input type="month" value={f.ph_ng_from_month} onChange={(e) => setF({ ...f, ph_ng_from_month: e.target.value })} />
              </Field>
              <Field label={f.ph_ng_type === 'solo_parent' ? 'Solo Parent ID (SPIC) no.' : 'PWD ID no.'}>
                <Input value={f.id_number} maxLength={60} onChange={(e) => setF({ ...f, id_number: e.target.value })} />
              </Field>
              <Field
                label={f.ph_ng_type === 'solo_parent' ? 'ID valid until' : 'ID valid until (optional)'}
                hint="The government share stops the month the ID expires; enter the renewed ID to continue it"
                className="sm:col-span-2"
              >
                <Input type="date" value={f.id_valid_until} onChange={(e) => setF({ ...f, id_valid_until: e.target.value })} />
              </Field>
            </div>
          )}
        </div>
        <Button className="mt-4" disabled={busy} onClick={savePay}>
          {busy ? 'Saving…' : 'Save pay details'}
        </Button>
      </Card>

      <Card
        title="Allowances and benefits"
        icon={<Gift />}
        actions={
          <Button variant="secondary" onClick={() => setEditingAlw({ label: '', amount: '', category: 'de_minimis', basis: 'monthly', dm: 'rice', itemType: '' })}>
            <Plus className="size-4" /> Add
          </Button>
        }
      >
        <div className="space-y-2">
          {allowances.length === 0 && <p className="text-sm text-slate-400">None.</p>}
          {allowances.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-slate-700">{a.label}</p>
                <p className="text-xs text-slate-400">
                  {money(Number(a.amount))} {ALLOWANCE_BASIS_LABELS[a.basis]} · {ALLOWANCE_CATEGORY_LABELS[a.category]}
                  {a.de_minimis_kind && ` · ${DE_MINIMIS_LABELS[a.de_minimis_kind]} (up to ${ceilingText(deMinimis?.ceilings[a.de_minimis_kind])})`}
                  {a.pay_item_type && ` · ${PAY_ITEM_TYPE_LABELS[a.pay_item_type]}`}
                  {!a.active && ' · inactive'}
                </p>
              </div>
              <div className="flex shrink-0 gap-3">
                <button
                  type="button"
                  onClick={() => setEditingAlw({ id: a.id, label: a.label, amount: String(a.amount), category: a.category, basis: a.basis, dm: a.de_minimis_kind ?? '', itemType: a.pay_item_type ?? '' })}
                  className="text-xs font-semibold text-brand-600"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={listBusy}
                  onClick={() =>
                    listWrite(
                      () => supabase.from('employee_allowances').update({ active: !a.active }).eq('id', a.id),
                      a.active ? 'Allowance stopped.' : 'Allowance resumed.',
                    )
                  }
                  className="text-xs font-semibold text-brand-600 disabled:text-slate-300"
                >
                  {a.active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          De minimis benefits are non-taxable up to their BIR ceilings (RR 29-2025); the list is exclusive, so any other
          benefit, and pay above a ceiling, is taxable. Bonuses share the ₱90,000 cap with the 13th month pay. COLA is
          exempt for minimum wage earners.
        </p>
      </Card>

      <Card
        title="Recurring deductions (every payroll)"
        icon={<Receipt />}
        className="lg:col-span-2"
        actions={
          <Button variant="secondary" onClick={() => setEditingDed({ label: '', category: 'other', amount: '', balance: '', start: '', end: '', authorized: '' })}>
            <Plus className="size-4" /> Add
          </Button>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {recurring.length === 0 && <p className="text-sm text-slate-400">None.</p>}
          {recurring.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-slate-700">{d.label}</p>
                <p className="text-xs text-slate-400">
                  {Number(d.amount_per_period) > 0 ? `${money(Number(d.amount_per_period))}/payroll` : 'set in each payroll'} · {DEDUCTION_CATEGORY_LABELS[d.category] ?? d.category.replaceAll('_', ' ')}
                  {d.balance !== null && ` · balance ${money(Number(d.balance))}`}
                  {(d.start_date || d.end_date) && ` · ${d.start_date ? fmtDate(d.start_date) : '…'} → ${d.end_date ? fmtDate(d.end_date) : '…'}`}
                  {!d.active && ' · inactive'}
                </p>
              </div>
              <div className="flex shrink-0 gap-3">
                <button
                  type="button"
                  onClick={() =>
                    setEditingDed({
                      id: d.id,
                      label: d.label,
                      category: d.category,
                      amount: String(d.amount_per_period),
                      balance: d.balance === null ? '' : String(d.balance),
                      start: d.start_date ?? '',
                      end: d.end_date ?? '',
                      authorized: d.authorized_on ?? '',
                    })
                  }
                  className="text-xs font-semibold text-brand-600"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={listBusy}
                  onClick={() =>
                    listWrite(
                      () => supabase.from('recurring_deductions').update({ active: !d.active }).eq('id', d.id),
                      d.active ? 'Deduction paused.' : 'Deduction resumed.',
                    )
                  }
                  className="text-xs font-semibold text-brand-600 disabled:text-slate-300"
                >
                  {d.active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Deductions with a balance auto-deactivate when it reaches zero (decremented on every finalized payroll);
          start and end dates limit the payrolls they apply to. For one-off items use payroll adjustments on the run
          itself.
        </p>
      </Card>

      <Card
        title="Cash advances"
        icon={<HandCoins />}
        className="lg:col-span-2"
        actions={
          <Link to={`/admin/advances?employee=${employee.id}&new=advance`} className="text-xs font-semibold text-brand-600">
            Record advance
          </Link>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-600">
            {openAdvances.length > 0 ? (
              <>
                Owes <b className="text-ink-900">{money(owedOnAdvances)}</b> on {plural(openAdvances.length, 'advance')} ·{' '}
                {repaymentText(openAdvances.filter((d) => !d.start_date || d.start_date <= todayManila()))}
              </>
            ) : advances.length > 0 ? (
              `No balance owed (${plural(advances.length, 'advance')} fully paid).`
            ) : (
              'No cash advances.'
            )}
          </p>
          {advances.length > 0 && (
            <Link to={`/admin/advances?employee=${employee.id}`} className="text-xs font-semibold text-brand-600">
              View history
            </Link>
          )}
        </div>
      </Card>

      <Modal open={editingAlw !== null} onClose={() => setEditingAlw(null)} title={editingAlw?.id ? 'Edit allowance' : 'Add allowance'}>
        {editingAlw && (
          <div className="space-y-4">
            <Field label="Label">
              <Input placeholder="e.g. Rice subsidy" value={editingAlw.label} onChange={(e) => setEditingAlw({ ...editingAlw, label: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount (PHP)">
                <Input type="number" min={0} step="0.01" value={editingAlw.amount} onChange={(e) => setEditingAlw({ ...editingAlw, amount: e.target.value })} />
              </Field>
              <Field label="Basis">
                <Select value={editingAlw.basis} onChange={(e) => setEditingAlw({ ...editingAlw, basis: e.target.value as AllowanceBasis })}>
                  {Object.entries(ALLOWANCE_BASIS_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="BIR classification">
              <Select value={editingAlw.category} onChange={(e) => setEditingAlw({ ...editingAlw, category: e.target.value as AllowanceCategory })}>
                {Object.entries(ALLOWANCE_CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            {editingAlw.category === 'other_benefits' && (
              <Toggle
                checked={editingAlw.itemType === 'christmas_bonus'}
                onChange={(v) => setEditingAlw({ ...editingAlw, itemType: v ? 'christmas_bonus' : '' })}
                label="This is the Christmas bonus (not SSS compensation)"
              />
            )}
            {editingAlw.category === 'other_taxable' && (
              <Field label="Kind" hint="Commissions, profit sharing and fees are supplementary pay with their own BIR 2316 items">
                <Select
                  value={(SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(editingAlw.itemType) ? editingAlw.itemType : ''}
                  onChange={(e) => setEditingAlw({ ...editingAlw, itemType: e.target.value as PayItemType | '' })}
                >
                  <option value="">Other taxable allowance (regular)</option>
                  {SUPPLEMENTARY_ITEM_TYPES.map((t) => (
                    <option key={t} value={t}>{PAY_ITEM_TYPE_LABELS[t]}</option>
                  ))}
                </Select>
              </Field>
            )}
            {LIQUIDATABLE_CATEGORIES.includes(editingAlw.category) && !(SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(editingAlw.itemType) && (
              <Toggle
                checked={editingAlw.itemType === 'liquidated_allowance'}
                onChange={(v) => setEditingAlw({ ...editingAlw, itemType: v ? 'liquidated_allowance' : '' })}
                label="Subject to liquidation: a reimbursement of expenses (not SSS compensation)"
              />
            )}
            {editingAlw.category === 'de_minimis' && (
              <Field
                label="De minimis benefit"
                hint={editingAlw.dm ? `Non-taxable up to ${ceilingText(deMinimis?.ceilings[editingAlw.dm])}; anything above is taxable.` : undefined}
              >
                <Select value={editingAlw.dm} onChange={(e) => setEditingAlw({ ...editingAlw, dm: e.target.value as DeMinimisKind | '' })}>
                  <option value="">Pick the benefit…</option>
                  {ALLOWANCE_DE_MINIMIS.map((k) => (
                    <option key={k} value={k}>{DE_MINIMIS_LABELS[k]}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Button className="w-full" disabled={listBusy} onClick={() => saveAllowance(editingAlw)}>
              {listBusy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </Modal>

      <Modal open={editingDed !== null} onClose={() => setEditingDed(null)} title={editingDed?.id ? 'Edit deduction' : 'Add recurring deduction'}>
        {editingDed && (
          <div className="space-y-4">
            <Field label="Label">
              <Input placeholder="e.g. SSS salary loan" value={editingDed.label} onChange={(e) => setEditingDed({ ...editingDed, label: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kind">
                <Select value={editingDed.category} onChange={(e) => setEditingDed({ ...editingDed, category: e.target.value })}>
                  {Object.entries(DEDUCTION_CATEGORY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount per payroll (PHP)">
                <Input type="number" min={0} step="0.01" value={editingDed.amount} onChange={(e) => setEditingDed({ ...editingDed, amount: e.target.value })} />
              </Field>
            </div>
            <Field
              label={editingDed.id ? 'Remaining balance (PHP)' : 'Total to deduct (PHP)'}
              hint="Optional — blank = no limit. Each finalized payroll reduces it; at zero the deduction stops."
            >
              <Input type="number" min={0} step="0.01" value={editingDed.balance} onChange={(e) => setEditingDed({ ...editingDed, balance: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First payroll on or after (optional)">
                <Input type="date" value={editingDed.start} onChange={(e) => setEditingDed({ ...editingDed, start: e.target.value })} />
              </Field>
              <Field label="Last payroll on or before (optional)">
                <Input type="date" value={editingDed.end} onChange={(e) => setEditingDed({ ...editingDed, end: e.target.value })} />
              </Field>
            </div>
            {AUTHORIZED_DEDUCTIONS.includes(editingDed.category) && (
              <Field
                label="Employee's written authorization signed on"
                hint="Required: a deduction the law doesn't provide for (a company loan, HMO or insurance premium, anything else) needs the employee's written authorization (Labor Code Art. 113). Keep the signed copy on file."
              >
                <Input type="date" value={editingDed.authorized} onChange={(e) => setEditingDed({ ...editingDed, authorized: e.target.value })} />
              </Field>
            )}
            <Button className="w-full" disabled={listBusy} onClick={() => saveDeduction(editingDed)}>
              {listBusy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        )}
      </Modal>
      <PayRateModal open={changingRate} onClose={() => setChangingRate(false)} employee={employee} entity={entity} rates={rates} onSaved={onChanged} />
    </div>
  )
}

/** The pay-item type to store: only one that fits the classification. */
function itemTypeFor(category: string, t: PayItemType | ''): PayItemType | null {
  if (t === 'christmas_bonus' && category === 'other_benefits') return t
  if (t === 'liquidated_allowance' && LIQUIDATABLE_CATEGORIES.includes(category)) return t
  if ((SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(t) && category === 'other_taxable') return t as PayItemType
  return null
}

interface AllowanceForm {
  id?: string
  label: string
  amount: string
  category: AllowanceCategory
  basis: AllowanceBasis
  /** which de minimis benefit (category de_minimis) */
  dm: DeMinimisKind | ''
  /** not SSS compensation: the Christmas bonus, an allowance subject to liquidation */
  itemType: PayItemType | ''
}

interface DeductionForm {
  id?: string
  label: string
  category: string
  amount: string
  /** remaining balance (new: the total to deduct); '' = no limit */
  balance: string
  start: string
  end: string
  /** date the written authorization was signed ('' = none) */
  authorized: string
}


/** The pay-history reason a career event's new rate is recorded with. */
const RATE_REASON_FOR_EVENT: Record<string, PayRateReason> = {
  hired: 'hired',
  regularized: 'regularized',
  promoted: 'promotion',
  salary_adjustment: 'adjustment',
}

function CareerTab({
  employee,
  rates,
  events,
  onChanged,
}: {
  employee: Employee
  rates: EmployeePayRate[]
  events: CareerEvent[]
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const rateOfEvent = (eventId: string) => {
    const r = rates.find((x) => x.career_event_id === eventId)
    return r ? rateText(r) : null
  }
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    event_type: 'promoted',
    effective_date: todayManila(),
    position: employee.position,
    department: employee.department,
    pay_type: employee.pay_type,
    rate: '',
    details: '',
    separation_reason: 'resignation' as SeparationReason,
    apply: true,
  })

  async function save() {
    setBusy(true)
    try {
      const newRate = f.event_type !== 'separated' && Number(f.rate) > 0 ? Number(f.rate) : null
      if (newRate !== null && f.effective_date < employee.hire_date) {
        throw new Error(`A pay rate can't start before the hire date (${fmtDate(employee.hire_date)}).`)
      }
      // a new rate goes to the pay history (admins only), linked to the event
      const { data: ev, error } = await supabase
        .from('career_events')
        .insert({
          employee_id: employee.id,
          event_type: f.event_type,
          effective_date: f.effective_date,
          position: f.position || null,
          department: f.department || null,
          details:
            f.event_type === 'separated'
              ? [SEPARATION_REASON_LABELS[f.separation_reason], f.details].filter(Boolean).join(' — ')
              : f.details,
        })
        .select('id')
        .single()
      if (error) throw error
      if (newRate !== null) {
        const { error: rateErr } = await supabase.from('employee_pay_rates').insert({
          employee_id: employee.id,
          effective_from: f.effective_date,
          pay_type: f.pay_type,
          rate: newRate,
          reason: RATE_REASON_FOR_EVENT[f.event_type] ?? 'adjustment',
          note: f.details.slice(0, 500),
          career_event_id: ev.id,
        })
        if (rateErr) {
          throw new Error(
            /one_per_date/.test(errorMessage(rateErr, ''))
              ? 'Event recorded, but a pay rate from that date already exists: change it on the Pay History tab.'
              : `Event recorded, but the pay rate was not: ${errorMessage(rateErr, 'save failed')}`,
          )
        }
      }
      if (f.apply) {
        const upd: Record<string, unknown> = {}
        if (f.position) upd.position = f.position
        if (f.department) upd.department = f.department
        if (f.event_type === 'regularized') {
          upd.employment_status = 'regular'
          upd.regularization_date = f.effective_date
        }
        if (f.event_type === 'separated') {
          upd.separation_date = f.effective_date
          upd.separation_reason = f.separation_reason
          upd.separation_remarks = f.details || null
        }
        if (Object.keys(upd).length > 0) {
          const { error: updErr } = await supabase.from('employees').update(upd).eq('id', employee.id)
          if (updErr) throw updErr
        }
      }
      toast('success', 'Career event recorded.')
      setAdding(false)
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Career history with the company"
      icon={<History />}
      actions={
        <Button variant="secondary" onClick={() => setAdding(true)}>
          <Plus className="size-4" /> Record event
        </Button>
      }
    >
      {events.length === 0 ? (
        <p className="text-sm text-slate-400">No events recorded.</p>
      ) : (
        <ol className="relative ml-2 space-y-5 border-l-2 border-brand-100 pl-5">
          {events.map((ev) => (
            <li key={ev.id} className="relative">
              <span className="absolute -left-[27px] top-1 size-3 rounded-full border-2 border-white bg-accent-500" />
              <p className="text-xs font-semibold text-slate-400">{fmtDate(ev.effective_date)}</p>
              <p className="text-sm font-bold text-slate-800">
                {eventLabels[ev.event_type] ?? ev.event_type}
                {ev.position ? ` — ${ev.position}` : ''}
              </p>
              <p className="text-xs text-slate-500">
                {[ev.department, rateOfEvent(ev.id)].filter(Boolean).join(' · ')}
              </p>
              {ev.details && <p className="mt-0.5 text-xs text-slate-500">{ev.details}</p>}
            </li>
          ))}
        </ol>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Record career event">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Event type">
              <Select value={f.event_type} onChange={(e) => setF({ ...f, event_type: e.target.value })}>
                {Object.entries(eventLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </Select>
            </Field>
            <Field label={f.event_type === 'separated' ? 'Last day of employment' : 'Effective date'}>
              <Input type="date" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} />
            </Field>
            {f.event_type === 'separated' ? (
              <Field label="Reason" className="sm:col-span-2">
                <Select value={f.separation_reason} onChange={(e) => setF({ ...f, separation_reason: e.target.value as SeparationReason })}>
                  {Object.entries(SEPARATION_REASON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            ) : (
              <>
                <Field label="Position"><Input value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} /></Field>
                <Field label="Department"><Input value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
                <Field label="New rate basis">
                  <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value as 'monthly' | 'daily' })}>
                    <option value="monthly">Monthly-rated</option>
                    <option value="daily">Daily-rated</option>
                  </Select>
                </Field>
                <Field label={`New ${f.pay_type === 'monthly' ? 'monthly' : 'daily'} rate (optional)`} hint="Recorded in the pay history from the effective date">
                  <Input type="number" min={0} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
                </Field>
              </>
            )}
          </div>
          <Field label="Details"><Textarea rows={2} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
          <Toggle checked={f.apply} onChange={(v) => setF({ ...f, apply: v })} label="Also update the employee's current record" />
          <Button className="w-full" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Record event'}
          </Button>
        </div>
      </Modal>
    </Card>
  )
}

function LoginTab({
  employee,
  entity,
  account,
  onChanged,
}: {
  employee: Employee
  entity: Entity
  account: Profile | null
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [part, setPart] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function setCode() {
    const weak = weakCodeReason(part, employee.employee_no, [employee.first_name, employee.last_name])
    if (weak) {
      toast('error', weak)
      return
    }
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'set_employee_code', employee_id: employee.id, code_part: part })
      if (res.error) throw new Error(res.error)
      setIssued(res.code ?? null)
      setPart('')
      toast('success', account ? 'New code set — the old code no longer works.' : 'Login code issued.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  async function setActive(active: boolean) {
    setBusy(true)
    try {
      const res = await callAdminUsers({ action: 'set_employee_login_active', employee_id: employee.id, active })
      if (res.error) throw new Error(res.error)
      toast('success', active ? 'Login reactivated.' : 'Login deactivated.')
      await onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  function printSlip(code: string) {
    const w = window.open('', '_blank', 'width=420,height=320')
    if (!w) return
    // Names are admin-entered text: escape them, the popup shares our origin.
    const esc = (v: string) =>
      v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    w.document.write(
      `<html><head><title>Login code</title></head><body style="font-family:sans-serif;padding:24px">
       <p style="margin:0;color:#475569;font-size:12px">${esc(entity.name)}</p>
       <h2 style="margin:4px 0 12px">${esc(fullName(employee))}</h2>
       <p style="margin:0;font-size:12px;color:#475569">Your Payslip HR login code</p>
       <p style="font-family:monospace;font-size:26px;font-weight:bold;letter-spacing:2px;margin:6px 0 16px">${esc(code)}</p>
       <p style="font-size:11px;color:#64748b">Sign in at ${esc(window.location.origin + import.meta.env.BASE_URL)} — choose "Employee". Keep this code private.</p>
       </body></html>`,
    )
    w.document.close()
    w.print()
  }

  return (
    <Card title="Employee login code" icon={<KeyRound />}>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          {account ? (
            <>
              <UserCheck className="size-5 text-emerald-500" />
              <div>
                <p className="text-sm font-semibold text-slate-700">
                  Code <span className="font-mono">{entity.code}-••••{employee.login_code_hint ?? ''}</span>
                </p>
                <p className="text-xs text-slate-400">
                  Set {fmtDateTime(employee.login_code_set_at)} · the code itself is never stored, only its last characters
                </p>
              </div>
              <Badge tone={account.is_active ? 'green' : 'red'}>{account.is_active ? 'Active' : 'Deactivated'}</Badge>
            </>
          ) : (
            <p className="text-sm text-slate-600">
              No login yet. Issue a code so this employee can see payslips, attendance, leaves and announcements.
            </p>
          )}
        </div>

        {issued && (
          <div className="rounded-xl border-2 border-dashed border-accent-300 bg-accent-50 p-4">
            <p className="text-xs font-semibold text-accent-800">Give this code to the employee — it is shown only now:</p>
            <p className="my-1 font-mono text-2xl font-extrabold tracking-wider text-ink-900">{issued}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(issued)}>
                <Copy className="size-4" /> Copy
              </Button>
              <Button variant="secondary" onClick={() => printSlip(issued)}>
                <Printer className="size-4" /> Print slip
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field label={account ? 'New code' : 'Code'} hint="8–24 characters mixing letters and digits, not the employee's name or number — or Generate one">
            <div className="flex items-center gap-1">
              <span className="rounded-lg bg-slate-100 px-2.5 py-2 font-mono text-sm font-bold text-slate-600">{entity.code}-</span>
              <Input
                value={part}
                maxLength={24}
                onChange={(e) => setPart(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                className="w-48 font-mono uppercase"
              />
            </div>
          </Field>
          <Button
            variant="secondary"
            onClick={() => {
              // never hand out a code that the save would refuse (e.g. one spelling the employee's name)
              let p = generateCodePart()
              while (weakCodeReason(p, employee.employee_no, [employee.first_name, employee.last_name])) p = generateCodePart()
              setPart(p)
            }}
          >
            <RefreshCw className="size-4" /> Generate
          </Button>
          <Button disabled={busy || part.length < 8} onClick={setCode}>
            <KeyRound className="size-4" /> {account ? 'Replace code' : 'Issue code'}
          </Button>
          {account && (
            <Button variant={account.is_active ? 'danger' : 'primary'} disabled={busy} onClick={() => setActive(!account.is_active)}>
              <UserX className="size-4" /> {account.is_active ? 'Deactivate login' : 'Reactivate login'}
            </Button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Employees sign in with the full code ({entity.code}-…). Replacing a code signs the employee out of every
          device. Employees can only view their own records — they cannot change attendance or pay.
        </p>
      </div>
    </Card>
  )
}

const TAX_FIELDS: { key: keyof EmployeeTaxYear; label: string }[] = [
  { key: 'prev_mwe_exempt', label: 'MWE exempt pay (SMW, holiday, OT, ND, hazard)' },
  { key: 'prev_13th_other_benefits_exempt', label: '13th month & other benefits (exempt)' },
  { key: 'prev_de_minimis', label: 'De minimis benefits' },
  { key: 'prev_contributions', label: 'SSS/PhilHealth/Pag-IBIG & union dues (EE)' },
  { key: 'prev_other_non_taxable', label: 'Other non-taxable compensation' },
  { key: 'prev_taxable_basic', label: 'Taxable basic salary' },
  { key: 'prev_taxable_13th_other_benefits', label: 'Taxable 13th month & other benefits' },
  { key: 'prev_taxable_other', label: 'Other taxable compensation' },
  { key: 'prev_tax_withheld', label: 'Tax withheld by previous employer' },
]

function BirTab({ employee }: { employee: Employee }) {
  const toast = useToast()
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)))
  // the year a row was loaded for travels with it: saving never writes one
  // year's figures under another
  const [row, setRow] = useState<(Partial<EmployeeTaxYear> & { loadedFor: number }) | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRow(null)
    setLoadError('')
    supabase
      .from('employee_tax_years')
      .select('*')
      .eq('employee_id', employee.id)
      .eq('year', year)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        // a failed read is not "no data yet": saving blanks would wipe the stored figures
        if (error) setLoadError(errorMessage(error, 'Failed to load'))
        else
          setRow({
            ...((data as EmployeeTaxYear | null) ?? { has_previous_employer: false, substituted_filing: 'auto', pera_tax_credit: 0 }),
            loadedFor: year,
          })
      })
    return () => {
      cancelled = true
    }
  }, [employee.id, year, reload])

  if (loadError) {
    return (
      <Card>
        <p className="text-sm text-rose-600">
          Couldn't load the BIR data: {loadError}{' '}
          <button type="button" onClick={() => setReload((n) => n + 1)} className="font-semibold underline">
            Try again
          </button>
        </p>
      </Card>
    )
  }
  if (!row || row.loadedFor !== year) return <Spinner />
  const set = (k: keyof EmployeeTaxYear, v: unknown) => setRow({ ...row, [k]: v })

  async function save() {
    if (!row || row.loadedFor !== year) return
    setBusy(true)
    try {
      const payload: Record<string, unknown> = {
        employee_id: employee.id,
        year: row.loadedFor,
        has_previous_employer: !!row.has_previous_employer,
        prev_employer_tin: row.prev_employer_tin ?? '',
        prev_employer_name: row.prev_employer_name ?? '',
        prev_employer_address: row.prev_employer_address ?? '',
        prev_employer_zip: row.prev_employer_zip ?? '',
        prev_employment_from: row.prev_employment_from || null,
        prev_employment_to: row.prev_employment_to || null,
        prev_employment_status: row.prev_employment_status || null,
        prev_separation_reason: row.prev_separation_reason || null,
        pera_tax_credit: Number(row.pera_tax_credit ?? 0),
        substituted_filing: row.substituted_filing ?? 'auto',
        notes: row.notes ?? '',
      }
      for (const f of TAX_FIELDS) payload[f.key] = Number(row[f.key] ?? 0)
      const { error } = await supabase.from('employee_tax_years').upsert(payload, { onConflict: 'employee_id,year' })
      if (error) throw error
      toast('success', `BIR data for ${year} saved.`)
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="Previous employer this year (from their BIR Form 2316)"
        icon={<Building2 />}
        actions={
          <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </Select>
        }
      >
        <Toggle
          checked={!!row.has_previous_employer}
          onChange={(v) => set('has_previous_employer', v)}
          label={`Had another employer earlier in ${year}`}
        />
        {row.has_previous_employer && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Previous employer TIN"><Input value={row.prev_employer_tin ?? ''} onChange={(e) => set('prev_employer_tin', e.target.value)} /></Field>
              <Field label="Name"><Input value={row.prev_employer_name ?? ''} onChange={(e) => set('prev_employer_name', e.target.value)} /></Field>
              <Field label="Address" className="sm:col-span-2"><Input value={row.prev_employer_address ?? ''} onChange={(e) => set('prev_employer_address', e.target.value)} /></Field>
              <Field label="ZIP"><Input value={row.prev_employer_zip ?? ''} onChange={(e) => set('prev_employer_zip', e.target.value)} /></Field>
              <div className="hidden sm:block" />
              <Field label="Employed from"><Input type="date" value={row.prev_employment_from ?? ''} onChange={(e) => set('prev_employment_from', e.target.value)} /></Field>
              <Field label="Employed to"><Input type="date" value={row.prev_employment_to ?? ''} onChange={(e) => set('prev_employment_to', e.target.value)} /></Field>
              <Field label="Employment status there">
                <Select value={row.prev_employment_status ?? ''} onChange={(e) => set('prev_employment_status', e.target.value || null)}>
                  <option value="">—</option>
                  {Object.entries(EMPLOYMENT_STATUS_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Reason of separation there">
                <Select value={row.prev_separation_reason ?? ''} onChange={(e) => set('prev_separation_reason', e.target.value || null)}>
                  <option value="">—</option>
                  {Object.entries(SEPARATION_REASON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {TAX_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <Input type="number" step="0.01" value={String(row[f.key] ?? 0)} onChange={(e) => set(f.key, e.target.value)} />
                </Field>
              ))}
            </div>
          </div>
        )}
      </Card>
      <Card title={`Year-end details for ${year}`} icon={<Landmark />}>
        <div className="space-y-3">
          <Field label="Substituted filing" hint="Auto = qualifies when the employee had only this employer all year and taxes withheld equal tax due">
            <Select value={row.substituted_filing ?? 'auto'} onChange={(e) => set('substituted_filing', e.target.value)}>
              <option value="auto">Automatic</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="PERA 5% tax credit (RA 9505)">
            <Input type="number" step="0.01" value={String(row.pera_tax_credit ?? 0)} onChange={(e) => set('pera_tax_credit', e.target.value)} />
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={row.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save BIR data'}</Button>
          <p className="text-xs text-slate-400">
            Used by year-end annualization and the 1604-C alphalist (BIR &amp; Reports).
          </p>
        </div>
      </Card>
    </div>
  )
}
