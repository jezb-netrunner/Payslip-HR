// Pay history (admins only): every rate the employee has had, charted as a
// step line and listed with the change from the rate before; the gross pay
// of each payroll month; and finalized payrolls paid at a rate other than
// the one the history now gives their period. A rate changes only here —
// payroll pays each day at the rate in effect that day.

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Pencil, Plus, Trash2, TrendingUp } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button, Card, Field, IconButton, Input, Modal, Select, Textarea } from '../../components/ui'
import { CHART_SERIES, InsightChart } from '../../components/InsightChart'
import { useToast } from '../../components/toast'
import type { Employee, EmployeePayRate, Entity } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, fmtDateTime, money } from '../../lib/format'
import { PAY_RATE_REASON_LABELS } from '../../lib/labels'
import { currentAndUpcoming, rateText } from '../../lib/payHistory'
import { addDays, todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { monthlyEquivalent, rateChanges, rateOn, type PayRateReason } from '../../payroll/payRates'

const GRID = '#e6e6ed'
const BASELINE = '#cfcfd8'
const MUTED = '#767888'
const INK = '#41434f'
const SERIES = CHART_SERIES[0]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function changeText(change?: number, pct?: number): string {
  if (change === undefined) return ''
  const sign = change > 0 ? '+' : change < 0 ? '−' : ''
  return `${sign}${money(Math.abs(change))}${pct !== undefined ? ` (${sign}${Math.abs(pct).toFixed(1)}%)` : ''}`
}

// ---------- recording a rate ----------

interface RateForm {
  id?: string
  effective_from: string
  pay_type: 'monthly' | 'daily'
  rate: string
  reason: PayRateReason
  approved_by: string
  note: string
}

export function PayRateModal({
  open,
  onClose,
  employee,
  entity,
  rates,
  editing,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  employee: Employee
  entity: Entity
  rates: EmployeePayRate[]
  editing?: EmployeePayRate | null
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<RateForm>(() => blankForm())
  function blankForm(): RateForm {
    if (editing) {
      return {
        id: editing.id,
        effective_from: editing.effective_from,
        pay_type: editing.pay_type,
        rate: String(editing.rate),
        reason: editing.reason,
        approved_by: editing.approved_by,
        note: editing.note,
      }
    }
    const now = currentAndUpcoming(rates).current
    return { effective_from: todayManila(), pay_type: now?.pay_type ?? employee.pay_type, rate: '', reason: 'merit_increase', approved_by: '', note: '' }
  }
  useEffect(() => {
    if (open) setF(blankForm())
    // a fresh form each time it opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id])

  const others = rates.filter((r) => r.id !== f.id)
  const before = f.effective_from ? rateOn(others.filter((r) => r.effective_from < f.effective_from), addDays(f.effective_from, -1)) : undefined
  const amount = Number(f.rate)
  const daysPerYear = Number(employee.days_per_year ?? entity.working_days_divisor)
  const preview =
    before && amount > 0
      ? rateChanges([before, { ...before, effective_from: f.effective_from, pay_type: f.pay_type, rate: amount }], daysPerYear)[1]
      : undefined

  async function save() {
    if (!f.effective_from) return toast('error', 'Enter the date the rate takes effect.')
    if (!(amount > 0)) return toast('error', 'Enter the rate.')
    if (f.effective_from < employee.hire_date) return toast('error', `The rate can't start before the hire date (${fmtDate(employee.hire_date)}).`)
    setBusy(true)
    try {
      const row = {
        effective_from: f.effective_from,
        pay_type: f.pay_type,
        rate: amount,
        reason: f.reason,
        approved_by: f.approved_by.trim(),
        note: f.note.trim(),
      }
      const { error } = f.id
        ? await supabase.from('employee_pay_rates').update(row).eq('id', f.id)
        : await supabase.from('employee_pay_rates').insert({ ...row, employee_id: employee.id })
      if (error) throw error
      toast('success', f.effective_from > todayManila() ? `Pay rate recorded: it takes effect on ${fmtDate(f.effective_from)}.` : 'Pay rate recorded.')
      onClose()
      await onSaved()
    } catch (err) {
      const msg = errorMessage(err, 'Save failed')
      toast('error', /one_per_date/.test(msg) ? 'There is already a rate from that date: edit it instead.' : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={f.id ? 'Edit pay rate' : 'Change pay rate'}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Takes effect on" hint="Payroll pays each day at the rate in effect that day">
            <Input type="date" min={employee.hire_date} value={f.effective_from} onChange={(e) => setF({ ...f, effective_from: e.target.value })} />
          </Field>
          <Field label="Reason">
            <Select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value as PayRateReason })}>
              {Object.entries(PAY_RATE_REASON_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </Field>
          <Field label="Rate basis">
            <Select value={f.pay_type} onChange={(e) => setF({ ...f, pay_type: e.target.value as 'monthly' | 'daily' })}>
              <option value="monthly">Monthly-rated</option>
              <option value="daily">Daily-rated (no work, no pay)</option>
            </Select>
          </Field>
          <Field label={f.pay_type === 'monthly' ? 'Monthly rate (PHP)' : 'Daily rate (PHP)'}>
            <Input type="number" min={0} step="0.01" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
          </Field>
          <Field label="Approved by" hint="Name or memo reference (optional)" className="sm:col-span-2">
            <Input maxLength={120} value={f.approved_by} onChange={(e) => setF({ ...f, approved_by: e.target.value })} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <Textarea rows={2} maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {before && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            From {fmtDate(f.effective_from)}: {rateText(before)}
            {amount > 0 && (
              <>
                {' → '}
                <span className="font-semibold text-ink-900">{rateText({ pay_type: f.pay_type, rate: amount })}</span>
                {preview?.change !== undefined && <span className="text-slate-500"> · {changeText(preview.change, preview.pct)}{before.pay_type !== f.pay_type ? ' a month' : ''}</span>}
              </>
            )}
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : f.id ? 'Save changes' : 'Record pay rate'}
        </Button>
      </div>
    </Modal>
  )
}

// ---------- the chart ----------

interface RatePoint {
  t: number
  rate: number
  date: string
  label: string
  reason?: string
  change: boolean
}

function RateChart({ rates, daysPerYear, minimumWageDaily }: { rates: EmployeePayRate[]; daysPerYear: number; minimumWageDaily: number }) {
  const sorted = [...rates].sort((a, b) => a.effective_from.localeCompare(b.effective_from))
  const monthly = sorted.some((r) => r.pay_type === 'monthly')
  const mixed = monthly && sorted.some((r) => r.pay_type === 'daily')
  // one basis on the axis: monthly amounts when the basis changed
  const value = (r: EmployeePayRate) => (mixed ? monthlyEquivalent(r, daysPerYear) : Number(r.rate))
  const unit = monthly ? 'a month' : 'a day'
  const today = todayManila()
  const first = Date.parse(sorted[0].effective_from)
  const lastDate = sorted[sorted.length - 1].effective_from > today ? sorted[sorted.length - 1].effective_from : today
  const end = Date.parse(lastDate) + Math.max(15 * 864e5, (Date.parse(lastDate) - first) * 0.04)
  const points: RatePoint[] = sorted.map((r) => ({
    t: Date.parse(r.effective_from),
    rate: value(r),
    date: r.effective_from,
    label: PAY_RATE_REASON_LABELS[r.reason],
    reason: r.note,
    change: true,
  }))
  points.push({ ...points[points.length - 1], t: end, change: false })
  // the client's minimum wage on the same basis (current setting)
  const floor = minimumWageDaily > 0 ? (monthly ? Math.round((minimumWageDaily * daysPerYear) / 12) : minimumWageDaily) : 0
  const values = points.map((p) => p.rate).concat(floor > 0 ? [floor] : [])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05)
  // clean ticks: a 1, 2, 2.5 or 5 step of the right size
  const rough = (hi - lo + 2 * pad) / 4
  const mag = 10 ** Math.floor(Math.log10(rough))
  const step = ([1, 2, 2.5, 5, 10].find((n) => n * mag >= rough) ?? 10) * mag
  const yLo = Math.max(0, Math.floor((lo - pad) / step) * step)
  const yHi = Math.ceil((hi + pad) / step) * step
  const yTicks = Array.from({ length: Math.round((yHi - yLo) / step) + 1 }, (_, i) => yLo + i * step)
  const yTick = (v: number) => (v >= 1000 ? `₱${(Math.round(v / 100) / 10).toLocaleString()}K` : `₱${v.toLocaleString()}`)
  const xTick = (t: number) => {
    const d = new Date(t)
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  }
  const ahead = sorted[sorted.length - 1].effective_from > today
  const current = points[points.length - 1]

  return (
    <div
      className="h-60"
      role="img"
      aria-label={`Pay rate over time, ${points.length - 1} rate/s, now ${money(current.rate)} ${unit}. The table below lists every change.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 20, right: 24, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[first, end]}
            tickFormatter={xTick}
            tick={{ fontSize: 11, fill: MUTED }}
            axisLine={{ stroke: BASELINE }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={[yLo, yHi]}
            ticks={yTicks}
            tickFormatter={yTick}
            tick={{ fontSize: 11, fill: MUTED }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          {ahead && (
            <ReferenceLine
              x={Date.parse(today)}
              stroke={MUTED}
              strokeWidth={1}
              label={{ value: 'Today', position: 'insideTopLeft', fontSize: 11, fill: MUTED }}
            />
          )}
          {floor > 0 && (
            <ReferenceLine
              y={floor}
              stroke={MUTED}
              strokeWidth={1}
              label={{ value: `Client minimum wage ${money(floor)}${monthly ? ' a month' : ''}`, position: 'insideBottomLeft', fontSize: 11, fill: MUTED }}
            />
          )}
          <Tooltip
            cursor={{ stroke: MUTED, strokeWidth: 1 }}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as RatePoint | undefined) : undefined
              if (!p) return null
              return (
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
                  <p className="mb-1 font-semibold text-slate-500">{p.change ? `From ${fmtDate(p.date)}` : `Since ${fmtDate(p.date)}`}</p>
                  <p className="flex items-center gap-2">
                    <span className="inline-block h-0.5 w-3 rounded-full" style={{ background: SERIES }} aria-hidden />
                    <span className="font-bold text-ink-900">{money(p.rate)}</span>
                    <span className="text-slate-500">{unit}{mixed ? ' (monthly equivalent)' : ''} · {p.label}</span>
                  </p>
                </div>
              )
            }}
          />
          <Line
            type="stepAfter"
            dataKey="rate"
            stroke={SERIES}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; payload?: RatePoint }) =>
              props.payload?.change && props.cx !== undefined && props.cy !== undefined ? (
                <circle key={props.index} cx={props.cx} cy={props.cy} r={4} fill={SERIES} stroke="#ffffff" strokeWidth={2} />
              ) : (
                <g key={props.index} />
              )
            }
            activeDot={{ r: 5, fill: SERIES, stroke: '#ffffff', strokeWidth: 2 }}
            label={(props: { x?: number | string; y?: number | string; index?: number }) =>
              props.index === points.length - 1 && props.x !== undefined && props.y !== undefined ? (
                <text key="end" x={Number(props.x)} y={Number(props.y) - 10} textAnchor="end" fontSize={12} fontWeight={600} fill={INK}>
                  {money(current.rate)}
                </text>
              ) : (
                <g key={props.index} />
              )
            }
          />
        </LineChart>
      </ResponsiveContainer>
      {mixed && <p className="mt-1 text-xs text-slate-500">Daily rates are shown as monthly amounts (× {daysPerYear} days ÷ 12).</p>}
    </div>
  )
}

// ---------- the tab ----------

interface PaidSlip {
  period_month: string
  gross_pay: number
  run_type: string
  employee_snapshot: { pay_type?: string; monthly_rate?: number | string; daily_rate?: number | string } | null
  payroll_runs: { status: string; period_start: string; period_end: string } | null
}

export function PayHistoryTab({
  employee,
  entity,
  rates,
  onChanged,
}: {
  employee: Employee
  entity: Entity
  rates: EmployeePayRate[]
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [modal, setModal] = useState<{ editing: EmployeePayRate | null } | null>(null)
  const [slips, setSlips] = useState<PaidSlip[]>([])
  useEffect(() => {
    fetchAll<PaidSlip>((from, to) =>
      supabase
        .from('payslips')
        .select('period_month, gross_pay, run_type, employee_snapshot, payroll_runs!inner(status, period_start, period_end)')
        .eq('entity_id', employee.entity_id)
        .eq('employee_id', employee.id)
        .in('payroll_runs.status', ['finalized', 'paid'])
        .order('id')
        .range(from, to),
    ).then(setSlips, () => setSlips([]))
  }, [employee.id, employee.entity_id])

  const daysPerYear = Number(employee.days_per_year ?? entity.working_days_divisor)
  const changes = useMemo(() => rateChanges(rates, daysPerYear).reverse(), [rates, daysPerYear])
  const { current, upcoming } = currentAndUpcoming(rates)

  // finalized payrolls paid at a rate other than the history's for their period
  const offRate = slips.flatMap((p) => {
    const run = p.payroll_runs
    const snap = p.employee_snapshot
    if (!run || !snap?.pay_type || p.run_type === 'thirteenth_month') return []
    const r = rateOn(rates, run.period_end)
    if (!r) return []
    const paid = snap.pay_type === 'monthly' ? Number(snap.monthly_rate) : Number(snap.daily_rate)
    if (snap.pay_type === r.pay_type && Math.abs(paid - Number(r.rate)) < 0.005) return []
    return [{ key: `${run.period_start}${p.run_type}`, period: `${fmtDate(run.period_start)} – ${fmtDate(run.period_end)}`, paid: rateText({ pay_type: snap.pay_type as 'monthly' | 'daily', rate: paid }), now: rateText(r) }]
  })

  // gross pay of each payroll month (finalized payrolls), the last 12
  const grossChart = useMemo(() => {
    const byMonth = new Map<string, number>()
    for (const p of slips) byMonth.set(p.period_month, (byMonth.get(p.period_month) ?? 0) + Number(p.gross_pay))
    const months = [...byMonth.keys()].sort().slice(-12)
    return {
      title: 'Gross pay by payroll month',
      kind: 'columns' as const,
      categories: months.map((m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`),
      series: [{ key: 'gross', label: 'Gross pay', values: months.map((m) => Math.round((byMonth.get(m) ?? 0) * 100) / 100) }],
      unit: 'money' as const,
    }
  }, [slips])

  async function remove(r: EmployeePayRate) {
    if (!confirm(`Remove the rate from ${fmtDate(r.effective_from)} (${rateText(r)})?`)) return
    const { error } = await supabase.from('employee_pay_rates').delete().eq('id', r.id)
    if (error) {
      toast('error', errorMessage(error, 'Remove failed'))
      return
    }
    toast('success', 'Rate removed.')
    await onChanged()
  }

  return (
    <div className="space-y-6">
      <Card
        title="Pay rate"
        icon={<TrendingUp />}
        actions={
          <Button size="sm" onClick={() => setModal({ editing: null })}>
            <Plus className="size-4" /> Change pay rate
          </Button>
        }
      >
        <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {current && (
            <p>
              <span className="text-slate-500">Now </span>
              <span className="font-semibold text-ink-900">{rateText(current)}</span>
              <span className="text-slate-500"> since {fmtDate(current.effective_from)}</span>
            </p>
          )}
          {upcoming.map((u) => (
            <p key={u.id}>
              <span className="text-slate-500">From {fmtDate(u.effective_from)} </span>
              <span className="font-semibold text-ink-900">{rateText(u)}</span>
              <span className="text-slate-500"> · {PAY_RATE_REASON_LABELS[u.reason]}</span>
            </p>
          ))}
        </div>
        {rates.length > 0 ? (
          <RateChart rates={rates} daysPerYear={daysPerYear} minimumWageDaily={employee.is_minimum_wage_earner ? Number(entity.minimum_wage_daily) : 0} />
        ) : (
          <p className="text-sm text-slate-400">No rate recorded yet.</p>
        )}
      </Card>

      {offRate.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4" /> Finalized payrolls paid at another rate
          </p>
          <ul className="mt-2 space-y-1">
            {offRate.map((o) => (
              <li key={o.key}>
                {o.period}: paid at {o.paid}; the pay history now gives {o.now}.
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Void and reissue those payrolls, or pay the difference as a one-time earning (salary differential) in the next payroll.
          </p>
        </div>
      )}

      <Card title="Pay history">
        {changes.length === 0 ? (
          <p className="text-sm text-slate-400">No rate recorded yet.</p>
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-4 font-semibold">Effective</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Rate</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Change</th>
                  <th className="py-1.5 pr-4 font-semibold">Reason</th>
                  <th className="py-1.5 pr-4 font-semibold">Approved by</th>
                  <th className="py-1.5 pr-4 font-semibold">Recorded</th>
                  <th className="py-1.5 font-semibold"> </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {changes.map(({ row, previous, change, pct }) => (
                  <tr key={row.id} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-4 text-slate-700">{fmtDate(row.effective_from)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-ink-900">{rateText(row)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-600">
                      {changeText(change, pct)}
                      {previous && previous.pay_type !== row.pay_type ? ' a month' : ''}
                    </td>
                    <td className="py-2 pr-4 text-slate-700">
                      {PAY_RATE_REASON_LABELS[row.reason]}
                      {row.note && <p className="text-xs text-slate-500">{row.note}</p>}
                    </td>
                    <td className="py-2 pr-4 text-slate-600">{row.approved_by || '—'}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-xs text-slate-500">{fmtDateTime(row.created_at)}</td>
                    <td className="whitespace-nowrap py-2 text-right">
                      <IconButton label={`Edit the rate from ${fmtDate(row.effective_from)}`} onClick={() => setModal({ editing: row })}>
                        <Pencil className="size-4" />
                      </IconButton>
                      {rates.length > 1 && (
                        <IconButton label={`Remove the rate from ${fmtDate(row.effective_from)}`} onClick={() => remove(row)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {grossChart.categories.length > 0 && <InsightChart chart={grossChart} />}

      <PayRateModal
        open={modal !== null}
        onClose={() => setModal(null)}
        employee={employee}
        entity={entity}
        rates={rates}
        editing={modal?.editing ?? null}
        onSaved={onChanged}
      />
    </div>
  )
}
