import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  CalendarClock,
  ClipboardCheck,
  Clock,
  FileWarning,
  HandCoins,
  KeyRound,
  Landmark,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge, Card, LoadFailed, NoClient, PageHeader, Spinner, StatCard, StatGroup } from '../../components/ui'
import { getEmployees, getHolidaysBetween, getMinimumWages, isActiveOn } from '../../lib/api'
import { fetchAll } from '../../lib/fetchAll'
import { useAuth } from '../../lib/auth'
import type { Employee, Entity, Holiday, PayrollRun, Payslip, TimeEntry } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, money, moneyWhole, plural } from '../../lib/format'
import { FREQUENCY_LABELS } from '../../lib/labels'
import { addDays, eachDate, todayManila } from '../../lib/manila'
import { probationEnds } from '../../lib/insights'
import { minimumWageFor, mweToday } from '../../lib/useMinimumWages'
import { fetchScheduleRows, resolversFor } from '../../lib/schedules'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { dueCalendar, type DueDateOverride, type DueItem, type ObligationKey } from '../../payroll/dueDates'
import type { MinimumWageRow } from '../../payroll/minimumWage'
import type { ScheduleResolver } from '../../payroll/types'

// Categorical palette — validated (dataviz six checks, light surface):
// green → blue → orange, fixed assignment order.
const C = { net: '#3a8a5c', ee: '#1d6fb1', er: '#d9661a' }

export default function Dashboard() {
  const { entity, entities, setEntityId } = useEntity()
  const { isCompanyAdmin } = useAuth()
  return (
    <div>
      {isCompanyAdmin && entities.length > 0 && <ClientsOverview onPick={setEntityId} currentId={entity?.id ?? null} />}
      {entity ? <ClientDashboard key={entity.id} entity={entity} /> : <NoClient companyAdmin={isCompanyAdmin} />}
    </div>
  )
}

function ClientsOverview({ onPick, currentId }: { onPick: (id: string) => void; currentId: string | null }) {
  const { entities } = useEntity()
  const [stats, setStats] = useState<Record<string, { headcount: number; lastPay: string | null; drafts: number }> | null>({})

  useEffect(() => {
    const today = todayManila()
    Promise.all([
      fetchAll<{ entity_id: string; separation_date: string | null }>((from, to) =>
        supabase.from('employees').select('entity_id, separation_date').order('id').range(from, to),
      ),
      fetchAll<{ entity_id: string; status: string; pay_date: string }>((from, to) =>
        supabase.from('payroll_runs').select('entity_id, status, pay_date').order('pay_date', { ascending: false }).order('id').range(from, to),
      ),
    ]).then(([emps, runs]) => {
      const s: Record<string, { headcount: number; lastPay: string | null; drafts: number }> = {}
      const get = (id: string) => (s[id] ??= { headcount: 0, lastPay: null, drafts: 0 })
      for (const e of emps ?? []) if (!e.separation_date || e.separation_date >= today) get(e.entity_id as string).headcount++
      for (const r of runs ?? []) {
        const x = get(r.entity_id as string)
        if (r.status === 'draft') x.drafts++
        else if (!x.lastPay) x.lastPay = r.pay_date as string
      }
      setStats(s)
    }).catch(() => setStats(null))
  }, [])

  const active = entities.filter((e) => e.is_active)
  return (
    <Card title={`Clients (${active.length})`} className="mb-6" actions={<Link to="/admin/clients" className="text-xs font-semibold text-brand-600">Manage clients</Link>}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {active.map((e) => {
          const st = stats?.[e.id]
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onPick(e.id)}
              className={`min-w-0 rounded-xl border p-3 text-left transition-colors ${
                e.id === currentId ? 'border-accent-400 bg-accent-50/50' : 'border-slate-100 hover:border-brand-200 hover:bg-brand-50/40'
              }`}
            >
              <p className="truncate text-sm font-bold text-slate-800">{e.name}</p>
              <p className="text-xs text-slate-500">
                <span className="font-mono">{e.code}</span>
                {stats ? ` · ${plural(st?.headcount ?? 0, 'employee')}` : ''}
              </p>
              <p className="mt-1 text-[11px] text-slate-400">
                {!stats ? 'Figures unavailable' : st?.lastPay ? `Last payroll ${fmtDate(st.lastPay)}` : 'No finalized payroll yet'}
                {st?.drafts ? ` · ${plural(st.drafts, 'draft run')}` : ''}
              </p>
            </button>
          )
        })}
      </div>
    </Card>
  )
}

type DashSlip = Pick<
  Payslip,
  | 'period_month'
  | 'pay_date'
  | 'net_pay'
  | 'sss_ee'
  | 'sss_mpf_ee'
  | 'sss_er'
  | 'sss_mpf_er'
  | 'sss_ec_er'
  | 'philhealth_ee'
  | 'philhealth_er'
  | 'pagibig_ee'
  | 'pagibig_er'
  | 'withholding_tax'
  | 'other_deductions_total'
>

interface DashData {
  employees: Employee[]
  recentEntries: Pick<TimeEntry, 'employee_id' | 'work_date'>[]
  runs: PayrollRun[]
  slips: DashSlip[]
  /** from two weeks back (attendance) to 45 days ahead (upcoming list) */
  holidays: Holiday[]
  recentLeaves: { employee_id: string; start_date: string; end_date: string }[]
  /** who is scheduled on the recent days (patterns, roster changes) */
  schedules: Map<string, ScheduleResolver>
  pendingCorrections: number
  pendingLeaves: number
  pendingAdvances: number
  /** company admins: the oldest verification date among the statutory tables in force (undefined = not loaded) */
  statutoryVerified?: string | null
  /** due dates the user set in place of the computed ones (spec T9) */
  dueOverrides: DueDateOverride[]
  /** the client's region's minimum wages (spec T12) */
  minimumWages: MinimumWageRow[]
}

function ClientDashboard({ entity }: { entity: Entity }) {
  const { isCompanyAdmin } = useAuth()
  const [data, setData] = useState<DashData | null>(null)
  const [loadError, setLoadError] = useState('')
  const today = todayManila()

  const load = useCallback(async () => {
    setLoadError('')
    try {
      const twoWeeksAgo = addDays(today, -13)
      // six payroll months for the cost chart, plus the current one
      const sinceMonth = `${addMonths(today.slice(0, 7), -6)}-01`
      const [emps, recentEnt, runsRes, slips, hols, recentLeaves, corr, leaves, advances, scheduleRows, statutory, overrides, wages] = await Promise.all([
        getEmployees(entity.id),
        fetchAll<TimeEntry>((from, to) =>
          supabase
            .from('time_entries')
            .select('employee_id, work_date')
            .eq('entity_id', entity.id)
            .gte('work_date', twoWeeksAgo)
            .order('id')
            .range(from, to),
        ),
        supabase.from('payroll_runs').select('*').eq('entity_id', entity.id).order('period_end', { ascending: false }).limit(60),
        fetchAll<DashSlip>((from, to) =>
          supabase
            .from('payslips')
            .select(
              'period_month, pay_date, net_pay, sss_ee, sss_mpf_ee, sss_er, sss_mpf_er, sss_ec_er, philhealth_ee, philhealth_er, pagibig_ee, pagibig_er, withholding_tax, other_deductions_total, payroll_runs!inner(status)',
            )
            .eq('entity_id', entity.id)
            .in('payroll_runs.status', ['finalized', 'paid'])
            .gte('period_month', sinceMonth)
            .order('id')
            .range(from, to),
        ),
        getHolidaysBetween(entity.id, twoWeeksAgo, addDays(today, 45)),
        fetchAll<{ employee_id: string; start_date: string; end_date: string }>((from, to) =>
          supabase
            .from('leave_requests')
            .select('employee_id, start_date, end_date')
            .eq('entity_id', entity.id)
            .eq('status', 'approved')
            .lte('start_date', today)
            .gte('end_date', twoWeeksAgo)
            .order('id')
            .range(from, to),
        ),
        supabase.from('time_correction_requests').select('id', { count: 'exact', head: true }).eq('entity_id', entity.id).eq('status', 'pending'),
        supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('entity_id', entity.id).eq('status', 'pending'),
        supabase.from('advance_requests').select('id', { count: 'exact', head: true }).eq('entity_id', entity.id).eq('status', 'pending'),
        fetchScheduleRows({ entityId: entity.id }, twoWeeksAgo, today),
        isCompanyAdmin
          ? supabase.from('statutory_versions').select('kind, verified_on').lte('effective_from', today).order('effective_from', { ascending: false })
          : Promise.resolve(null),
        supabase.from('due_date_overrides').select('obligation, period, due_date, note').eq('entity_id', entity.id).gte('period', sinceMonth),
        getMinimumWages(entity.minimum_wage_region),
      ])
      const failed = runsRes.error ?? corr.error ?? leaves.error ?? advances.error ?? statutory?.error ?? overrides.error
      if (failed) throw failed
      setData({
        employees: emps,
        recentEntries: recentEnt,
        runs: (runsRes.data ?? []) as PayrollRun[],
        slips,
        holidays: hols,
        recentLeaves,
        schedules: resolversFor(emps, scheduleRows),
        pendingCorrections: corr.count ?? 0,
        pendingLeaves: leaves.count ?? 0,
        pendingAdvances: advances.count ?? 0,
        statutoryVerified: statutory ? oldestCheck((statutory.data ?? []) as { kind: string; verified_on: string | null }[]) : undefined,
        dueOverrides: (overrides.data ?? []) as DueDateOverride[],
        minimumWages: wages,
      })
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load the dashboard'))
    }
  }, [entity.id, entity.minimum_wage_region, today, isCompanyAdmin])

  useEffect(() => {
    load()
  }, [load])

  const derived = useMemo(() => (data ? derive(data, entity, today) : null), [data, entity, today])
  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!data || !derived) return <Spinner />

  return (
    <div>
      <PageHeader title={entity.name} subtitle={`Workforce and payroll · ${fmtDate(today)}`} />

      <StatGroup className="mb-6">
        <StatCard
          label="Active headcount"
          value={derived.active.length}
          sub={derived.byFrequency || 'no employees yet'}
          icon={<Users className="size-5" />}
        />
        <StatCard
          label="Time entered — last workday"
          value={`${derived.lastWorkday.entered} / ${derived.lastWorkday.scheduled}`}
          sub={derived.lastWorkday.date ? fmtDate(derived.lastWorkday.date) : '—'}
          icon={<Clock className="size-5" />}
          tone={derived.lastWorkday.entered < derived.lastWorkday.scheduled ? 'warn' : 'good'}
        />
        <StatCard
          label="Last payroll — employer cost"
          value={derived.lastRun ? moneyWhole(derived.lastRun.totals?.employer_cost ?? 0) : '—'}
          sub={derived.lastRun ? `net payout ${moneyWhole(derived.lastRun.totals?.net ?? 0)}` : 'no finalized runs yet'}
          icon={<Wallet className="size-5" />}
        />
        <StatCard
          label="Needs your action"
          value={derived.actions.length}
          sub="approvals, data gaps, alerts"
          icon={<ClipboardCheck className="size-5" />}
          tone={derived.actions.length > 0 ? 'warn' : 'good'}
        />
      </StatGroup>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Action center" icon={<ClipboardCheck />} className="lg:col-span-1">
          {derived.actions.length === 0 ? (
            <p className="text-sm text-slate-400">All clear — nothing needs your attention.</p>
          ) : (
            <div className="space-y-2.5">
              {derived.actions.map((a, i) => (
                <Link
                  key={i}
                  to={a.to}
                  className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-0.5 ${a.tone === 'warn' ? 'text-amber-500' : 'text-brand-400'}`}>{a.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-700">{a.title}</p>
                      <p className="text-xs text-slate-500">{a.sub}</p>
                    </div>
                  </div>
                  <ArrowRight className="mt-1 size-4 shrink-0 text-slate-300" />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card title="Payroll cost by month" icon={<TrendingUp />} className="lg:col-span-2" actions={<span className="text-xs text-slate-400">finalized runs · PHP</span>}>
          {derived.costByMonth.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">Finalize a payroll run to see cost trends.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={derived.costByMonth} barCategoryGap="28%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e6e6ed" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#767888' }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#767888' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                />
                <Tooltip
                  formatter={(v, name) => [money(Number(v ?? 0)), String(name)]}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e6e6ed', fontSize: 12 }}
                />
                <Legend itemSorter={null} wrapperStyle={{ fontSize: 12 }} formatter={(value) => <span style={{ color: '#41434f' }}>{value}</span>} />
                <Bar dataKey="Net pay" stackId="a" fill={C.net} stroke="#ffffff" strokeWidth={2} maxBarSize={64} />
                <Bar dataKey="Employee deductions" stackId="a" fill={C.ee} stroke="#ffffff" strokeWidth={2} maxBarSize={64} />
                <Bar dataKey="Employer contributions" stackId="a" fill={C.er} stroke="#ffffff" strokeWidth={2} radius={[4, 4, 0, 0]} maxBarSize={64} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Attendance — last 10 workdays" icon={<Clock />} className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={derived.attendanceTrend} barCategoryGap="35%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e6e6ed" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#767888' }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#767888' }} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip formatter={(v) => [`${Number(v ?? 0)}%`, 'With time entries']} contentStyle={{ borderRadius: 12, border: '1px solid #e6e6ed', fontSize: 12 }} />
              <Bar dataKey="rate" name="With time entries" fill={C.net} radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-slate-400">Share of scheduled employees with time in/out entered for the day.</p>
        </Card>

        <Card title="Upcoming holidays" icon={<CalendarClock />}>
          {data.holidays.filter((h) => h.holiday_date >= today).length === 0 ? (
            <p className="text-sm text-slate-400">None in the next 45 days.</p>
          ) : (
            <div className="space-y-2.5">
              {data.holidays.filter((h) => h.holiday_date >= today).slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{h.name}</p>
                    <p className="text-xs text-slate-400">{fmtDate(h.holiday_date)}{h.entity_id ? ' · local' : ''}</p>
                  </div>
                  <Badge tone={h.kind === 'regular' ? 'red' : h.kind === 'special_non_working' ? 'amber' : 'slate'}>
                    {h.kind === 'regular' ? 'regular' : h.kind === 'special_non_working' ? 'special' : 'working'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card title={`Statutory obligations${derived.lastMonthLabel ? ` — ${derived.lastMonthLabel} payroll` : ''}`} icon={<Landmark />}>
        {derived.lastMonthLabel ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ObligationTile
              label={`BIR withholding tax — paid in ${derived.lastPayMonthLabel ?? '—'}`}
              amount={derived.monthObligations.tax}
              due={dueLine(derived.due.tax, '1601-C', '1601-C next month — choose the client\'s BIR filing in Client Settings to see its due date')}
            />
            <ObligationTile label="SSS (EE + ER + EC)" amount={derived.monthObligations.sss} due={dueLine(derived.due.sss, 'Remit', 'Remit next month — check the SSS schedule for your due date')} />
            <ObligationTile label="PhilHealth" amount={derived.monthObligations.philhealth} due={dueLine(derived.due.philhealth, 'Remit', 'Remit next month — PhilHealth\'s schedule depends on your employer number')} />
            <ObligationTile label="Pag-IBIG" amount={derived.monthObligations.pagibig} due={dueLine(derived.due.pagibig, 'Remit', 'Remit next month — Pag-IBIG\'s window depends on your employer name')} />
          </div>
        ) : (
          <p className="text-sm text-slate-400">Totals appear after the first finalized run.</p>
        )}
        <p className="mt-3 text-[11px] text-slate-400">
          {derived.lastMonthLabel ? `From finalized payslips for ${derived.lastMonthLabel}, all pay frequencies — ` : ''}
          confirm deadlines on each agency's schedule. Full monthly figures are under BIR &amp; Reports.
        </p>
      </Card>
    </div>
  )
}

/** A tile's due line: the date in force (spec T9), else the general hint. */
function dueLine(item: DueItem | null, verb: string, fallback: string): string {
  if (!item?.date) return fallback
  return `${verb} by ${fmtDate(item.date)}${item.overridden ? ` (${item.note})` : item.weekend ? ' (a weekend: not moved)' : ''}`
}

function ObligationTile({ label, amount, due }: { label: string; amount: number; due: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-ink-900">{money(amount)}</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{due}</p>
    </div>
  )
}

interface ActionItem {
  title: string
  sub: string
  to: string
  tone: 'warn' | 'info'
  icon: React.ReactNode
}

/** The oldest verification among the versions in force (the first row of each kind, newest first). */
function oldestCheck(rows: { kind: string; verified_on: string | null }[]): string | null {
  const seen = new Set<string>()
  let oldest: string | null = null
  for (const r of rows) {
    if (seen.has(r.kind)) continue
    seen.add(r.kind)
    if (!r.verified_on) return null
    if (!oldest || r.verified_on < oldest) oldest = r.verified_on
  }
  return oldest
}

/** YYYY-MM shifted by n months. */
function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

function derive(data: DashData, entity: Entity, today: string) {
  const active = data.employees.filter((e) => e.hire_date <= today && isActiveOn(e, today))
  const freqCounts = (['weekly', 'semi_monthly', 'monthly'] as const)
    .map((f) => [f, active.filter((e) => e.pay_frequency === f).length] as const)
    .filter(([, n]) => n > 0)
  const byFrequency = freqCounts.map(([f, n]) => `${n} ${FREQUENCY_LABELS[f].toLowerCase()}`).join(' · ')

  const entered = (date: string) =>
    new Set(data.recentEntries.filter((t) => t.work_date === date).map((t) => t.employee_id))
  // who was expected at work on a date: scheduled that weekday, employed,
  // not on approved leave — and nobody on a non-working holiday
  const expected = (date: string) => {
    const h = data.holidays.find((x) => x.holiday_date === date)
    if (h && h.kind !== 'special_working') return []
    return active.filter(
      (e) =>
        (data.schedules.get(e.id)?.(date).shift ?? null) !== null &&
        e.hire_date <= date &&
        !data.recentLeaves.some((l) => l.employee_id === e.id && l.start_date <= date && l.end_date >= date),
    )
  }

  // most recent workday before today
  let lastWorkday = { date: '', scheduled: 0, entered: 0 }
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i)
    const scheduled = expected(d)
    if (scheduled.length > 0) {
      const set = entered(d)
      lastWorkday = { date: d, scheduled: scheduled.length, entered: scheduled.filter((e) => set.has(e.id)).length }
      break
    }
  }

  const actions: ActionItem[] = []
  if (lastWorkday.scheduled > lastWorkday.entered)
    actions.push({
      title: `${plural(lastWorkday.scheduled - lastWorkday.entered, 'scheduled employee')} without time in/out`,
      sub: `${fmtDate(lastWorkday.date)} — enter their times or leave blank for absences`,
      to: '/admin/timesheets',
      tone: 'info',
      icon: <Clock className="size-4" />,
    })
  if (data.pendingCorrections > 0)
    actions.push({
      title: `${plural(data.pendingCorrections, 'time correction')} pending`,
      sub: 'Employee-filed corrections to review',
      to: '/admin/timesheets?tab=corrections',
      tone: 'warn',
      icon: <Clock className="size-4" />,
    })
  if (data.pendingLeaves > 0)
    actions.push({
      title: `${plural(data.pendingLeaves, 'leave request')} pending`,
      sub: 'Approvals affect payroll for the period',
      to: '/admin/leaves',
      tone: 'warn',
      icon: <CalendarClock className="size-4" />,
    })
  if (data.pendingAdvances > 0)
    actions.push({
      title: `${plural(data.pendingAdvances, 'cash advance request')} pending`,
      sub: 'Approve with a signed authorization, or reject with a note',
      to: '/admin/advances?tab=requests',
      tone: 'warn',
      icon: <HandCoins className="size-4" />,
    })
  // statutory tables ship with the software; rates usually change on January 1
  if (data.statutoryVerified !== undefined && (!data.statutoryVerified || data.statutoryVerified < `${today.slice(0, 4)}-01-01`))
    actions.push({
      title: 'Statutory tables: this year’s check is due',
      sub: data.statutoryVerified
        ? `Last verified ${fmtDate(data.statutoryVerified)} — confirm the BIR, SSS, PhilHealth and Pag-IBIG tables with the system maintainer`
        : 'A table in force has no verification date — confirm it with the system maintainer',
      to: '/admin/statutory',
      tone: 'warn',
      icon: <Landmark className="size-4" />,
    })
  const drafts = data.runs.filter((r) => r.status === 'draft')
  if (drafts.length > 0)
    actions.push({
      title: `${plural(drafts.length, 'draft payroll run')}`,
      sub: 'Compute, review and finalize so employees see their payslips',
      to: '/admin/payroll',
      tone: 'info',
      icon: <Wallet className="size-4" />,
    })

  const probationEnding = active.filter((e) => {
    if (e.employment_status !== 'probationary') return false
    const end = probationEnds(e.hire_date) // six months = 180 days (Art. 296)
    return end >= today && end <= addDays(today, 30)
  })
  if (probationEnding.length > 0)
    actions.push({
      title: `${probationEnding.length} probation/s ending within 30 days`,
      sub: `${probationEnding.map((e) => e.first_name + ' ' + e.last_name).join(', ')} — decide on regularization (Labor Code Art. 296)`,
      to: '/admin/employees',
      tone: 'info',
      icon: <Users className="size-4" />,
    })

  // the minimum wage in force today: the table kept by company admins, else the client's own setting (spec T12)
  const minWage = minimumWageFor(entity, today, data.minimumWages)
  const belowMin = active.filter((e) => {
    const s = mweToday(e, entity, data.minimumWages, { date: today })
    return s.daily > 0 && s.below
  })
  if (belowMin.length > 0)
    actions.push({
      title: `${plural(belowMin.length, 'employee')} paid below minimum wage`,
      sub: `The minimum wage is ${money(minWage.daily ?? 0)}/day (${minWage.source})`,
      to: '/admin/employees',
      tone: 'warn',
      icon: <Landmark className="size-4" />,
    })

  const missingIds = active.filter((e) => !e.tin || !e.sss_no || !e.philhealth_no || !e.pagibig_no)
  if (missingIds.length > 0)
    actions.push({
      title: `${plural(missingIds.length, 'employee')} missing TIN / SSS / PhilHealth / Pag-IBIG numbers`,
      sub: 'Needed for remittances and the BIR alphalist',
      to: '/admin/employees',
      tone: 'warn',
      icon: <FileWarning className="size-4" />,
    })

  const noCode = active.filter((e) => !e.login_code_hint)
  if (noCode.length > 0)
    actions.push({
      title: `${plural(noCode.length, 'employee')} without a login code`,
      sub: 'Issue codes so they can see payslips and announcements',
      to: '/admin/employees',
      tone: 'info',
      icon: <KeyRound className="size-4" />,
    })

  if (!entity.tin || !entity.rdo_code)
    actions.push({
      title: 'Client TIN / RDO not set',
      sub: 'Required on payslips and every BIR report',
      to: '/admin/settings',
      tone: 'warn',
      icon: <FileWarning className="size-4" />,
    })

  const year = today.slice(0, 4)
  const has13th = data.runs.some((r) => r.run_type === 'thirteenth_month' && r.period_end.slice(0, 4) === year && r.status !== 'draft')
  if (!has13th && Number(today.slice(5, 7)) >= 11)
    actions.push({
      title: '13th month pay not yet finalized',
      sub: 'Due not later than December 24 (PD 851)',
      to: '/admin/payroll',
      tone: 'warn',
      icon: <Wallet className="size-4" />,
    })

  const zeroRate = active.filter((e) => Number(e.monthly_rate) === 0 && Number(e.daily_rate) === 0)
  if (zeroRate.length > 0)
    actions.push({
      title: `${plural(zeroRate.length, 'employee')} with no pay rate set`,
      sub: 'They will compute ₱0 on the next payroll run',
      to: '/admin/employees',
      tone: 'warn',
      icon: <TrendingUp className="size-4" />,
    })

  // ---- payroll cost by payroll month (finalized) ----
  const byMonth = new Map<string, { net: number; ee: number; er: number }>()
  for (const s of data.slips) {
    const key = (s.period_month ?? '').slice(0, 7)
    const cur = byMonth.get(key) ?? { net: 0, ee: 0, er: 0 }
    cur.net += Number(s.net_pay)
    cur.ee +=
      Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee) +
      Number(s.withholding_tax) + Number(s.other_deductions_total)
    cur.er += Number(s.sss_er) + Number(s.sss_mpf_er) + Number(s.sss_ec_er) + Number(s.philhealth_er) + Number(s.pagibig_er)
    byMonth.set(key, cur)
  }
  const costByMonth = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([k, v]) => ({
      month: new Date(`${k}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric' }),
      'Net pay': Math.round(v.net),
      'Employee deductions': Math.round(v.ee),
      'Employer contributions': Math.round(v.er),
    }))

  // ---- attendance trend ----
  const attendanceTrend: { day: string; rate: number }[] = []
  for (const d of eachDate(addDays(today, -13), addDays(today, -1))) {
    const scheduled = expected(d)
    if (scheduled.length === 0) continue
    const set = entered(d)
    attendanceTrend.push({
      day: new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
      rate: Math.round((scheduled.filter((e) => set.has(e.id)).length / scheduled.length) * 100),
    })
  }

  // ---- obligations for the latest finalized payroll month ----
  const lastRun = data.runs.find((r) => r.status !== 'draft' && r.run_type !== 'thirteenth_month') ?? null
  const lastMonthKey = data.slips.map((s) => s.period_month).filter(Boolean).sort().at(-1)?.slice(0, 7)
  // withholding tax goes on the 1601-C of the month the pay was RELEASED
  // (pay date); contributions belong to the payroll month
  const lastPayMonthKey = data.slips.map((s) => (s.pay_date ?? '').slice(0, 7)).filter(Boolean).sort().at(-1)
  const monthObligations = { tax: 0, sss: 0, philhealth: 0, pagibig: 0 }
  for (const s of data.slips) {
    if (lastPayMonthKey && (s.pay_date ?? '').slice(0, 7) === lastPayMonthKey) monthObligations.tax += Number(s.withholding_tax)
  }
  if (lastMonthKey) {
    for (const s of data.slips) {
      if ((s.period_month ?? '').slice(0, 7) !== lastMonthKey) continue
      monthObligations.sss +=
        Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.sss_er) + Number(s.sss_mpf_er) + Number(s.sss_ec_er)
      monthObligations.philhealth += Number(s.philhealth_ee) + Number(s.philhealth_er)
      monthObligations.pagibig += Number(s.pagibig_ee) + Number(s.pagibig_er)
    }
  }
  const monthLabel = (k: string | undefined) =>
    k ? new Date(`${k}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }) : null
  const lastMonthLabel = monthLabel(lastMonthKey)
  const lastPayMonthLabel = monthLabel(lastPayMonthKey)
  // the due dates of those months (spec T9): tax by pay month, contributions by payroll month
  const dueOf = (key: ObligationKey, monthKey: string | undefined): DueItem | null => {
    if (!monthKey) return null
    const period = `${monthKey}-01`
    return (
      dueCalendar({
        year: Number(monthKey.slice(0, 4)),
        filing: { mode: entity.filing_mode, group: entity.efps_group },
        contributionDays: { sss: entity.sss_due_day, philhealth: entity.philhealth_due_day, pagibig: entity.pagibig_due_day },
        overrides: data.dueOverrides,
      }).find((i) => i.key === key && i.period === period) ?? null
    )
  }
  const due = {
    tax: dueOf('1601c', lastPayMonthKey),
    sss: dueOf('sss', lastMonthKey),
    philhealth: dueOf('philhealth', lastMonthKey),
    pagibig: dueOf('pagibig', lastMonthKey),
  }

  return {
    active,
    byFrequency,
    lastWorkday,
    actions,
    costByMonth,
    attendanceTrend: attendanceTrend.slice(-10),
    lastRun,
    lastMonthLabel,
    lastPayMonthLabel,
    monthObligations,
    due,
  }
}
