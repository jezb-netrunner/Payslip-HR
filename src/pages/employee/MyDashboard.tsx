import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, CalendarCheck, Eye, Megaphone, Pin, Wallet } from 'lucide-react'
import PayslipView, { runFromSlip, runLabel } from '../../components/PayslipView'
import { Card, EmptyState, Modal, Spinner, StatCard } from '../../components/ui'
import { useAuth } from '../../lib/auth'
import type { Announcement, Entity, LeaveRequest, LeaveType, Payslip, TimeEntry } from '../../lib/db'
import { fmtDate, fmtDateTime, fmtHours, money } from '../../lib/format'
import { endOfMonth, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

export default function MyDashboard() {
  const { employee } = useAuth()
  const [entity, setEntity] = useState<Entity | null>(null)
  const [slips, setSlips] = useState<Payslip[]>([])
  const [news, setNews] = useState<Announcement[]>([])
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [types, setTypes] = useState<LeaveType[]>([])
  const [leaves, setLeaves] = useState<LeaveRequest[]>([])
  const [ents, setEnts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<Payslip | null>(null)

  const today = todayManila()
  const year = today.slice(0, 4)
  const month = today.slice(0, 7)

  const load = useCallback(async () => {
    if (!employee) return
    const [ent, ps, an, te, lt, lr, le] = await Promise.all([
      supabase.from('entities').select('*').eq('id', employee.entity_id).maybeSingle(),
      supabase.from('payslips').select('*').eq('employee_id', employee.id).order('pay_date', { ascending: false }).limit(60),
      supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('published_at', { ascending: false }).limit(5),
      supabase.from('time_entries').select('*').eq('employee_id', employee.id).gte('work_date', `${month}-01`).lte('work_date', endOfMonth(`${month}-01`)),
      supabase.from('leave_types').select('*').eq('active', true),
      supabase.from('leave_requests').select('*').eq('employee_id', employee.id).eq('status', 'approved'),
      supabase.from('employee_leave_entitlements').select('*').eq('employee_id', employee.id).eq('year', Number(year)),
    ])
    setEntity((ent.data as Entity) ?? null)
    setSlips((ps.data ?? []) as Payslip[])
    setNews((an.data ?? []) as Announcement[])
    setEntries((te.data ?? []) as TimeEntry[])
    setTypes((lt.data ?? []) as LeaveType[])
    setLeaves((lr.data ?? []) as LeaveRequest[])
    const m: Record<string, number> = {}
    for (const e of le.data ?? []) m[e.leave_type_id as string] = Number(e.days)
    setEnts(m)
    setLoading(false)
  }, [employee, month, year])

  useEffect(() => {
    load()
  }, [load])

  if (!employee || loading) return <Spinner />

  const latest = slips[0]
  const ytd = slips.filter((s) => (s.period_month ?? s.pay_date ?? '').slice(0, 4) === year)
  const sum = (f: (s: Payslip) => number) => ytd.reduce((a, s) => a + f(s), 0)
  const ytdContrib = sum((s) => Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee))
  const ytdThirteenth = sum((s) => (s.run_type === 'thirteenth_month' ? Number(s.gross_pay) : 0))

  const workedMinutes = entries
    .filter((e) => e.clock_out)
    .reduce((s, e) => s + (new Date(e.clock_out!).getTime() - new Date(e.clock_in).getTime()) / 60000, 0)
  const daysWithEntries = new Set(entries.map((e) => e.work_date)).size

  const used: Record<string, number> = {}
  for (const r of leaves) if (r.start_date.slice(0, 4) === year) used[r.leave_type_id] = (used[r.leave_type_id] ?? 0) + Number(r.days)
  const balances = types
    .map((t) => ({ t, total: ents[t.id] ?? Number(t.default_annual_days) }))
    .filter((x) => x.total > 0 && x.t.paid)
    .slice(0, 4)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-brand-900">Hello, {employee.first_name}!</h1>
        <p className="text-sm text-slate-500">{entity?.name} · {fmtDate(today)}</p>
      </div>

      {news.length > 0 && (
        <Card
          title={<span className="flex items-center gap-2"><Megaphone className="size-4" /> Announcements</span>}
          actions={<Link to="/me/announcements" className="text-xs font-semibold text-brand-600">See all</Link>}
        >
          <div className="space-y-3">
            {news.slice(0, 3).map((a) => (
              <div key={a.id} className={`rounded-xl p-3 ${a.pinned ? 'bg-accent-50' : 'bg-slate-50'}`}>
                <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
                  {a.pinned && <Pin className="size-3.5 text-accent-600" />} {a.title}
                </p>
                <p className="text-[11px] text-slate-400">{fmtDateTime(a.published_at)}</p>
                <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-slate-600">{a.body}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2"><Wallet className="size-4" /> Latest pay</span>} className="lg:col-span-2">
          {!latest ? (
            <EmptyState title="No payslips yet" sub="Your payslip appears here once your payroll is finalized." />
          ) : (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-slate-500">{runLabel(runFromSlip(latest))} · paid {fmtDate(latest.pay_date)}</p>
                  <p className="mt-1 text-4xl font-extrabold tracking-tight text-brand-900">{money(Number(latest.net_pay))}</p>
                  <p className="text-xs text-slate-400">take-home pay</p>
                </div>
                <button
                  onClick={() => setViewing(latest)}
                  className="flex items-center gap-1 text-sm font-semibold text-brand-600 hover:text-brand-800"
                >
                  <Eye className="size-4" /> Full payslip
                </button>
              </div>
              <PayBreakdown slip={latest} />
            </div>
          )}
        </Card>

        <Card title={`This year (${year})`}>
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Days recorded this month"
          value={daysWithEntries}
          sub={`${fmtHours(workedMinutes)} on record`}
          icon={<CalendarCheck className="size-5" />}
        />
        {balances.map(({ t, total }) => (
          <StatCard
            key={t.id}
            label={t.name}
            value={`${Math.max(0, total - (used[t.id] ?? 0))} / ${total}`}
            sub="days left this year"
          />
        ))}
      </div>

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
      <dd className={strong ? 'font-extrabold text-brand-900' : 'font-semibold text-slate-700'}>{value}</dd>
    </div>
  )
}

/** Where the gross went: take-home vs each deduction, as a single bar + legend. */
function PayBreakdown({ slip }: { slip: Payslip }) {
  const gross = Number(slip.gross_pay)
  const parts = [
    { label: 'Take-home', amount: Number(slip.net_pay) - Number(slip.rounding_adjustment), color: '#2c5292' },
    { label: 'SSS', amount: Number(slip.sss_ee) + Number(slip.sss_mpf_ee), color: '#0d9488' },
    { label: 'PhilHealth', amount: Number(slip.philhealth_ee), color: '#e06614' },
    { label: 'Pag-IBIG', amount: Number(slip.pagibig_ee), color: '#7c3aed' },
    { label: 'Tax', amount: Math.max(0, Number(slip.withholding_tax)), color: '#be123c' },
    { label: 'Other deductions', amount: Number(slip.other_deductions_total), color: '#64748b' },
  ].filter((p) => p.amount > 0)
  const total = parts.reduce((s, p) => s + p.amount, 0) || 1

  return (
    <div className="mt-5">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {parts.map((p) => (
          <div key={p.label} style={{ width: `${(p.amount / total) * 100}%`, background: p.color }} title={`${p.label} ${money(p.amount)}`} />
        ))}
      </div>
      <div className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-slate-600">Gross pay</span>
          <span className="font-bold text-slate-800">{money(gross)}</span>
        </div>
        {parts.map((p) => (
          <div key={p.label} className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 text-slate-500">
              <span className="size-2.5 rounded-full" style={{ background: p.color }} />
              {p.label}
            </span>
            <span className="font-semibold text-slate-700">{money(p.amount)}</span>
          </div>
        ))}
        {Number(slip.rounding_adjustment) !== 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">Cash rounding</span>
            <span className="font-semibold text-slate-700">{money(Number(slip.rounding_adjustment))}</span>
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500 sm:grid-cols-4">
        <span>Days worked: <b>{Number(slip.days_worked)}</b></span>
        <span>OT hours: <b>{Number(slip.overtime_hours)}</b></span>
        <span>Late: <b>{Number(slip.late_minutes)} min</b></span>
        <span>Absences: <b>{Number(slip.absent_days)}</b></span>
      </div>
    </div>
  )
}
