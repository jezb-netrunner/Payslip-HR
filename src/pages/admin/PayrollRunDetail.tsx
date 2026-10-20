import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Banknote, Calculator, Download, Eye, Lock, Plus, Trash2, Unlock } from 'lucide-react'
import PayslipView, { runLabel } from '../../components/PayslipView'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, StatCard, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv, getEmployees } from '../../lib/api'
import { denominationBreakdown, PESO_DENOMINATIONS, sumBreakdowns } from '../../lib/cash'
import type { Employee, Payslip, PayrollAdjustment, PayrollRun } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate, fmtMonth, fullName, money } from '../../lib/format'
import { BIR_BUCKET_LABELS, FREQUENCY_LABELS, PAYMENT_METHOD_LABELS } from '../../lib/labels'
import { computeRun, employeesForRun, finalizeRun, reopenRun, type RunComputationResult } from '../../payroll/service'
import { supabase } from '../../lib/supabase'

const EARNING_CATEGORIES = [
  'basic', 'overtime', 'holiday', 'night_diff', 'hazard', 'other_benefits', 'de_minimis',
  'representation', 'transportation', 'cola', 'housing', 'other_taxable', 'other_non_taxable',
] as const

export default function PayrollRunDetail() {
  const { id } = useParams()
  const toast = useToast()
  const navigate = useNavigate()
  const { entities } = useEntity()
  const [run, setRun] = useState<PayrollRun | null>(null)
  const [slips, setSlips] = useState<Payslip[]>([])
  const [adjustments, setAdjustments] = useState<PayrollAdjustment[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunComputationResult | null>(null)
  const [viewing, setViewing] = useState<Payslip | null>(null)
  const [addingAdj, setAddingAdj] = useState(false)
  const [showCash, setShowCash] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    const [{ data: r }, { data: s }, { data: a }] = await Promise.all([
      supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle(),
      supabase.from('payslips').select('*').eq('payroll_run_id', id).order('created_at'),
      supabase.from('payroll_adjustments').select('*').eq('payroll_run_id', id).order('created_at'),
    ])
    const runRow = (r as PayrollRun) ?? null
    setRun(runRow)
    setSlips(((s ?? []) as Payslip[]).sort((x, y) =>
      String((x.employee_snapshot as Record<string, string>).name).localeCompare(String((y.employee_snapshot as Record<string, string>).name)),
    ))
    setAdjustments((a ?? []) as PayrollAdjustment[])
    if (runRow) setEmployees(await getEmployees(runRow.entity_id))
    setLoading(false)
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const entity = entities.find((e) => e.id === run?.entity_id) ?? null
  const covered = useMemo(() => (run ? employeesForRun(run, employees) : []), [run, employees])

  if (loading) return <Spinner />
  if (!run || !entity) return <p className="text-sm text-slate-500">Run not found.</p>

  async function compute() {
    if (!run || !entity) return
    setComputing(true)
    setResult(null)
    try {
      const res = await computeRun(run, entity)
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
    if (slips.length === 0) return toast('error', 'Compute the draft first.')
    if (!confirm('Finalize this payroll run? Payslips become immutable and visible to employees, and attendance in the period locks.')) return
    setBusy(true)
    try {
      await finalizeRun(run)
      toast('success', 'Run finalized. Employees can now see their payslips.')
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

  async function deleteDraft() {
    if (!run || !confirm('Delete this draft run and its draft payslips?')) return
    const { error } = await supabase.from('payroll_runs').delete().eq('id', run.id)
    if (error) toast('error', error.message)
    else navigate('/admin/payroll')
  }

  async function removeAdjustment(adjId: string) {
    const { error } = await supabase.from('payroll_adjustments').delete().eq('id', adjId)
    if (error) toast('error', error.message)
    else await load()
  }

  function exportRegister() {
    if (!run) return
    const header = [
      'Employee No', 'Employee', 'Position', 'Paid by', 'Days', 'OT Hrs', 'Basic (earned)', 'Gross', 'SSS EE', 'SSS MPF EE',
      'PhilHealth EE', 'Pag-IBIG EE', 'W/Tax', 'Union dues', 'Other Ded', 'Total Ded', 'Rounding', 'Net Pay',
      'SSS ER', 'SSS MPF ER', 'EC ER', 'PhilHealth ER', 'Pag-IBIG ER',
    ]
    const rows = slips.map((s) => {
      const snap = s.employee_snapshot as Record<string, string>
      return [
        snap.employee_no ?? '', snap.name ?? '', snap.position ?? '',
        s.payment_method ? PAYMENT_METHOD_LABELS[s.payment_method] : '',
        s.days_worked, s.overtime_hours, s.basic_pay, s.gross_pay, s.sss_ee, s.sss_mpf_ee,
        s.philhealth_ee, s.pagibig_ee, s.withholding_tax, s.union_dues, s.other_deductions_total,
        s.total_deductions, s.rounding_adjustment, s.net_pay, s.sss_er, s.sss_mpf_er, s.sss_ec_er,
        s.philhealth_er, s.pagibig_er,
      ]
    })
    downloadCsv(`payroll_register_${entity?.code}_${run.period_end}.csv`, [header, ...rows])
  }

  const cashSlips = slips.filter((s) => s.payment_method === 'cash')
  const cashRows = cashSlips.map((s) => ({ slip: s, b: denominationBreakdown(Number(s.net_pay)) }))
  const cashTotal = sumBreakdowns(cashRows.map((r) => r.b))

  function exportCash() {
    if (!run) return
    const header = ['Employee No', 'Employee', 'Net Pay', ...PESO_DENOMINATIONS.map((d) => `₱${d}`), 'Centavos']
    const rows = cashRows.map(({ slip, b }) => {
      const snap = slip.employee_snapshot as Record<string, string>
      return [snap.employee_no ?? '', snap.name ?? '', slip.net_pay, ...PESO_DENOMINATIONS.map((d) => b.counts[d]), b.centavos]
    })
    rows.push(['', 'TOTAL', cashRows.reduce((s, r) => s + Number(r.slip.net_pay), 0), ...PESO_DENOMINATIONS.map((d) => cashTotal.counts[d]), cashTotal.centavos])
    downloadCsv(`cash_payout_${entity?.code}_${run.pay_date}.csv`, [header, ...rows])
  }

  const t = run.totals ?? {}
  const warnings = slips.flatMap((s) =>
    (s.computation_trace?.warnings ?? []).map((w) => ({
      name: (s.employee_snapshot as Record<string, string>).name ?? '',
      warning: w,
    })),
  )
  const isDraft = run.status === 'draft'
  const empName = (eid: string) => {
    const e = employees.find((x) => x.id === eid)
    return e ? fullName(e) : '—'
  }

  return (
    <div>
      <Link to="/admin/payroll" className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
        <ArrowLeft className="size-3.5" /> All runs
      </Link>
      <PageHeader
        title={`Payroll ${runLabel(run)}`}
        subtitle={
          <>
            {entity.name} · Pay date {fmtDate(run.pay_date)} · {fmtMonth(run.period_month)}
            {run.pay_frequency && ` · ${FREQUENCY_LABELS[run.pay_frequency]} payroll ${run.period_index} of ${run.periods_in_month}`}{' '}
            <Badge tone={isDraft ? 'amber' : 'green'}>{run.status}</Badge>{' '}
            {run.annualize && <Badge tone="violet">annualized withholding</Badge>}
          </>
        }
        actions={
          <>
            {isDraft ? (
              <>
                <Button onClick={compute} disabled={computing}>
                  <Calculator className="size-4" />
                  {computing ? 'Computing…' : slips.length ? 'Recompute draft' : 'Compute draft'}
                </Button>
                <Button variant="accent" onClick={doFinalize} disabled={busy || slips.length === 0}>
                  <Lock className="size-4" /> Finalize
                </Button>
                <Button variant="ghost" onClick={deleteDraft} title="Delete draft run">
                  <Trash2 className="size-4" />
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

      {(warnings.length > 0 || (result?.warnings.some((w) => w.employee === 'This run') ?? false)) && (
        <div className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-amber-800">
            <AlertTriangle className="size-4" /> Review warnings
          </p>
          {result?.warnings.filter((w) => w.employee === 'This run').map((w, i) => (
            <p key={`r${i}`} className="text-xs text-amber-700">• {w.warnings.join('; ')}</p>
          ))}
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-700">• {w.name}: {w.warning}</p>
          ))}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Employees" value={t.employees ?? slips.length} sub={isDraft ? `${covered.length} covered by this run` : undefined} />
        <StatCard label="Gross payroll" value={money(t.gross ?? 0)} />
        <StatCard label="Net payout" value={money(t.net ?? 0)} tone="accent" sub={t.cash_employees ? `${money(t.cash_net)} in cash to ${t.cash_employees}` : undefined} />
        <StatCard label="Total employer cost" value={money(t.employer_cost ?? 0)} sub="Gross + employer SSS/EC/MPF, PhilHealth, Pag-IBIG + rounding" />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Withholding tax" value={money(t.withholding_tax ?? 0)} sub="Remit via BIR 1601-C" />
        <StatCard label="SSS (EE+ER)" value={money((t.sss_ee ?? 0) + (t.sss_er ?? 0))} />
        <StatCard label="PhilHealth (EE+ER)" value={money((t.philhealth_ee ?? 0) + (t.philhealth_er ?? 0))} />
        <StatCard label="Pag-IBIG (EE+ER)" value={money((t.pagibig_ee ?? 0) + (t.pagibig_er ?? 0))} />
      </div>

      {(isDraft || adjustments.length > 0) && run.run_type !== 'thirteenth_month' && (
        <Card
          className="mb-6"
          title={`One-time adjustments (${adjustments.length})`}
          actions={
            isDraft && (
              <Button variant="secondary" onClick={() => setAddingAdj(true)}>
                <Plus className="size-4" /> Add adjustment
              </Button>
            )
          }
        >
          {adjustments.length === 0 ? (
            <p className="text-sm text-slate-400">
              Bonuses, corrections of earlier payrolls, final-pay extras or one-off deductions for this run only.
              Recompute after changes.
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {adjustments.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div>
                    <span className="font-semibold text-slate-700">{empName(a.employee_id)}</span>
                    <span className="text-slate-500"> · {a.label}</span>{' '}
                    <Badge tone={a.kind === 'earning' ? 'green' : 'red'}>{a.kind}</Badge>{' '}
                    <span className="text-xs text-slate-400">
                      {a.kind === 'earning' ? BIR_BUCKET_LABELS[a.category as keyof typeof BIR_BUCKET_LABELS] : a.category.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-semibold ${a.kind === 'earning' ? 'text-slate-800' : 'text-rose-600'}`}>
                      {a.kind === 'deduction' ? '−' : ''}{money(Number(a.amount))}
                    </span>
                    {isDraft && (
                      <button onClick={() => removeAdjustment(a.id)} className="text-slate-300 hover:text-rose-500">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card
        title={`Payslips (${slips.length})`}
        actions={
          cashSlips.length > 0 && (
            <Button variant="secondary" onClick={() => setShowCash(true)}>
              <Banknote className="size-4" /> Cash payout ({cashSlips.length})
            </Button>
          )
        }
      >
        {slips.length === 0 ? (
          <EmptyState
            title="No payslips yet"
            sub='Click "Compute draft" to generate payslips from time in/out, rates and the statutory tables.'
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
                const statEe = Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee)
                return (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <Td>
                      <p className="font-semibold">{snap.name}</p>
                      <p className="text-xs text-slate-400">
                        {snap.employee_no} · {s.payment_method ? PAYMENT_METHOD_LABELS[s.payment_method] : '—'}
                        {s.is_minimum_wage_earner && ' · MWE'}
                      </p>
                    </Td>
                    <Td className="text-right">{Number(s.days_worked)}</Td>
                    <Td className="text-right">{money(Number(s.gross_pay))}</Td>
                    <Td className="text-right">{money(statEe)}</Td>
                    <Td className="text-right">{money(Number(s.withholding_tax))}</Td>
                    <Td className="text-right font-bold text-brand-900">
                      {money(Number(s.net_pay))}
                      {Number(s.rounding_adjustment) !== 0 && (
                        <p className="text-[10px] font-normal text-slate-400">
                          rounding {Number(s.rounding_adjustment) > 0 ? '+' : ''}{money(Number(s.rounding_adjustment))}
                        </p>
                      )}
                    </Td>
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
        {viewing && <PayslipView slip={viewing} run={run} company={entity} showTrace />}
      </Modal>

      <Modal open={showCash} onClose={() => setShowCash(false)} title="Cash payout — bills and coins per envelope" wide>
        <div className="space-y-4">
          {cashTotal.centavos > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Some cash net pays have centavos. Turn on whole-peso rounding in Client Settings, then recompute.
            </p>
          )}
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Net</Th>
                {PESO_DENOMINATIONS.map((d) => (
                  <Th key={d} className="text-right">₱{d}</Th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cashRows.map(({ slip, b }) => (
                <tr key={slip.id}>
                  <Td className="text-xs font-semibold">{(slip.employee_snapshot as Record<string, string>).name}</Td>
                  <Td className="text-right text-xs">{money(Number(slip.net_pay))}</Td>
                  {PESO_DENOMINATIONS.map((d) => (
                    <Td key={d} className="text-right text-xs">{b.counts[d] || ''}</Td>
                  ))}
                </tr>
              ))}
              <tr className="bg-slate-50 font-bold">
                <Td className="text-xs">TOTAL</Td>
                <Td className="text-right text-xs">{money(cashRows.reduce((s, r) => s + Number(r.slip.net_pay), 0))}</Td>
                {PESO_DENOMINATIONS.map((d) => (
                  <Td key={d} className="text-right text-xs">{cashTotal.counts[d]}</Td>
                ))}
              </tr>
            </tbody>
          </TableShell>
          <Button variant="secondary" onClick={exportCash}>
            <Download className="size-4" /> Download CSV
          </Button>
        </div>
      </Modal>

      {addingAdj && (
        <AdjustmentModal
          runId={run.id}
          employees={covered}
          onClose={() => setAddingAdj(false)}
          onSaved={async () => {
            setAddingAdj(false)
            await load()
          }}
        />
      )}
    </div>
  )
}

function AdjustmentModal({
  runId,
  employees,
  onClose,
  onSaved,
}: {
  runId: string
  employees: Employee[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({ employee_id: employees[0]?.id ?? '', kind: 'earning', label: '', amount: '', category: 'other_taxable' })
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!f.employee_id || !f.label.trim() || !(Number(f.amount) > 0)) {
      toast('error', 'Employee, label and a positive amount are required.')
      return
    }
    setBusy(true)
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase.from('payroll_adjustments').insert({
      payroll_run_id: runId,
      employee_id: f.employee_id,
      kind: f.kind,
      label: f.label.trim(),
      amount: Number(f.amount),
      category: f.kind === 'earning' ? f.category : f.category === 'union_dues' ? 'union_dues' : 'other',
      created_by: userData.user?.id ?? null,
    })
    setBusy(false)
    if (error) toast('error', error.message)
    else await onSaved()
  }

  return (
    <Modal open onClose={onClose} title="Add one-time adjustment">
      <div className="space-y-4">
        <Field label="Employee">
          <Select value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{fullName(e)} ({e.employee_no})</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value, category: e.target.value === 'earning' ? 'other_taxable' : 'other' })}
            >
              <option value="earning">Earning (added)</option>
              <option value="deduction">Deduction (subtracted)</option>
            </Select>
          </Field>
          <Field label="Amount (PHP)">
            <Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          </Field>
        </div>
        <Field label="Label (shown on the payslip)">
          <Input value={f.label} placeholder="e.g. Unpaid OT on Oct 3" onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>
        <Field label={f.kind === 'earning' ? 'BIR classification' : 'Deduction kind'}>
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {f.kind === 'earning' ? (
              EARNING_CATEGORIES.map((c) => (
                <option key={c} value={c}>{BIR_BUCKET_LABELS[c]}</option>
              ))
            ) : (
              <>
                <option value="other">Other deduction</option>
                <option value="union_dues">Union dues (tax-exempt)</option>
              </>
            )}
          </Select>
        </Field>
        {f.kind === 'earning' && (
          <p className="text-xs text-slate-400">
            Basic-pay corrections count toward the 13th month; bonuses share the ₱90,000 cap; the statutory
            minimum wage package stays exempt for minimum wage earners.
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add adjustment'}</Button>
      </div>
    </Modal>
  )
}
