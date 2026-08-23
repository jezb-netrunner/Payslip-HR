import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ClipboardCheck,
  Clock,
  Landmark,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Badge, Card, PageHeader, Spinner, StatCard } from '../../components/ui'
import { getSettings } from '../../lib/api'
import type { CompanySettings, Employee, Holiday, PayrollRun, Payslip, TimeEntry } from '../../lib/db'
import { fmtDate, money, moneyWhole } from '../../lib/format'
import { eachDate, isoWeekday, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

// Categorical palette — validated (dataviz six checks, light surface):
// navy → orange → teal → violet, fixed assignment order.
const C = { net: '#2c5292', ee: '#0d9488', er: '#e06614', late: '#7c3aed' }

interface DashData {
  settings: CompanySettings
  employees: Employee[]
  todayEntries: TimeEntry[]
  recentEntries: TimeEntry[]
  runs: PayrollRun[]
  slips: (Payslip & { payroll_runs: PayrollRun })[]
  holidays: Holiday[]
  pendingCorrections: number
  pendingLeaves: number
}

export default function Dashboard() {
  const [data, setData] = useState<DashData | null>(null)
  const today = todayManila()

  const load = useCallback(async () => {
    const twoWeeksAgo = eachDate(addDays(today, -13), today)[0]
    const [settings, emps, todayEnt, recentEnt, runsRes, slipsRes, hols, corr, leaves] =
      await Promise.all([
        getSettings(),
        supabase.from('employees').select('*'),
        supabase.from('time_entries').select('*').eq('work_date', today),
        supabase.from('time_entries').select('*').gte('work_date', twoWeeksAgo),
        supabase
          .from('payroll_runs')
          .select('*')
          .in('status', ['finalized', 'paid'])
          .order('period_end', { ascending: false })
          .limit(12),
        supabase
          .from('payslips')
          .select('*, payroll_runs!inner(*)')
          .in('payroll_runs.status', ['finalized', 'paid'])
          .order('created_at', { ascending: false })
          .limit(600),
        supabase
          .from('holidays')
          .select('*')
          .gte('holiday_date', today)
          .lte('holiday_date', addDays(today, 45))
          .order('holiday_date'),
        supabase
          .from('time_correction_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
        supabase
          .from('leave_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending'),
      ])
    setData({
      settings,
      employees: (emps.data ?? []) as Employee[],
      todayEntries: (todayEnt.data ?? []) as TimeEntry[],
      recentEntries: (recentEnt.data ?? []) as TimeEntry[],
      runs: (runsRes.data ?? []) as PayrollRun[],
      slips: (slipsRes.data ?? []) as (Payslip & { payroll_runs: PayrollRun })[],
      holidays: (hols.data ?? []) as Holiday[],
      pendingCorrections: corr.count ?? 0,
      pendingLeaves: leaves.count ?? 0,
    })
  }, [today])

  useEffect(() => {
    load()
  }, [load])

  const derived = useMemo(() => (data ? derive(data, today) : null), [data, today])

  if (!data || !derived) return <Spinner />

  const { settings } = data

  return (
    <div>
      <PageHeader
        title={settings.company_name}
        subtitle={`Workforce and payroll insights · ${fmtDate(today)}`}
      />

      {/* headline tiles */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active headcount"
          value={derived.activeCount}
          sub={`${derived.avgTenure.toFixed(1)} yrs average tenure`}
          icon={<Users className="size-5" />}
        />
        <StatCard
          label="Present today"
          value={`${derived.presentToday} / ${derived.scheduledToday}`}
          sub={derived.onClockNow > 0 ? `${derived.onClockNow} on the clock now` : 'nobody clocked in right now'}
          icon={<Clock className="size-5" />}
          tone={derived.scheduledToday > 0 && derived.presentToday < derived.scheduledToday ? 'warn' : 'good'}
        />
        <StatCard
          label="Last payroll — employer cost"
          value={derived.lastRun ? moneyWhole(derived.lastRun.totals?.employer_cost ?? 0) : '—'}
          sub={derived.lastRun ? `net payout ${moneyWhole(derived.lastRun.totals?.net ?? 0)}` : 'no finalized runs yet'}
          icon={<Wallet className="size-5" />}
        />
        <StatCard
          label="Needs your action"
          value={derived.actionCount}
          sub="flagged punches, approvals, alerts"
          icon={<ClipboardCheck className="size-5" />}
          tone={derived.actionCount > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        {/* action center */}
        <Card title="Action center" className="lg:col-span-1">
          {derived.actions.length === 0 ? (
            <p className="text-sm text-slate-400">All clear — nothing needs your attention. 🎉</p>
          ) : (
            <div className="space-y-2.5">
              {derived.actions.map((a, i) => (
                <Link
                  key={i}
                  to={a.to}
                  className="flex items-start justify-between gap-2 rounded-xl border border-slate-100 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50/40"
                >
                  <div className="flex items-start gap-2.5">
                    <span className={`mt-0.5 ${a.tone === 'warn' ? 'text-amber-500' : 'text-brand-400'}`}>
                      {a.icon}
                    </span>
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

        {/* payroll cost trend */}
        <Card
          title="Payroll cost by month"
          className="lg:col-span-2"
          actions={<span className="text-xs text-slate-400">finalized runs · PHP</span>}
        >
          {derived.costByMonth.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">
              Finalize your first payroll run to see cost trends.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={derived.costByMonth} barCategoryGap="28%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
                />
                <Tooltip
                  formatter={(v, name) => [money(Number(v ?? 0)), String(name)]}
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Net pay" stackId="a" fill={C.net} stroke="#ffffff" strokeWidth={2} />
                <Bar dataKey="Employee deductions" stackId="a" fill={C.ee} stroke="#ffffff" strokeWidth={2} />
                <Bar
                  dataKey="Employer contributions"
                  stackId="a"
                  fill={C.er}
                  stroke="#ffffff"
                  strokeWidth={2}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        {/* attendance trend */}
        <Card title="Attendance rate — last 10 workdays" className="lg:col-span-2">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={derived.attendanceTrend} barCategoryGap="35%">
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: '#64748b' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                formatter={(v) => [`${Number(v ?? 0)}%`, 'Attendance']}
                contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
              />
              <Bar dataKey="rate" name="Attendance" fill={C.net} radius={[4, 4, 0, 0]} maxBarSize={26} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        {/* tardiness leaderboard */}
        <Card title="Tardiness — last 14 days">
          {derived.tardiness.length === 0 ? (
            <p className="text-sm text-slate-400">No lates recorded. Great discipline!</p>
          ) : (
            <div className="space-y-3">
              {derived.tardiness.map((t) => (
                <div key={t.name}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-700">{t.name}</span>
                    <span className="text-slate-500">{t.minutes} min late · {t.count}×</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (t.minutes / (derived.tardiness[0]?.minutes || 1)) * 100)}%`,
                        background: C.late,
                      }}
                    />
                  </div>
                </div>
              ))}
              <p className="pt-1 text-[11px] text-slate-400">
                Chronic tardiness is a coachable pattern — consider a conversation before it hits pay.
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* statutory obligations */}
        <Card title="Statutory obligations — last finalized month" className="lg:col-span-2">
          {derived.lastRun ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ObligationTile
                label="BIR withholding tax"
                amount={derived.monthObligations.tax}
                due="File 1601-C by the 10th of the following month"
              />
              <ObligationTile
                label="SSS (EE + ER + EC)"
                amount={derived.monthObligations.sss}
                due="Pay by end of the following month"
              />
              <ObligationTile
                label="PhilHealth"
                amount={derived.monthObligations.philhealth}
                due="Pay within the following month"
              />
              <ObligationTile
                label="Pag-IBIG"
                amount={derived.monthObligations.pagibig}
                due="Pay by the 10th–15th of the following month"
              />
            </div>
          ) : (
            <p className="text-sm text-slate-400">Totals appear after your first finalized run.</p>
          )}
          <p className="mt-3 text-[11px] text-slate-400">
            Amounts come from finalized payslips for {derived.lastMonthLabel ?? 'the latest month'} —
            employee + employer shares combined. Always confirm deadlines on each agency's schedule.
          </p>
        </Card>

        {/* upcoming holidays */}
        <Card title="Upcoming holidays">
          {data.holidays.length === 0 ? (
            <p className="text-sm text-slate-400">None in the next 45 days.</p>
          ) : (
            <div className="space-y-2.5">
              {data.holidays.slice(0, 6).map((h) => (
                <div key={h.id} className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{h.name}</p>
                    <p className="text-xs text-slate-400">{fmtDate(h.holiday_date)}</p>
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
    </div>
  )
}

function ObligationTile({ label, amount, due }: { label: string; amount: number; due: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-extrabold text-brand-900">{money(amount)}</p>
      <p className="mt-0.5 text-[11px] text-slate-400">{due}</p>
    </div>
  )
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

interface ActionItem {
  title: string
  sub: string
  to: string
  tone: 'warn' | 'info'
  icon: React.ReactNode
}

function derive(data: DashData, today: string) {
  const inactive = ['resigned', 'terminated', 'retired']
  const active = data.employees.filter((e) => !inactive.includes(e.employment_status))
  const activeCount = active.length
  const avgTenure =
    activeCount === 0
      ? 0
      : active.reduce(
          (s, e) => s + (Date.now() - new Date(e.hire_date).getTime()) / (365.25 * 864e5),
          0,
        ) / activeCount

  const weekdayToday = isoWeekday(today)
  const scheduledToday = active.filter((e) => e.work_schedule.days.includes(weekdayToday)).length
  const presentIds = new Set(data.todayEntries.map((t) => t.employee_id))
  const presentToday = presentIds.size
  const onClockNow = data.todayEntries.filter((t) => !t.clock_out).length

  const flagged = data.recentEntries.filter(
    (e) => e.flags.filter((f) => f !== 'corrected' && f !== 'admin_entry').length > 0,
  ).length

  // ---- actions ----
  const actions: ActionItem[] = []
  if (flagged > 0)
    actions.push({
      title: `${flagged} flagged punch/es to review`,
      sub: 'Missing selfies, new devices, device mismatches (last 14 days)',
      to: '/admin/attendance',
      tone: 'warn',
      icon: <AlertTriangle className="size-4" />,
    })
  if (data.pendingCorrections > 0)
    actions.push({
      title: `${data.pendingCorrections} time correction/s pending`,
      sub: 'Approve or reject employee-filed corrections',
      to: '/admin/attendance',
      tone: 'warn',
      icon: <Clock className="size-4" />,
    })
  if (data.pendingLeaves > 0)
    actions.push({
      title: `${data.pendingLeaves} leave request/s pending`,
      sub: 'Approvals affect payroll for the period',
      to: '/admin/leaves',
      tone: 'warn',
      icon: <CalendarClock className="size-4" />,
    })

  const probationEnding = active.filter((e) => {
    if (e.employment_status !== 'probationary') return false
    const end = addDays(e.hire_date, 180) // 6-month probation cap (Art. 296)
    return end >= today && end <= addDays(today, 30)
  })
  if (probationEnding.length > 0)
    actions.push({
      title: `${probationEnding.length} probation/s ending within 30 days`,
      sub: `${probationEnding.map((e) => e.first_name + ' ' + e.last_name).join(', ')} — decide on regularization (6-month limit, Labor Code Art. 296)`,
      to: '/admin/employees',
      tone: 'info',
      icon: <Users className="size-4" />,
    })

  const minWage = Number(data.settings.minimum_wage_daily)
  const divisor = Number(data.settings.working_days_divisor)
  const belowMin = active.filter((e) => {
    const daily = e.pay_type === 'daily' ? Number(e.daily_rate) : (Number(e.monthly_rate) * 12) / divisor
    return daily > 0 && daily + 0.01 < minWage
  })
  if (belowMin.length > 0)
    actions.push({
      title: `${belowMin.length} employee/s paid below minimum wage`,
      sub: `Configured floor is ${money(minWage)}/day (${data.settings.minimum_wage_region})`,
      to: '/admin/employees',
      tone: 'warn',
      icon: <Landmark className="size-4" />,
    })

  const year = today.slice(0, 4)
  const has13th = data.runs.some(
    (r) => r.run_type === 'thirteenth_month' && r.period_end.slice(0, 4) === year,
  )
  if (!has13th && Number(today.slice(5, 7)) >= 11)
    actions.push({
      title: '13th month pay not yet run',
      sub: 'Due not later than December 24 (PD 851)',
      to: '/admin/payroll',
      tone: 'warn',
      icon: <Wallet className="size-4" />,
    })

  const zeroRate = active.filter((e) => Number(e.monthly_rate) === 0 && Number(e.daily_rate) === 0)
  if (zeroRate.length > 0)
    actions.push({
      title: `${zeroRate.length} employee/s with no pay rate set`,
      sub: 'They will compute ₱0 on the next payroll run',
      to: '/admin/employees',
      tone: 'warn',
      icon: <TrendingUp className="size-4" />,
    })

  // ---- payroll cost by month (finalized) ----
  const byMonth = new Map<string, { net: number; ee: number; er: number }>()
  for (const s of data.slips) {
    if (s.payroll_runs.run_type === 'thirteenth_month') continue
    const key = s.payroll_runs.period_end.slice(0, 7)
    const cur = byMonth.get(key) ?? { net: 0, ee: 0, er: 0 }
    const ee =
      Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee) +
      Number(s.withholding_tax) + Number(s.other_deductions_total)
    const er =
      Number(s.sss_er) + Number(s.sss_mpf_er) + Number(s.sss_ec_er) + Number(s.philhealth_er) +
      Number(s.pagibig_er)
    cur.net += Number(s.net_pay)
    cur.ee += ee
    cur.er += er
    byMonth.set(key, cur)
  }
  const costByMonth = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6)
    .map(([k, v]) => ({
      month: new Date(`${k}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'short', year: '2-digit' }),
      'Net pay': Math.round(v.net),
      'Employee deductions': Math.round(v.ee),
      'Employer contributions': Math.round(v.er),
    }))

  // ---- attendance trend: last 10 scheduled-for-anyone workdays ----
  const days = eachDate(addDays(today, -13), today)
  const attendanceTrend: { day: string; rate: number }[] = []
  for (const d of days) {
    const wd = isoWeekday(d)
    const scheduled = active.filter((e) => e.work_schedule.days.includes(wd)).length
    if (scheduled === 0) continue
    const present = new Set(
      data.recentEntries.filter((t) => t.work_date === d).map((t) => t.employee_id),
    ).size
    attendanceTrend.push({
      day: new Date(`${d}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }),
      rate: Math.round((present / scheduled) * 100),
    })
  }

  // ---- tardiness (approx: first punch after scheduled start + grace) ----
  const lateByEmp = new Map<string, { minutes: number; count: number }>()
  for (const t of data.recentEntries) {
    const emp = active.find((e) => e.id === t.employee_id)
    if (!emp) continue
    const [sh, sm] = emp.work_schedule.start.split(':').map(Number)
    const startMin = sh * 60 + sm + data.settings.grace_period_minutes
    const inManila = new Date(new Date(t.clock_in).getTime() + 8 * 3600 * 1000)
    const inMin = inManila.getUTCHours() * 60 + inManila.getUTCMinutes()
    if (emp.work_schedule.days.includes(isoWeekday(t.work_date)) && inMin > startMin) {
      const cur = lateByEmp.get(emp.id) ?? { minutes: 0, count: 0 }
      cur.minutes += inMin - startMin
      cur.count += 1
      lateByEmp.set(emp.id, cur)
    }
  }
  const tardiness = [...lateByEmp.entries()]
    .map(([id, v]) => {
      const e = active.find((x) => x.id === id)!
      return { name: `${e.first_name} ${e.last_name}`, ...v }
    })
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)

  // ---- statutory obligations for the latest finalized month ----
  const lastRun = data.runs.filter((r) => r.run_type !== 'thirteenth_month')[0] ?? null
  const lastMonthKey = lastRun?.period_end.slice(0, 7)
  const monthObligations = { tax: 0, sss: 0, philhealth: 0, pagibig: 0 }
  if (lastMonthKey) {
    for (const s of data.slips) {
      if (s.payroll_runs.period_end.slice(0, 7) !== lastMonthKey) continue
      monthObligations.tax += Number(s.withholding_tax)
      monthObligations.sss +=
        Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.sss_er) + Number(s.sss_mpf_er) + Number(s.sss_ec_er)
      monthObligations.philhealth += Number(s.philhealth_ee) + Number(s.philhealth_er)
      monthObligations.pagibig += Number(s.pagibig_ee) + Number(s.pagibig_er)
    }
  }
  const lastMonthLabel = lastMonthKey
    ? new Date(`${lastMonthKey}-01T00:00:00`).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' })
    : null

  return {
    activeCount,
    avgTenure,
    scheduledToday,
    presentToday,
    onClockNow,
    actionCount: actions.length,
    actions,
    costByMonth,
    attendanceTrend: attendanceTrend.slice(-10),
    tardiness,
    lastRun,
    lastMonthLabel,
    monthObligations,
  }
}
