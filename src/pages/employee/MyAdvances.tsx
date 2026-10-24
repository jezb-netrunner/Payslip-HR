import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, HandCoins, Hourglass, Plus, Wallet } from 'lucide-react'
import AdvanceLedgerList from '../../components/AdvanceLedgerList'
import { Badge, Button, Card, EmptyState, Field, Input, LoadFailed, Modal, PageHeader, Spinner, StatCard, StatGroup, Textarea } from '../../components/ui'
import { useToast } from '../../components/toast'
import {
  ADVANCE_STATUS_LABELS,
  ADVANCE_STATUS_TONES,
  advanceLedger,
  advanceStatus,
  installmentText,
  nextInstallment,
  payrollsToRepay,
  type LedgerSlip,
} from '../../lib/advances'
import { useAuth } from '../../lib/auth'
import type { AdvanceRepayment, AdvanceRequest, Payslip, RecurringDeduction } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, money, plural } from '../../lib/format'
import { manilaDateStr, todayManila } from '../../lib/manila'
import { useQuickAction } from '../../lib/quickAction'
import { supabase } from '../../lib/supabase'
import { round2 } from '../../payroll/types'

type Slip = Pick<Payslip, 'payroll_run_id' | 'deductions' | 'pay_date' | 'period_start' | 'period_end' | 'net_pay' | 'run_type'>

export default function MyAdvances() {
  const { employee } = useAuth()
  const toast = useToast()
  const [advances, setAdvances] = useState<RecurringDeduction[]>([])
  const [requests, setRequests] = useState<AdvanceRequest[]>([])
  const [slips, setSlips] = useState<Slip[]>([])
  const [repayments, setRepayments] = useState<AdvanceRepayment[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ amount: '', perPayroll: '', reason: '' })
  const today = todayManila()

  useQuickAction('request', () => setOpen(true), !loading)

  const load = useCallback(async () => {
    if (!employee) return
    setLoadError('')
    try {
      const [adv, req, ps, rp] = await Promise.all([
        supabase
          .from('recurring_deductions')
          .select('*')
          .eq('employee_id', employee.id)
          .eq('category', 'cash_advance')
          .order('released_on', { ascending: false }),
        supabase.from('advance_requests').select('*').eq('employee_id', employee.id).order('created_at', { ascending: false }).limit(50),
        // employees only ever read finalized payslips, so every deduction here is final
        fetchAll<Slip>((from, to) =>
          supabase
            .from('payslips')
            .select('payroll_run_id, deductions, pay_date, period_start, period_end, net_pay, run_type')
            .eq('employee_id', employee.id)
            .order('pay_date', { ascending: false })
            .order('id')
            .range(from, to),
        ),
        supabase.from('advance_repayments').select('*').eq('employee_id', employee.id).order('paid_on'),
      ])
      const failed = adv.error ?? req.error ?? rp.error
      if (failed) throw failed
      setAdvances((adv.data ?? []) as RecurringDeduction[])
      setRequests((req.data ?? []) as AdvanceRequest[])
      setSlips(ps)
      setRepayments((rp.data ?? []) as AdvanceRepayment[])
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load your cash advances"))
    } finally {
      setLoading(false)
    }
  }, [employee])

  useEffect(() => {
    load()
  }, [load])

  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!employee || loading) return <Spinner />

  const separated = !!employee.separation_date && employee.separation_date < today
  const outstanding = advances.filter((a) => Number(a.balance ?? 0) > 0)
  const owed = round2(outstanding.reduce((s, a) => s + Number(a.balance), 0))
  const next = nextInstallment(outstanding.filter((a) => !a.start_date || a.start_date <= today))
  const agreed = outstanding.some((a) => a.active && !(Number(a.amount_per_period) > 0))
  const pending = requests.filter((r) => r.status === 'pending')
  const ledgerSlips: LedgerSlip[] = slips.map((s) => ({ ...s, finalized: true }))
  const lastNet = slips.find((s) => s.run_type !== 'thirteenth_month')?.net_pay

  const amount = round2(Number(form.amount) || 0)
  const per = round2(Number(form.perPayroll) || 0)
  const problem =
    amount <= 0
      ? 'Enter the amount you need.'
      : per <= 0
        ? 'Enter how much to deduct per payroll.'
        : per > amount
          ? "The deduction per payroll can't be more than the advance."
          : ''

  async function submit() {
    if (!employee || problem) return
    setBusy(true)
    try {
      const { error } = await supabase.from('advance_requests').insert({
        employee_id: employee.id,
        entity_id: employee.entity_id,
        amount,
        per_payroll: per,
        reason: form.reason.trim(),
        status: 'pending',
      })
      if (error) throw error
      toast('success', "Request sent. HR's decision shows here once it is reviewed.")
      setOpen(false)
      setForm({ amount: '', perPayroll: '', reason: '' })
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not send the request'))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id: string) {
    const { data, error } = await supabase
      .from('advance_requests')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
    if (error) toast('error', errorMessage(error, 'Could not cancel the request'))
    else if (!data || data.length === 0) toast('error', 'This request was already reviewed — it can no longer be cancelled.')
    else toast('success', 'Request cancelled.')
    await load()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cash Advances"
        subtitle="Advances on your pay. They carry no interest and are repaid from your next payrolls — the installment you agreed on, or the amount agreed for each payroll — as shown on your payslips."
        actions={
          !separated && (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> Request an advance
            </Button>
          )
        }
      />

      <StatGroup>
        <StatCard label="You owe" value={money(owed)} sub={outstanding.length ? plural(outstanding.length, 'advance') : 'nothing owed'} icon={<Wallet />} />
        <StatCard label="Deducted per payroll" value={money(next)} sub={agreed ? '+ amounts agreed each payroll' : 'from your take-home pay'} icon={<HandCoins />} />
        <StatCard label="Requests waiting" value={pending.length} sub={pending.length ? 'HR is reviewing' : 'none'} icon={<Hourglass />} />
      </StatGroup>

      {advances.length === 0 ? (
        <Card>
          <EmptyState
            title="No cash advances"
            sub={separated ? undefined : 'Need part of your pay early? Request an advance; HR reviews it and you sign an authorization before it is released.'}
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {advances.map((a) => {
            const total = Number(a.total_amount)
            const balance = Number(a.balance)
            const status = advanceStatus(a, today)
            const paidShare = total > 0 ? Math.min(100, Math.max(0, ((total - balance) / total) * 100)) : 0
            const isOpen = expanded === a.id
            return (
              <Card key={a.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink-900">{money(total)} advance</p>
                    <p className="text-xs text-slate-500">
                      Released {fmtDate(a.released_on)} · {installmentText(Number(a.amount_per_period))}
                    </p>
                  </div>
                  <Badge tone={ADVANCE_STATUS_TONES[status]}>
                    {status === 'scheduled' ? `First deduction ${fmtDate(a.start_date)}` : ADVANCE_STATUS_LABELS[status]}
                  </Badge>
                </div>
                <div className="mt-3 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">Balance</p>
                    <p className="text-2xl font-bold tracking-tight text-ink-900">{money(balance)}</p>
                  </div>
                  <p className="text-right text-xs text-slate-500">{money(round2(total - balance))} repaid</p>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${Math.round(paidShare)}% repaid`}>
                  <div className="h-full rounded-full bg-leaf-500" style={{ width: `${paidShare}%` }} />
                </div>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : a.id)}
                  aria-expanded={isOpen}
                  className="mt-3 flex items-center gap-1 text-xs font-semibold text-brand-700"
                >
                  <ChevronDown className={`size-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} /> {isOpen ? 'Hide history' : 'Show history'}
                </button>
                {isOpen && (
                  <div className="mt-3">
                    <AdvanceLedgerList
                      entries={advanceLedger(a, ledgerSlips, repayments.filter((r) => r.advance_id === a.id)).entries}
                    />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      {requests.length > 0 && (
        <Card title="Your requests">
          <div className="divide-y divide-slate-100">
            {requests.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-900">
                    {money(Number(r.amount))} <span className="font-normal text-slate-500">· {money(Number(r.per_payroll))} per payroll</span>
                  </p>
                  <p className="break-words text-xs text-slate-500">
                    Filed {fmtDate(manilaDateStr(new Date(r.created_at)))}
                    {r.reason ? ` · “${r.reason}”` : ''}
                    {r.review_notes ? ` · HR: “${r.review_notes}”` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'amber' : 'slate'}>
                    {r.status}
                  </Badge>
                  {r.status === 'pending' && (
                    <Button variant="ghost" size="sm" onClick={() => cancel(r.id)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Request a cash advance">
        <div className="space-y-4">
          {owed > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">You still owe {money(owed)} on earlier advances.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount (PHP)">
              <Input type="number" inputMode="decimal" min={0} step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Deduct per payroll (PHP)">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={form.perPayroll}
                onChange={(e) => setForm({ ...form, perPayroll: e.target.value })}
              />
            </Field>
          </div>
          <div className="-mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            {amount > 0 && per > 0 && per <= amount ? <span>Repaid in about {plural(payrollsToRepay(amount, per), 'payroll')}.</span> : <span>Spread over:</span>}
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                disabled={amount <= 0}
                onClick={() => setForm({ ...form, perPayroll: String(Math.ceil(Math.round(amount * 100) / n) / 100) })}
                className="rounded-md border border-slate-200 px-2 py-1 font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                {plural(n, 'payroll')}
              </button>
            ))}
          </div>
          {lastNet !== undefined && (
            <p className="text-xs text-slate-500">
              Your last take-home pay was {money(Number(lastNet))}. A payroll never deducts more than your take-home pay; what it can't
              deduct stays in your balance for later payrolls.
            </p>
          )}
          <Field label="Reason (optional)">
            <Textarea rows={2} maxLength={500} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <p className="text-xs text-slate-500">
            HR reviews the request and may agree different terms with you. Before the money is released you sign an authorization
            to deduct it from your pay. There is no interest or fee.
          </p>
          <Button className="w-full" disabled={busy || !!problem} onClick={submit}>
            {busy ? 'Sending…' : 'Send request'}
          </Button>
          {problem && (form.amount || form.perPayroll) && <p className="text-center text-xs text-slate-500">{problem}</p>}
        </div>
      </Modal>
    </div>
  )
}
