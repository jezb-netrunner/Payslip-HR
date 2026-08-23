import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Wallet } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getSettings } from '../../lib/api'
import type { CompanySettings, PayrollRun } from '../../lib/db'
import { fmtDate, fmtPeriod, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

export default function Payroll() {
  const [runs, setRuns] = useState<PayrollRun[]>([])
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    const [{ data }, s] = await Promise.all([
      supabase.from('payroll_runs').select('*').order('period_start', { ascending: false }),
      getSettings(),
    ])
    setRuns((data ?? []) as PayrollRun[])
    setSettings(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <PageHeader
        title="Payroll"
        subtitle="Draft → review → finalize. Finalized payslips are immutable and visible to employees."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New payroll run
          </Button>
        }
      />
      {loading ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <Card>
          <EmptyState title="No payroll runs yet" sub="Create your first run to compute payslips." />
        </Card>
      ) : (
        <div className="grid gap-3">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/admin/payroll/${r.id}`)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50">
                  <Wallet className="size-5 text-brand-600" />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {r.run_type === 'thirteenth_month'
                      ? `13th Month Pay ${r.period_end.slice(0, 4)}`
                      : fmtPeriod(r.period_start, r.period_end)}
                    {r.run_type === 'special' && ' (special)'}
                    {r.run_type === 'final_pay' && ' (final pay)'}
                  </p>
                  <p className="text-xs text-slate-500">
                    Pay date {fmtDate(r.pay_date)} · {r.totals?.employees ?? 0} employee/s
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs text-slate-400">Net total</p>
                  <p className="text-base font-extrabold text-brand-900">{money(r.totals?.net ?? 0)}</p>
                </div>
                <Badge tone={r.status === 'draft' ? 'amber' : r.status === 'finalized' ? 'green' : 'blue'}>
                  {r.status}
                </Badge>
              </div>
            </button>
          ))}
        </div>
      )}

      {settings && (
        <NewRunModal
          open={creating}
          settings={settings}
          lastRun={runs[0] ?? null}
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/admin/payroll/${id}`)}
        />
      )}
    </div>
  )
}

function suggestNextPeriod(
  settings: CompanySettings,
  lastRun: PayrollRun | null,
): { start: string; end: string; pay: string } {
  const today = todayManila()
  const [y, m] = today.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()

  function fromParts(yy: number, mm: number, dd: number): string {
    return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dd, new Date(Date.UTC(yy, mm, 0)).getUTCDate())).padStart(2, '0')}`
  }

  if (lastRun && lastRun.run_type === 'regular') {
    // continue from the last period
    const [ly, lm, ld] = lastRun.period_end.split('-').map(Number)
    if (settings.pay_frequency === 'monthly') {
      const ny = lm === 12 ? ly + 1 : ly
      const nm = lm === 12 ? 1 : lm + 1
      return { start: fromParts(ny, nm, 1), end: fromParts(ny, nm, 31), pay: fromParts(ny, nm, 31) }
    }
    if (ld <= 15) {
      return { start: fromParts(ly, lm, 16), end: fromParts(ly, lm, 31), pay: fromParts(ly, lm, 31) }
    }
    const ny = lm === 12 ? ly + 1 : ly
    const nm = lm === 12 ? 1 : lm + 1
    return { start: fromParts(ny, nm, 1), end: fromParts(ny, nm, 15), pay: fromParts(ny, nm, 20) }
  }

  if (settings.pay_frequency === 'monthly') {
    return { start: fromParts(y, m, 1), end: fromParts(y, m, lastDay), pay: fromParts(y, m, lastDay) }
  }
  const day = Number(today.slice(8, 10))
  if (day <= 15) return { start: fromParts(y, m, 1), end: fromParts(y, m, 15), pay: fromParts(y, m, 20) }
  return { start: fromParts(y, m, 16), end: fromParts(y, m, lastDay), pay: fromParts(y, m, lastDay) }
}

function NewRunModal({
  open,
  settings,
  lastRun,
  onClose,
  onCreated,
}: {
  open: boolean
  settings: CompanySettings
  lastRun: PayrollRun | null
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const toast = useToast()
  const suggestion = suggestNextPeriod(settings, lastRun)
  const [f, setF] = useState({
    run_type: 'regular',
    start: suggestion.start,
    end: suggestion.end,
    pay: suggestion.pay,
  })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      const s = suggestNextPeriod(settings, lastRun)
      setF((prev) => ({ ...prev, start: s.start, end: s.end, pay: s.pay }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (f.run_type === 'thirteenth_month') {
      const y = todayManila().slice(0, 4)
      setF((prev) => ({ ...prev, start: `${y}-01-01`, end: `${y}-12-31`, pay: `${y}-12-24` }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.run_type])

  async function create() {
    setBusy(true)
    try {
      const { data, error } = await supabase
        .from('payroll_runs')
        .insert({
          run_type: f.run_type,
          period_start: f.start,
          period_end: f.end,
          pay_date: f.pay,
          status: 'draft',
        })
        .select('id')
        .single()
      if (error) throw error
      toast('success', 'Run created — now compute the draft payslips.')
      onCreated(data.id)
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to create run')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New payroll run">
      <div className="space-y-4">
        <Field label="Run type">
          <Select value={f.run_type} onChange={(e) => setF({ ...f, run_type: e.target.value })}>
            <option value="regular">Regular ({settings.pay_frequency.replace('_', '-')})</option>
            <option value="thirteenth_month">13th Month Pay</option>
            <option value="special">Special run</option>
            <option value="final_pay">Final pay</option>
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Period start">
            <Input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          </Field>
          <Field label="Period end">
            <Input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          </Field>
          <Field label="Pay date">
            <Input type="date" value={f.pay} onChange={(e) => setF({ ...f, pay: e.target.value })} />
          </Field>
        </div>
        {f.run_type === 'thirteenth_month' && (
          <p className="rounded-lg bg-accent-50 px-3 py-2 text-xs text-accent-800">
            13th month = 1/12 of each employee's basic salary earned within the calendar year
            (from finalized regular runs). Due not later than December 24 (PD 851).
          </p>
        )}
        {(f.run_type === 'special' || f.run_type === 'final_pay') && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Special and final-pay runs compute the chosen period exactly like a regular run
            (attendance, contributions, tax). Use them for off-cycle corrections or a separated
            employee's last period — don't overlap a period that a finalized regular run already
            paid, or basic pay and contributions will be charged twice. Final-pay extras (SIL
            conversion, prorated 13th month) can be added as allowances beforehand.
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create draft run'}
        </Button>
      </div>
    </Modal>
  )
}
