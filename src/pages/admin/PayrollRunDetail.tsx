import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Calculator, Download, Eye, Lock, Unlock } from 'lucide-react'
import PayslipView from '../../components/PayslipView'
import { Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner, StatCard, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv, getSettings } from '../../lib/api'
import type { CompanySettings, Payslip, PayrollRun } from '../../lib/db'
import { fmtDate, fmtPeriod, money } from '../../lib/format'
import { computeRun, finalizeRun, reopenRun, type RunComputationResult } from '../../payroll/service'
import { supabase } from '../../lib/supabase'

export default function PayrollRunDetail() {
  const { id } = useParams()
  const toast = useToast()
  const [run, setRun] = useState<PayrollRun | null>(null)
  const [slips, setSlips] = useState<Payslip[]>([])
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunComputationResult | null>(null)
  const [viewing, setViewing] = useState<Payslip | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    const [{ data: r }, { data: s }, cs] = await Promise.all([
      supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle(),
      supabase.from('payslips').select('*').eq('payroll_run_id', id).order('created_at'),
      getSettings(),
    ])
    setRun((r as PayrollRun) ?? null)
    setSlips((s ?? []) as Payslip[])
    setSettings(cs)
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function compute() {
    if (!run) return
    setComputing(true)
    setResult(null)
    try {
      const res = await computeRun(run)
      setResult(res)
      toast('success', `Computed payslips for ${res.computed} employee/s.`)
      await load()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Computation failed')
    } finally {
      setComputing(false)
    }
  }

  async function doFinalize() {
    if (!run) return
    if (slips.length === 0) {
      toast('error', 'Compute the draft first.')
      return
    }
    if (!confirm('Finalize this payroll run? Payslips become immutable and visible to employees.')) return
    setBusy(true)
    try {
      await finalizeRun(run)
      toast('success', 'Run finalized. Employees can now view their payslips.')
      await load()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Finalize failed')
    } finally {
      setBusy(false)
    }
  }

  async function doReopen() {
    if (!run) return
    if (!confirm('Reopen this run as a draft? This is audit-logged. Recompute and re-finalize after your changes.')) return
    setBusy(true)
    try {
      await reopenRun(run.id)
      toast('success', 'Run reopened as draft.')
      await load()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Reopen failed')
    } finally {
      setBusy(false)
    }
  }

  function exportRegister() {
    if (!run) return
    const header = [
      'Employee No', 'Employee', 'Position', 'Days', 'OT Hrs', 'Gross', 'SSS EE', 'SSS MPF EE',
      'PhilHealth EE', 'Pag-IBIG EE', 'W/Tax', 'Other Ded', 'Total Ded', 'Net Pay',
      'SSS ER', 'SSS MPF ER', 'EC ER', 'PhilHealth ER', 'Pag-IBIG ER',
    ]
    const rows = slips.map((s) => {
      const snap = s.employee_snapshot as Record<string, string>
      return [
        snap.employee_no ?? '', snap.name ?? '', snap.position ?? '',
        s.days_worked, s.overtime_hours, s.gross_pay, s.sss_ee, s.sss_mpf_ee,
        s.philhealth_ee, s.pagibig_ee, s.withholding_tax, s.other_deductions_total,
        s.total_deductions, s.net_pay, s.sss_er, s.sss_mpf_er, s.sss_ec_er,
        s.philhealth_er, s.pagibig_er,
      ]
    })
    downloadCsv(`payroll_register_${run.period_end}.csv`, [header, ...rows])
  }

  if (loading) return <Spinner />
  if (!run) return <p className="text-sm text-slate-500">Run not found.</p>

  const t = run.totals ?? {}
  const warnings = slips.flatMap((s) =>
    (s.computation_trace?.warnings ?? []).map((w) => ({
      name: (s.employee_snapshot as Record<string, string>).name ?? '',
      warning: w,
    })),
  )

  return (
    <div>
      <Link to="/admin/payroll" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
        <ArrowLeft className="size-3.5" /> All runs
      </Link>
      <PageHeader
        title={
          run.run_type === 'thirteenth_month'
            ? `13th Month Pay ${run.period_end.slice(0, 4)}`
            : `Payroll ${fmtPeriod(run.period_start, run.period_end)}`
        }
        subtitle={
          <>
            Pay date {fmtDate(run.pay_date)} ·{' '}
            <Badge tone={run.status === 'draft' ? 'amber' : 'green'}>{run.status}</Badge>
          </>
        }
        actions={
          <>
            {run.status === 'draft' ? (
              <>
                <Button onClick={compute} disabled={computing}>
                  <Calculator className="size-4" />
                  {computing ? 'Computing…' : slips.length ? 'Recompute draft' : 'Compute draft'}
                </Button>
                <Button variant="accent" onClick={doFinalize} disabled={busy || slips.length === 0}>
                  <Lock className="size-4" /> Finalize
                </Button>
              </>
            ) : (
              <Button variant="secondary" onClick={doReopen} disabled={busy}>
                <Unlock className="size-4" /> Reopen as draft
              </Button>
            )}
            <Button variant="secondary" onClick={exportRegister} disabled={slips.length === 0}>
              <Download className="size-4" /> Register CSV
            </Button>
          </>
        }
      />

      {warnings.length > 0 && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-amber-800">
            <AlertTriangle className="size-4" /> Review warnings
          </p>
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700">• {w.name}: {w.warning}</p>
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Employees" value={t.employees ?? slips.length} />
        <StatCard label="Gross payroll" value={money(t.gross ?? 0)} />
        <StatCard label="Net payout" value={money(t.net ?? 0)} tone="accent" />
        <StatCard
          label="Total employer cost"
          value={money(t.employer_cost ?? 0)}
          sub="Gross + employer SSS/EC/MPF, PhilHealth, Pag-IBIG"
        />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Withholding tax" value={money(t.withholding_tax ?? 0)} sub="Remit via BIR 1601-C" />
        <StatCard label="SSS (EE+ER)" value={money((t.sss_ee ?? 0) + (t.sss_er ?? 0))} sub="Due last day of following month" />
        <StatCard label="PhilHealth (EE+ER)" value={money((t.philhealth_ee ?? 0) + (t.philhealth_er ?? 0))} sub="Due in the following month" />
        <StatCard label="Pag-IBIG (EE+ER)" value={money((t.pagibig_ee ?? 0) + (t.pagibig_er ?? 0))} sub="Due 10th–15th of following month" />
      </div>

      {result && result.warnings.length > 0 && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          {result.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700">• {w.employee}: {w.warnings.join('; ')}</p>
          ))}
        </div>
      )}

      <Card title={`Payslips (${slips.length})`}>
        {slips.length === 0 ? (
          <EmptyState
            title="No payslips yet"
            sub='Click "Compute draft" to generate payslips from attendance, rates and the statutory tables.'
          />
        ) : (
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Days</Th>
                <Th className="text-right">Gross</Th>
                <Th className="text-right">Statutory EE</Th>
                <Th className="text-right">W/Tax</Th>
                <Th className="text-right">Net Pay</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {slips.map((s) => {
                const snap = s.employee_snapshot as Record<string, string>
                const statEe =
                  Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee)
                return (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <Td>
                      <p className="font-semibold">{snap.name}</p>
                      <p className="text-xs text-slate-400">{snap.employee_no} · {snap.position || '—'}</p>
                    </Td>
                    <Td className="text-right">{Number(s.days_worked)}</Td>
                    <Td className="text-right">{money(Number(s.gross_pay))}</Td>
                    <Td className="text-right">{money(statEe)}</Td>
                    <Td className="text-right">{money(Number(s.withholding_tax))}</Td>
                    <Td className="text-right font-bold text-brand-900">{money(Number(s.net_pay))}</Td>
                    <Td>
                      <button
                        onClick={() => setViewing(s)}
                        className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
                      >
                        <Eye className="size-3.5" /> View
                      </button>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title="Payslip" wide>
        {viewing && settings && <PayslipView slip={viewing} run={run} company={settings} showTrace />}
      </Modal>
    </div>
  )
}
