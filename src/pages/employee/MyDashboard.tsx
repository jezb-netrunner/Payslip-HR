import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarCheck, CalendarRange, Eye, HandCoins, Megaphone, Pin, Wallet } from 'lucide-react'
import PayslipView, { runFromSlip, runLabel } from '../../components/PayslipView'
import { Avatar, Button, Card, Donut, EmptyState, LoadFailed, Modal, Spinner, StatCard, StatGroup } from '../../components/ui'
import { useAuth } from '../../lib/auth'
import { getHolidaysBetween } from '../../lib/api'
import type { Announcement, Entity, Holiday, LeaveRequest, LeaveType, Payslip, RecurringDeduction, TimeEntry } from '../../lib/db'
import { fmtDate, fmtDateTime, fmtHours, fullName, money, personInitials } from '../../lib/format'
import { nextInstallment } from '../../lib/advances'
import { eligibleFrom, leaveDaysInYear, showsBalance, usableOn } from '../../lib/leave'
import { endOfMonth, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { roundingLines } from '../../lib/payslip'
import { errorMessage } from '../../lib/errors'

export default function MyDashboard() {
  const { employee } = useAuth()
  const [entity, setEntity] = useState<Entity | null>(null)
  const [slips, setSlips] = useState<Payslip[]>([])
  const [news, setNews] = useState<Announcement[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [types, setTypes] = useState<LeaveType[]>([])
  const [leaves, setLeaves] = useState<LeaveRequest[]>([])
  const [ents, setEnts] = useState<Record<string, number>>({})
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [advances, setAdvances] = useState<Pick<RecurringDeduction, 'balance' | 'amount_per_period' | 'active' | 'start_date'>[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [viewing, setViewing] = useState<Payslip | null>(null)

  const today = todayManila()
  const year = today.slice(0, 4)
  const month = today.slice(0, 7)

  const load = useCallback(async () => {
    if (!employee) return
    setLoadError('')
    try {
      const [ent, ps, an, te, lt, lr, le, hols, adv] = await Promise.all([
        supabase.from('entities').select('*').eq('id', employee.entity_id).maybeSingle(),
        supabase.from('payslips').select('*').eq('employee_id', employee.id).order('pay_date', { ascending: false }).limit(60),
        supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('published_at', { ascending: false }).limit(5),
        supabase.from('time_entries').select('*').eq('employee_id', employee.id).gte('work_date', `${month}-01`).lte('work_date', endOfMonth(`${month}-01`)),
        supabase.from('leave_types').select('*').eq('active', true),
        supabase.from('leave_requests').select('*').eq('employee_id', employee.id).eq('status', 'approved'),
        supabase.from('employee_leave_entitlements').select('*').eq('employee_id', employee.id).eq('year', Number(year)),
        getHolidaysBetween(employee.entity_id, `${year}-01-01`, `${year}-12-31`),
        supabase
          .from('recurring_deductions')
          .select('balance, amount_per_period, active, start_date')
          .eq('employee_id', employee.id)
          .eq('category', 'cash_advance')
          .gt('balance', 0),
      ])
      const failed = [ent, ps, an, te, lt, lr, le, adv].find((r) => r.error)?.error
      if (failed) throw failed
      setHolidays(hols)
      setAdvances(adv.data ?? [])
      setEntity((ent.data as Entity) ?? null)
      setSlips((ps.data ?? []) as Payslip[])
      setNews((an.data ?? []) as Announcement[])
      setEntries((te.data ?? []) as TimeEntry[])
      setTypes((lt.data ?? []) as LeaveType[])
      setLeaves((lr.data ?? []) as LeaveRequest[])
      const m: Record<string, number> = {}
      for (const e of le.data ?? []) m[e.leave_type_id as string] = Number(e.days)
      setEnts(m)
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load your dashboard"))
    } finally {
      setLoading(false)
    }
  }, [employee, month, year])

  useEffect(() => {
    load()
  }, [load])

  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!employee || loading) return <Spinner />

  const latest = slips[0]
  const ytd = slips.filter((s) => (s.pay_date ?? s.period_month ?? '').slice(0, 4) === year)
  const sum = (f: (s: Payslip) => number) => ytd.reduce((a, s) => a + f(s), 0)
  const ytdContrib = sum((s) => Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee))
  const ytdThirteenth = sum((s) => (s.run_type === 'thirteenth_month' ? Number(s.gross_pay) : 0))

  const workedMinutes = entries
    .filter((e) => e.clock_out)
    .reduce((s, e) => s + (new Date(e.clock_out!).getTime() - new Date(e.clock_in).getTime()) / 60000, 0)
  const daysWithEntries = new Set(entries.map((e) => e.work_date)).size

  const used: Record<string, number> = {}
  for (const r of leaves) {
    const d = leaveDaysInYear(r, Number(year), employee.work_schedule.days, holidays)
    if (d > 0) used[r.leave_type_id] = (used[r.leave_type_id] ?? 0) + d
  }
  const balances = types
    .filter((t) => t.paid && showsBalance(t, ents[t.id]))
    .map((t) => ({
      t,
      total: ents[t.id] ?? Number(t.default_annual_days),
      // a leave that needs months of service (SIL) and doesn't open this year shows its opening date
      opens: usableOn(t, employee.hire_date, `${year}-12-31`, ents[t.id]) ? null : eligibleFrom(t, employee.hire_date),
    }))
    .slice(0, 4)

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Avatar name={fullName(employee)} initials={personInitials(employee)} size="lg" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-900 sm:text-[28px]">Hello, {employee.first_name}!</h1>
          <p className="text-sm text-slate-500">{entity?.name} · {fmtDate(today)}</p>
        </div>
      </div>

      {news.length > 0 && (
        <Card
          title="Announcements"
          icon={<Megaphone />}
          actions={<Link to="/me/announcements" className="text-xs font-semibold text-brand-600">See all</Link>}
        >
          <div className="space-y-3">
            {news.slice(0, 3).map((a) => (
              <div key={a.id} className={`rounded-xl border p-3.5 ${a.pinned ? 'border-accent-200 bg-accent-50' : 'border-slate-200/80 bg-slate-50/60'}`}>
                <p className="flex items-center gap-1.5 break-words text-sm font-bold text-ink-900">
                  {a.pinned && <Pin className="size-3.5 shrink-0 text-accent-600" />} <span className="min-w-0">{a.title}</span>
                </p>
                <p className="text-[11px] text-slate-400">{fmtDateTime(a.published_at)}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line break-words text-sm text-slate-600">{a.body}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Latest pay" icon={<Wallet />} className="lg:col-span-2">
          {!latest ? (
            <EmptyState title="No payslips yet" sub="Your payslip appears here once your payroll is finalized." />
          ) : (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">{runLabel(runFromSlip(latest))} · paid {fmtDate(latest.pay_date)}</p>
                  <p className="mt-1 text-4xl font-bold tracking-tight text-ink-900">{money(Number(latest.net_pay))}</p>
                  <p className="text-xs text-slate-400">take-home pay</p>
                </div>
                <Button variant="secondary" onClick={() => setViewing(latest)}>
                  <Eye className="size-4" /> Full payslip
                </Button>
              </div>
              <PayBreakdown slip={latest} />
            </div>
          )}
        </Card>

        <Card title={`This year (${year})`} icon={<CalendarRange />}>
          <dl className="space-y-2.5 text-sm">
            <Row label="Gross pay" value={money(sum((s) => Number(s.gross_pay)))} />
            <Row label="Take-home pay" value={money(sum((s) => Number(s.net_pay)))} strong />
            <Row label="Tax withheld" value={money(sum((s) => Number(s.withholding_tax)))} />
            <Row label="SSS / PhilHealth / Pag-IBIG" value={money(ytdContrib)} />
            {ytdThirteenth > 0 && <Row label="13th month pay" value={money(ytdThirteenth)} />}
            <Row label="Payslips" value={String(ytd.length)} />
          </dl>
          <Link to="/me/payslips" className="mt-4 flex items-center gap-1 text-xs font-semibold text-brand-600">
            All payslips <ArrowRight className="size-3.5" />
          </Link>
        </Card>
      </div>

      <StatGroup>
        <StatCard
          label="Days recorded this month"
          value={daysWithEntries}
          sub={`${fmtHours(workedMinutes)} on record`}
          icon={<CalendarCheck className="size-5" />}
        />
        {advances.length > 0 && (
          <StatCard
            label="Cash advance owed"
            value={money(advances.reduce((t, a) => t + Number(a.balance), 0))}
            sub={
              <Link to="/me/advances" className="font-semibold text-brand-600">
                {money(nextInstallment(advances.filter((a) => !a.start_date || a.start_date <= today)))} next payroll · details
              </Link>
            }
            icon={<HandCoins className="size-5" />}
          />
        )}
        {balances.map(({ t, total, opens }) =>
          opens ? (
            <StatCard key={t.id} label={t.name} value={fmtDate(opens)} sub={`available after ${t.min_service_months} months of service`} />
          ) : (
            <StatCard
              key={t.id}
              label={t.name}
              value={`${total - (used[t.id] ?? 0)} / ${total}`}
              sub={total - (used[t.id] ?? 0) < 0 ? 'days beyond your entitlement' : 'days left this year'}
            />
          ),
        )}
      </StatGroup>

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title="Payslip" wide>
        {viewing && entity && <PayslipView slip={viewing} run={runFromSlip(viewing)} company={entity} />}
      </Modal>
    </div>
  )
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-500">{label}</dt>
      <dd className={strong ? 'font-bold text-ink-900' : 'font-semibold text-slate-700'}>{value}</dd>
    </div>
  )
}

// Categorical colours in fixed order (validated with the dataviz checks);
// "Other deductions" folds into a neutral grey. Every segment is labelled
// with its amount in the legend, so no colour stands alone.
const PART_COLORS = ['#3a8a5c', '#1d6fb1', '#eda100', '#6250d6', '#d9661a', '#9fa1ae']

/** Where the gross went: take-home vs each deduction, as a ring + legend. */
function PayBreakdown({ slip }: { slip: Payslip }) {
  const gross = Number(slip.gross_pay)
  const rounding = roundingLines(slip)
  const parts = [
    {
      label: rounding.length ? 'Net pay (before cash rounding)' : 'Take-home',
      amount: Number(slip.net_pay) - Number(slip.rounding_adjustment),
    },
    { label: 'SSS', amount: Number(slip.sss_ee) + Number(slip.sss_mpf_ee) },
    { label: 'PhilHealth', amount: Number(slip.philhealth_ee) },
    { label: 'Pag-IBIG', amount: Number(slip.pagibig_ee) },
    { label: 'Tax', amount: Math.max(0, Number(slip.withholding_tax)) },
    { label: 'Other deductions', amount: Number(slip.other_deductions_total) },
  ]
    .map((p, i) => ({ ...p, color: PART_COLORS[i] }))
    .filter((p) => p.amount > 0)

  return (
    <div className="mt-6">
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <Donut
          size={168}
          thickness={16}
          segments={parts.map((p) => ({ label: p.label, value: p.amount, color: p.color }))}
          center={
            <>
              <p className="text-base font-bold text-ink-900">{money(gross)}</p>
              <p className="text-xs text-slate-500">Gross pay</p>
            </>
          }
        />
        <div className="grid w-full flex-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {parts.map((p) => (
            <div key={p.label} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 text-slate-500">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                {p.label}
              </span>
              <span className="font-semibold text-ink-900">{money(p.amount)}</span>
            </div>
          ))}
          {Number(slip.withholding_tax) < 0 && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-leaf-700">Tax refund (year-end adjustment)</span>
              <span className="font-semibold text-leaf-700">+{money(-Number(slip.withholding_tax))}</span>
            </div>
          )}
          {rounding.map((l) => (
            <div key={l.label} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-slate-500">{l.label}</span>
              <span className="font-semibold text-ink-900">{l.amount > 0 ? '+' : ''}{money(l.amount)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500 sm:grid-cols-4">
        <span>Days worked: <b className="text-ink-900">{Number(slip.days_worked)}</b></span>
        <span>OT hours: <b className="text-ink-900">{Number(slip.overtime_hours)}</b></span>
        <span>Late: <b className="text-ink-900">{Number(slip.late_minutes)} min</b></span>
        <span>Absences: <b className="text-ink-900">{Number(slip.absent_days)}</b></span>
      </div>
    </div>
  )
}
