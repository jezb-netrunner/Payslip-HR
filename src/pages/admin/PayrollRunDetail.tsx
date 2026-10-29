import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Banknote,
  Calculator,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileDown,
  Lock,
  PieChart,
  Plus,
  Scale,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react'
import PayslipView, { runLabel, type PayslipCompany, type PayslipRunInfo } from '../../components/PayslipView'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Donut,
  EmptyState,
  Field,
  IconButton,
  Input,
  LoadFailed,
  Modal,
  Select,
  Spinner,
  StatCard,
  StatGroup,
  TableShell,
  Td,
  Textarea,
  Th,
  Toggle,
} from '../../components/ui'
import { fetchAll } from '../../lib/fetchAll'
import { useToast } from '../../components/toast'
import { downloadBlob, downloadCsv, getEmployees } from '../../lib/api'
import { buildPayslipsDoc, buildPayslipsZip, type PayslipPdfOptions } from '../../pdf/payslipPdf'
import { denominationBreakdown, PESO_DENOMINATIONS, sumBreakdowns } from '../../lib/cash'
import type { Employee, Payslip, PayrollAdjustment, PayrollRun, PayrollVoid } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { useRecordClient } from '../../lib/recordClient'
import { fmtDate, fmtDateTime, fmtMonth, fmtPeriod, fullName, money, plural } from '../../lib/format'
import { BIR_BUCKET_LABELS, FREQUENCY_LABELS, MATERNITY_BENEFIT_LABELS, PAYMENT_METHOD_LABELS, LIQUIDATABLE_CATEGORIES, PAY_ITEM_TYPE_LABELS, SUPPLEMENTARY_ITEM_TYPES } from '../../lib/labels'
import { computeRun, employeesForRun, finalizeRun, voidRun, type RunComputationResult } from '../../payroll/service'
import { controlTotals } from '../../payroll/controlTotals'
import { useReportStamp } from '../../lib/useReportStamp'
import type { ReportStamp } from '../../lib/reportStamp'
import { logActivity } from '../../lib/activity'
import { RunDeductionsCard } from './RunDeductions'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { round2, type DeMinimisKind, type MaternityBenefit, type PayItemType } from '../../payroll/types'
import { ALLOWANCE_DE_MINIMIS, DE_MINIMIS_LABELS } from '../../lib/deMinimis'

// Categorical chart colours in fixed order (validated: lightness, chroma,
// colour-blind and normal-vision separation; yellow sits below 3:1, so every
// segment carries a printed value in its legend).
const SERIES = { green: '#3a8a5c', blue: '#1d6fb1', yellow: '#eda100', violet: '#6250d6', orange: '#d9661a' }

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
  const [loadError, setLoadError] = useState('')
  const [computing, setComputing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RunComputationResult | null>(null)
  const [viewing, setViewing] = useState<Payslip | null>(null)
  const [addingAdj, setAddingAdj] = useState<{ employeeId?: string; kind: 'earning' | 'deduction' } | null>(null)
  const [showCash, setShowCash] = useState(false)
  // payslips picked for a bulk download, by employee: survives a recompute (new payslip rows)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)
  // posted versions of this run voided earlier, newest first
  const [voids, setVoids] = useState<PayrollVoid[]>([])
  const [voiding, setVoiding] = useState(false)
  const [voidExport, setVoidExport] = useState<PayrollVoid | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setLoadError('')
    try {
      const [{ data: r, error: runErr }, s, a, v] = await Promise.all([
        supabase.from('payroll_runs').select('*').eq('id', id).maybeSingle(),
        // more than 1000 payslips arrive in pages: a cut-off list would block
        // finalize and truncate the register
        fetchAll<Payslip>((from, to) =>
          supabase.from('payslips').select('*').eq('payroll_run_id', id).order('created_at').order('id').range(from, to),
        ),
        fetchAll<PayrollAdjustment>((from, to) =>
          supabase.from('payroll_adjustments').select('*').eq('payroll_run_id', id).order('created_at').order('id').range(from, to),
        ),
        supabase.from('payroll_voids').select('*').eq('payroll_run_id', id).order('voided_at', { ascending: false }),
      ])
      if (runErr) throw runErr
      if (v.error) throw v.error
      setVoids((v.data ?? []) as PayrollVoid[])
      const runRow = (r as PayrollRun) ?? null
      setRun(runRow)
      setSlips(s.sort((x, y) =>
        String((x.employee_snapshot as Record<string, string>).name).localeCompare(String((y.employee_snapshot as Record<string, string>).name)),
      ))
      setAdjustments(a)
      if (runRow) setEmployees(await getEmployees(runRow.entity_id))
    } catch (err) {
      setLoadError(errorMessage(err, 'Could not load this payroll run'))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const entity = entities.find((e) => e.id === run?.entity_id) ?? null
  useRecordClient(run?.entity_id, '/admin/payroll')
  const covered = useMemo(() => (run ? employeesForRun(run, employees) : []), [run, employees])
  const stamp = useReportStamp(entity)
  const control = useMemo(() => controlTotals(slips, run?.totals), [slips, run?.totals])

  if (loading) return <Spinner />
  if (loadError) return <LoadFailed message={loadError} onRetry={load} />
  if (!run || !entity) return <p className="text-sm text-slate-500">Run not found.</p>

  async function compute() {
    if (!run || !entity) return
    setComputing(true)
    setResult(null)
    try {
      const res = await computeRun(run, entity)
      setResult(res)
      toast('success', `Computed payslips for ${plural(res.computed, 'employee')}.`)
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Computation failed'))
      await load() // show what is actually stored now, not the pre-compute payslips
    } finally {
      setComputing(false)
    }
  }

  async function doFinalize() {
    if (!run) return
    if (slips.length === 0) return toast('error', 'Compute the draft first.')
    if (
      !confirm(
        'Finalize this payroll run? It takes the next payroll control number and its payslips are numbered; they become immutable and visible to employees, and attendance in the period locks.',
      )
    )
      return
    setBusy(true)
    try {
      await finalizeRun(run)
      toast('success', 'Run finalized. Employees can now see their payslips.')
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Finalize failed'))
    } finally {
      setBusy(false)
    }
  }

  async function doVoid(reason: string) {
    if (!run) return
    setBusy(true)
    try {
      await voidRun(run.id, reason)
      setVoiding(false)
      toast('success', `${run.control_no ?? 'The payroll'} voided and kept on record. Correct the draft, recompute and finalize it to reissue it.`)
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not void the payroll'))
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

  function exportRegister(list: Payslip[] = slips, version: PayrollVoid | null = null) {
    if (!run) return
    const header = [
      'Payslip No', 'Employee No', 'Employee', 'Position', 'Paid by', 'Days', 'OT Hrs', 'Basic (earned)', 'Gross', 'SSS EE', 'SSS MPF EE',
      'PhilHealth EE', 'Pag-IBIG EE', 'W/Tax', 'Union dues', 'Cash Adv', 'Other Ded (incl. union dues, cash adv)', 'Total Ded',
      'Rounding', 'Net Pay',
      'SSS ER', 'SSS MPF ER', 'EC ER', 'PhilHealth ER', 'Pag-IBIG ER',
    ]
    const rows = list.map((s) => {
      const snap = s.employee_snapshot as Record<string, string>
      return [
        s.control_no ?? '', snap.employee_no ?? '', snap.name ?? '', snap.position ?? '',
        s.payment_method ? PAYMENT_METHOD_LABELS[s.payment_method] : '',
        s.days_worked, s.overtime_hours, s.basic_pay, s.gross_pay, s.sss_ee, s.sss_mpf_ee,
        s.philhealth_ee, s.pagibig_ee, s.withholding_tax, s.union_dues,
        round2((s.deductions ?? []).filter((l) => l.code === 'other:cash_advance').reduce((t, l) => t + Number(l.amount), 0)),
        s.other_deductions_total,
        s.total_deductions, s.rounding_adjustment, s.net_pay, s.sss_er, s.sss_mpf_er, s.sss_ec_er,
        s.philhealth_er, s.pagibig_er,
      ]
    })
    // the column totals: the register's control totals (Annex B item 10)
    const totalRow = header.map((_, i) =>
      i < 5 ? (i === 2 ? `TOTAL (${plural(rows.length, 'payslip')})` : '') : round2(rows.reduce((t, r) => t + Number(r[i] ?? 0), 0)),
    )
    const no = version ? `${version.run_control_no ?? '(unnumbered)'} VOID` : (run.control_no ?? '(draft)')
    downloadCsv(
      `payroll_register_${entity?.code}_${run.period_end}${version ? `_${version.run_control_no ?? 'unnumbered'}_VOID` : ''}.csv`,
      [header, ...rows, totalRow, ...(version ? [[], [`VOIDED ${fmtDateTime(version.voided_at)} by ${version.voided_by_email ?? 'unknown'}: ${version.reason}`]] : [])],
      stamp(`Payroll register ${no}, ${runLabel(run)}, pay date ${fmtDate(version?.run_snapshot.pay_date ?? run.pay_date)}`),
    )
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
    downloadCsv(
      `cash_payout_${entity?.code}_${run.pay_date}.csv`,
      [header, ...rows],
      stamp(`Cash payout ${run.control_no ?? '(draft)'}, ${runLabel(run)}, pay date ${fmtDate(run.pay_date)}`),
    )
  }

  const t = run.totals ?? {}
  const warnings = slips.flatMap((s) =>
    (s.computation_trace?.warnings ?? []).map((w) => ({
      name: (s.employee_snapshot as Record<string, string>).name ?? '',
      warning: w,
    })),
  )
  const isDraft = run.status === 'draft'
  // the database clears totals whenever attendance, adjustments, leave or
  // pay settings change after computing; finalize refuses such a draft
  const upToDate = typeof t.employees === 'number' && t.employees === slips.length && slips.length > 0
  const empName = (eid: string) => {
    const e = employees.find((x) => x.id === eid)
    return e ? fullName(e) : '—'
  }

  const computed = slips.length > 0
  const stale = isDraft && computed && !upToDate && !computing
  const extraEarnings = adjustments.filter((a) => a.kind === 'earning').reduce((sum, a) => sum + Number(a.amount), 0)
  const totalHours = slips.reduce((sum, x) => sum + Number(x.hours_worked), 0)
  const otHours = slips.reduce((sum, x) => sum + Number(x.overtime_hours), 0)
  const absentDays = slips.reduce((sum, x) => sum + Number(x.absent_days), 0)
  const regularHours = Math.max(0, totalHours - otHours)
  const eeContrib = (t.sss_ee ?? 0) + (t.philhealth_ee ?? 0) + (t.pagibig_ee ?? 0)
  const erContrib = (t.sss_er ?? 0) + (t.philhealth_er ?? 0) + (t.pagibig_er ?? 0)
  // employer cost = gross + employer shares + rounding = net + tax + employee shares + other deductions + employer shares
  const otherDeductions = Math.max(0, (t.gross ?? 0) + (t.rounding ?? 0) - (t.net ?? 0) - (t.withholding_tax ?? 0) - eeContrib)
  const spend = [
    { label: 'Net pay', value: t.net ?? 0, color: SERIES.green },
    // a year-end refund run withholds a negative amount: listed, not drawn
    { label: (t.withholding_tax ?? 0) < 0 ? 'Tax refunded (year-end)' : 'Withholding tax', value: t.withholding_tax ?? 0, color: SERIES.blue },
    { label: 'Employee contributions', value: eeContrib, color: SERIES.yellow },
    { label: 'Employer contributions', value: erContrib, color: SERIES.violet },
    { label: 'Other deductions', value: otherDeductions, color: SERIES.orange },
  ]
  const isThirteenth = run.run_type === 'thirteenth_month'
  const steps: Step[] = [
    { label: 'Compute', sub: isThirteenth ? 'From basic pay earned this year' : 'Hours & pay from time in/out', state: !isDraft || (computed && upToDate) ? 'done' : 'current' },
    { label: 'Review', sub: isThirteenth ? 'Warnings and payslips' : 'Warnings, adjustments, payslips', state: !isDraft ? 'done' : computed && upToDate ? 'current' : 'todo' },
    { label: 'Finalize', sub: 'Lock and publish payslips', state: !isDraft ? 'done' : 'todo' },
  ]
  const tip = !isDraft
    ? {
        title: 'Notes',
        body: 'Payslips are locked and visible to employees, and attendance in this period is locked. To correct a posted payroll, void it with a reason and reissue it: the posted version stays on record marked VOID, and the reissued payroll gets new control numbers.',
      }
    : isThirteenth
      ? {
          title: computed ? 'Double-check 13th month pay' : 'Compute the 13th month',
          body: '13th month pay is one-twelfth of the basic salary each employee earned in the calendar year (PD 851), due by December 24. Check each amount before finalizing.',
        }
      : !computed
        ? { title: 'Compute the draft', body: 'Payslips are computed from time in/out, approved leave, rates, allowances and the statutory tables in force for this period.' }
        : {
            title: 'Double-check hours & pay',
            body: 'Check pay rates, overtime, holiday premiums and night differential against the timesheets. Add one-time adjustments, then recompute before finalizing.',
          }
  const canAdjust = isDraft && run.run_type !== 'thirteenth_month'
  // a stale draft can hold payslips for people the run no longer covers: no shortcut for them
  const coveredIds = new Set(covered.map((e) => e.id))
  const hasWarnings = warnings.length > 0 || (result?.warnings.length ?? 0) > 0
  const pickedSlips = slips.filter((x) => picked.has(x.employee_id))
  const togglePicked = (employeeId: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (next.has(employeeId)) next.delete(employeeId)
      else next.add(employeeId)
      return next
    })
  const notices =
    stale || hasWarnings ? (
      <>
        {stale && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Attendance, schedules, adjustments, deduction amounts, leave or pay settings changed since this draft
            was computed (or the last computation did not finish). Recompute the draft before finalizing.
          </p>
        )}
        {hasWarnings && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-amber-800">
              <AlertTriangle className="size-4" /> Review warnings
            </p>
            {/* run-level notes and employees left out of the run (they have no payslip to carry them) */}
            {result?.warnings.map((w, i) => (
              <p key={`r${i}`} className="text-xs text-amber-700">
                • {w.employee === 'This run' ? '' : `${w.employee}: `}{w.warnings.join('; ')}
              </p>
            ))}
            {warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-700">• {w.name}: {w.warning}</p>
            ))}
          </div>
        )}
      </>
    ) : null

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3">
        <IconButton round label="All pay runs" onClick={() => navigate('/admin/payroll')}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">Run payroll · {entity.name}</p>
          <h1 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">{runLabel(run)}</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={isDraft ? 'amber' : run.status === 'paid' ? 'blue' : 'green'}>{isDraft ? 'Draft' : run.status === 'paid' ? 'Paid' : 'Finalized'}</Badge>
          {run.control_no && <Badge tone="slate" dot={false}>{run.control_no}</Badge>}
          {voids.length > 0 && <Badge tone="red" dot={false}>{isDraft ? 'voided, to reissue' : `reissued (${plural(voids.length, 'voided version')})`}</Badge>}
          {run.pay_frequency && <Badge tone="slate" dot={false}>{FREQUENCY_LABELS[run.pay_frequency]}</Badge>}
          {run.annualize && <Badge tone="violet" dot={false}>annualized withholding</Badge>}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {cashSlips.length > 0 && (
            <Button variant="secondary" onClick={() => setShowCash(true)}>
              <Banknote className="size-4" /> Cash payout ({cashSlips.length})
            </Button>
          )}
          <Button variant="secondary" onClick={() => exportRegister()} disabled={slips.length === 0}>
            <Download className="size-4" /> Register CSV
          </Button>
          <Button variant="secondary" onClick={() => setExporting(true)} disabled={slips.length === 0}>
            <FileDown className="size-4" /> Payslips PDF
          </Button>
          {isDraft && (
            <IconButton label="Delete draft run" onClick={deleteDraft} className="text-rose-600">
              <Trash2 className="size-4" />
            </IconButton>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[150px_minmax(0,1fr)] xl:grid-cols-[150px_minmax(0,1fr)_260px]">
        <Stepper steps={steps} />

        <div className="min-w-0 space-y-6">
          {/* below xl the aside drops under the payslips: keep what blocks finalizing in view */}
          {notices && <div className="space-y-4 xl:hidden">{notices}</div>}
          <section className="rounded-xl border border-slate-200/80 bg-white">
            <div className="p-5">
              <h2 className="flex items-center gap-2 text-base font-bold text-ink-900">
                {!isDraft && <CheckCircle2 className="size-5 text-leaf-500" />}
                {!isDraft ? 'Payroll finalized' : isThirteenth ? 'Double-check 13th month pay' : 'Double-check hours & pay'}
              </h2>
              {!isDraft && run.finalized_at && (
                <p className="mt-0.5 text-xs text-slate-500">
                  {run.control_no ? `${run.control_no} · ` : ''}Finalized {fmtDateTime(run.finalized_at)} · employees can see their payslips
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
                <Fact big label="Net payout" value={money(t.net ?? 0)} />
                <Fact label="Gross pay" value={money(t.gross ?? 0)} />
                {isThirteenth ? (
                  <Fact label="Employees" value={String(slips.length)} />
                ) : (
                  <>
                    <Fact label="Hours worked" value={`${hrs(totalHours)} hrs`} />
                    <Fact label="Additional earnings" value={money(extraEarnings)} />
                  </>
                )}
              </div>
            </div>
            {slips.length === 0 ? (
              <div className="border-t border-slate-100 pb-6">
                <EmptyState
                  title="No payslips yet"
                  sub={isDraft ? `${plural(covered.length, 'employee')} covered by this run. Compute the draft to generate their payslips.` : 'This run has no payslips.'}
                />
                {isDraft && (
                  <div className="flex justify-center">
                    <Button onClick={compute} disabled={computing}>
                      <Calculator className="size-4" /> {computing ? 'Computing…' : 'Compute draft'}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 px-5 py-2.5">
                  <label className="flex items-center gap-2.5 text-sm font-medium text-slate-600">
                    <input
                      type="checkbox"
                      className="size-4 accent-brand-700"
                      checked={pickedSlips.length > 0 && pickedSlips.length === slips.length}
                      ref={(el) => {
                        if (el) el.indeterminate = pickedSlips.length > 0 && pickedSlips.length < slips.length
                      }}
                      onChange={() => setPicked(pickedSlips.length === slips.length ? new Set() : new Set(slips.map((x) => x.employee_id)))}
                    />
                    {pickedSlips.length > 0 ? `${pickedSlips.length} of ${slips.length} selected` : 'Select all'}
                  </label>
                  {pickedSlips.length > 0 && (
                    <button type="button" onClick={() => setPicked(new Set())} className="text-xs font-semibold text-slate-500 hover:text-ink-900">
                      Clear
                    </button>
                  )}
                  <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setExporting(true)}>
                    <FileDown className="size-4" />
                    {pickedSlips.length > 0 ? `Download ${plural(pickedSlips.length, 'payslip')}` : 'Download all payslips'}
                  </Button>
                </div>
                {/* rows follow the card's own width: full columns only where the name keeps room */}
                <div className="@container">
                <div className="hidden grid-cols-[minmax(0,1fr)_88px_minmax(0,140px)_136px_112px_32px] gap-3 border-y border-slate-100 bg-slate-100 px-5 py-2.5 text-xs font-semibold text-slate-600 @3xl:grid">
                  <span>{plural(slips.length, 'employee')}</span>
                  <span>{isThirteenth ? '' : 'Hours worked'}</span>
                  <span>{isThirteenth ? '' : 'Additional earnings'}</span>
                  <span className="text-right">Gross · deductions</span>
                  <span className="text-right">Net pay</span>
                  <span />
                </div>
                <ul className="divide-y divide-slate-100 border-t border-slate-100 @3xl:border-t-0">
                  {slips.map((s) => {
                    const snap = s.employee_snapshot as Record<string, string>
                    const mine = adjustments.filter((a) => a.employee_id === s.employee_id)
                    const statEe = Number(s.sss_ee) + Number(s.sss_mpf_ee) + Number(s.philhealth_ee) + Number(s.pagibig_ee)
                    const tax = `${Number(s.withholding_tax) < 0 ? 'Tax refund' : 'W/tax'} ${money(Math.abs(Number(s.withholding_tax)))}`
                    const shortcuts = canAdjust && coveredIds.has(s.employee_id)
                    const adjusts = (
                      <>
                        {mine.map((a) => (
                          <p key={a.id} className={`truncate ${a.kind === 'earning' ? 'text-ink-900' : 'text-rose-600'}`} title={a.label}>
                            {a.kind === 'earning' ? '+' : '−'} {money(Number(a.amount))} {a.label}
                          </p>
                        ))}
                        {shortcuts && (
                          <div className="flex gap-3 text-slate-500">
                            <button
                              type="button"
                              aria-label={`Add an earning for ${snap.name}`}
                              onClick={() => setAddingAdj({ employeeId: s.employee_id, kind: 'earning' })}
                              className="flex items-center gap-0.5 font-medium hover:text-ink-900"
                            >
                              <Plus className="size-3.5" /> Earning
                            </button>
                            <button
                              type="button"
                              aria-label={`Add a deduction for ${snap.name}`}
                              onClick={() => setAddingAdj({ employeeId: s.employee_id, kind: 'deduction' })}
                              className="flex items-center gap-0.5 font-medium hover:text-ink-900"
                            >
                              <Plus className="size-3.5" /> Deduction
                            </button>
                          </div>
                        )}
                      </>
                    )
                    return (
                      <li
                        key={s.id}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-3 px-5 py-3.5 @3xl:grid-cols-[minmax(0,1fr)_88px_minmax(0,140px)_136px_112px_32px] @3xl:items-center"
                      >
                        <div className="flex min-w-0 items-start gap-3 @3xl:items-center">
                          <input
                            type="checkbox"
                            aria-label={`Select ${snap.name}'s payslip`}
                            className="mt-3 size-4 shrink-0 accent-brand-700 @3xl:mt-0"
                            checked={picked.has(s.employee_id)}
                            onChange={() => togglePicked(s.employee_id)}
                          />
                          <Avatar name={snap.name ?? '?'} />
                          <div className="min-w-0">
                            <p className="line-clamp-2 break-words font-semibold leading-snug text-ink-900">{snap.name}</p>
                            <p className="truncate text-xs text-slate-400">
                              {snap.employee_no} · {s.payment_method ? PAYMENT_METHOD_LABELS[s.payment_method] : '—'}
                              {s.is_minimum_wage_earner && ' · MWE'}
                            </p>
                            {/* narrow card: the figures of the wide columns, under the name */}
                            <div className="mt-1.5 space-y-0.5 text-xs text-slate-500 @3xl:hidden">
                              {!isThirteenth && (
                                <p>
                                  {hrs(Number(s.hours_worked))} hrs · {Number(s.days_worked)} days
                                  {Number(s.overtime_hours) > 0 && ` · ${hrs(Number(s.overtime_hours))} OT`}
                                </p>
                              )}
                              <p>
                                Gross {money(Number(s.gross_pay))} · SSS/PH/PI {money(statEe)} · {tax}
                                {Number(s.other_deductions_total) > 0 && ` · Other ded. ${money(Number(s.other_deductions_total))}`}
                              </p>
                              {(mine.length > 0 || shortcuts) && <div className="space-y-0.5 pt-0.5">{adjusts}</div>}
                            </div>
                          </div>
                        </div>
                        <div className="hidden text-sm @3xl:block">
                          {isThirteenth ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <>
                              <p className="font-semibold text-ink-900">
                                <span className="sr-only">Hours worked: </span>
                                {hrs(Number(s.hours_worked))} hrs
                              </p>
                              <p className="text-xs text-slate-400">
                                {Number(s.days_worked)} days
                                {Number(s.overtime_hours) > 0 && ` · ${hrs(Number(s.overtime_hours))} OT`}
                              </p>
                            </>
                          )}
                        </div>
                        <div className="hidden min-w-0 text-xs @3xl:block">
                          {mine.length > 0 || shortcuts ? adjusts : <span className="text-slate-300">—</span>}
                        </div>
                        <div className="hidden text-right @3xl:block">
                          <p className="text-sm">
                            <span className="sr-only">Gross pay: </span>
                            {money(Number(s.gross_pay))}
                          </p>
                          {/* the review figures the old register table showed per employee */}
                          <p className="text-[11px] text-slate-400">SSS/PH/PI {money(statEe)}</p>
                          <p className="text-[11px] text-slate-400">{tax}</p>
                          {Number(s.other_deductions_total) > 0 && (
                            <p className="text-[11px] text-slate-400">Other ded. {money(Number(s.other_deductions_total))}</p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-ink-900">
                            <span className="sr-only">Net pay: </span>
                            {money(Number(s.net_pay))}
                          </p>
                          {Number(s.rounding_adjustment) !== 0 && (
                            <p className="text-[10px] text-slate-400">
                              rounding {Number(s.rounding_adjustment) > 0 ? '+' : ''}
                              {money(Number(s.rounding_adjustment))}
                            </p>
                          )}
                        </div>
                        <IconButton size="sm" label={`View ${snap.name}'s payslip`} onClick={() => setViewing(s)}>
                          <Eye className="size-4" />
                        </IconButton>
                      </li>
                    )
                  })}
                </ul>
                </div>
              </>
            )}
          </section>

          {(canAdjust || adjustments.length > 0) && (
            <Card
              title={`One-time adjustments (${adjustments.length})`}
              icon={<SlidersHorizontal />}
              actions={
                canAdjust && (
                  <Button variant="secondary" onClick={() => setAddingAdj({ kind: 'earning' })}>
                    <Plus className="size-4" /> Add adjustment
                  </Button>
                )
              }
            >
              {adjustments.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Bonuses, corrections of earlier payrolls, final-pay extras or one-off deductions for this run only.
                  Recompute after changes.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {adjustments.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                      <div className="min-w-0">
                        <span className="font-semibold text-ink-900">{empName(a.employee_id)}</span>
                        <span className="text-slate-500"> · {a.label}</span>{' '}
                        <Badge tone={a.kind === 'earning' ? 'green' : 'red'}>{a.kind}</Badge>{' '}
                        <span className="text-xs text-slate-400">
                          {a.benefit
                            ? MATERNITY_BENEFIT_LABELS[a.benefit]
                            : a.kind === 'earning'
                              ? BIR_BUCKET_LABELS[a.category as keyof typeof BIR_BUCKET_LABELS]
                              : a.category.replaceAll('_', ' ')}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`font-semibold ${a.kind === 'earning' ? 'text-ink-900' : 'text-rose-600'}`}>
                          {a.kind === 'deduction' ? '−' : ''}{money(Number(a.amount))}
                        </span>
                        {isDraft && (
                          <button type="button" onClick={() => removeAdjustment(a.id)} className="text-slate-300 hover:text-rose-500" title="Remove" aria-label={`Remove ${a.label}`}>
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

          {!isThirteenth && <RunDeductionsCard run={run} covered={covered} slips={slips} onChanged={load} />}

          {voids.length > 0 && (
            <Card title={`Voided versions (${voids.length})`} icon={<Ban />}>
              <p className="mb-3 text-sm text-slate-500">
                Posted versions of this payroll that were voided. They stay on record, marked VOID, with their original
                control numbers; employees see only the reissued payslips.
              </p>
              <ul className="divide-y divide-slate-100">
                {voids.map((v) => {
                  const net = round2(v.payslips.reduce((sum, x) => sum + Number(x.net_pay), 0))
                  return (
                    <li key={v.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="font-semibold text-ink-900">
                          {v.run_control_no ?? 'Unnumbered'} <Badge tone="red" dot={false}>VOID</Badge>
                        </p>
                        <p className="text-xs text-slate-500">
                          Voided {fmtDateTime(v.voided_at)} by {v.voided_by_email ?? 'unknown'} · {plural(v.payslips.length, 'payslip')} ·
                          net {money(net)}
                        </p>
                        <p className="mt-1 break-words text-xs text-slate-600">Reason: {v.reason}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" onClick={() => exportRegister(v.payslips, v)}>
                          <Download className="size-4" /> Register
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setVoidExport(v)}>
                          <FileDown className="size-4" /> Payslips
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}

          {computed && (
            <div className="grid gap-6 2xl:grid-cols-2">
              {!isThirteenth && (
              <Card title="Working hour summary" icon={<Clock />}>
                <div className="grid grid-cols-3">
                  <HourFact value={`${hrs(regularHours)}hr`} label="Regular hours" />
                  <HourFact value={`${hrs(otHours)}hr`} label="Overtime" />
                  <HourFact value={`${hrs(absentDays)}`} label={absentDays === 1 ? 'Day absent' : 'Days absent'} />
                </div>
                <div className="mt-6 flex h-3 gap-0.5 overflow-hidden rounded-full bg-slate-100">
                  {totalHours > 0 && (
                    <>
                      <span style={{ width: `${(regularHours / totalHours) * 100}%`, background: SERIES.green }} />
                      <span style={{ width: `${(otHours / totalHours) * 100}%`, background: SERIES.blue }} />
                    </>
                  )}
                </div>
                <div className="mt-2 flex gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: SERIES.green }} /> Regular</span>
                  <span className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: SERIES.blue }} /> Overtime</span>
                </div>
              </Card>
              )}
              <Card title={isDraft ? 'What the company will pay' : 'What the company paid'} icon={<PieChart />}>
                <div className="flex flex-col items-center gap-6 sm:flex-row">
                  <Donut
                    segments={spend}
                    center={
                      <>
                        <p className="text-lg font-bold text-ink-900">{money(t.employer_cost ?? 0)}</p>
                        <p className="text-xs text-slate-500">Total employer cost</p>
                      </>
                    }
                  />
                  <ul className="grid w-full flex-1 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-1">
                    {spend.map((x) => (
                      <li key={x.label} className="flex items-start gap-2">
                        <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: x.color }} />
                        <span>
                          <span className="block text-sm font-bold text-ink-900">{money(x.value)}</span>
                          <span className="block text-xs text-slate-500">{x.label}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            </div>
          )}

          <StatGroup>
            <StatCard label="Withholding tax" value={money(t.withholding_tax ?? 0)} sub="Remit via BIR 1601-C" />
            <StatCard label="SSS (EE+ER)" value={money((t.sss_ee ?? 0) + (t.sss_er ?? 0))} />
            <StatCard label="PhilHealth (EE+ER)" value={money((t.philhealth_ee ?? 0) + (t.philhealth_er ?? 0))} />
            <StatCard label="Pag-IBIG (EE+ER)" value={money((t.pagibig_ee ?? 0) + (t.pagibig_er ?? 0))} />
          </StatGroup>
        </div>

        <aside className="space-y-4 lg:col-start-2 xl:col-start-auto">
          <div className="rounded-xl bg-slate-200/50 p-4">
            <p className="text-sm font-semibold text-ink-900">{tip.title}</p>
            <p className="mt-1 text-sm text-slate-600">{tip.body}</p>
            {!isThirteenth && (
              <Link
                to={`/admin/timesheets?tab=report&from=${run.period_start}&to=${run.period_end}${run.pay_frequency ? `&frequency=${run.pay_frequency}` : ''}`}
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-700 hover:underline"
              >
                <Clock className="size-4" /> Time report for this period
              </Link>
            )}
          </div>
          {notices && <div className="hidden space-y-4 xl:block">{notices}</div>}
          <dl className="space-y-3 rounded-xl border border-slate-200/80 bg-white p-4 text-sm">
            <RunFact label="Pay period" value={fmtPeriod(run.period_start, run.period_end)} />
            <RunFact label="Pay date" value={fmtDate(run.pay_date)} />
            <RunFact
              label="Payroll month"
              value={
                <>
                  <span className="whitespace-nowrap">{fmtMonth(run.period_month)}</span>
                  {run.periods_in_month > 1 && (
                    <span className="whitespace-nowrap"> · {run.period_index} of {run.periods_in_month}</span>
                  )}
                </>
              }
            />
            <RunFact label="Employees" value={`${t.employees ?? slips.length}${isDraft ? ` of ${covered.length} covered` : ''}`} />
            <RunFact label="Employer cost" value={money(t.employer_cost ?? 0)} />
            {!!t.cash_employees && <RunFact label="Cash payout" value={`${money(t.cash_net)} to ${t.cash_employees}`} />}
          </dl>
          {computed && (
            <div className="rounded-xl border border-slate-200/80 bg-white p-4 text-sm">
              <p className="mb-3 flex items-center gap-1.5 font-semibold text-ink-900">
                <Scale className="size-4" /> Control totals
              </p>
              <dl className="space-y-1.5">
                <RunFact label="Payslips" value={control.payslips} />
                <RunFact label="Gross pay" value={money(control.gross)} />
                <RunFact label="Deductions" value={money(control.deductions)} />
                {control.rounding !== 0 && <RunFact label="Cash rounding" value={money(control.rounding)} />}
                <RunFact label="Net pay" value={money(control.net)} />
                <RunFact label="Withholding tax" value={money(control.withholdingTax)} />
                {control.firstNo && (
                  <RunFact label="Payslip nos." value={control.firstNo === control.lastNo ? control.firstNo : `${control.firstNo} to ${control.lastNo}`} />
                )}
              </dl>
              {isDraft && !upToDate ? (
                <p className="mt-3 text-xs text-slate-500">Recompute the draft to check its totals.</p>
              ) : control.balanced ? (
                <p className="mt-3 flex items-start gap-1.5 text-xs font-medium text-leaf-700">
                  <CheckCircle2 className="mt-px size-4 shrink-0" /> In balance: every payslip adds up and the run totals equal the payslips.
                </p>
              ) : (
                <div className="mt-3 space-y-1 text-xs text-rose-700">
                  <p className="flex items-start gap-1.5 font-semibold">
                    <AlertTriangle className="mt-px size-4 shrink-0" /> Out of balance{isDraft ? ': finalize will refuse it. Recompute the draft.' : '.'}
                  </p>
                  {control.unbalanced.length > 0 && <p>Payslip lines do not add up: {control.unbalanced.join(', ')}</p>}
                  {control.mismatches.map((m) => (
                    <p key={m.field}>
                      Run {m.field === 'withholding_tax' ? 'tax' : m.field} {m.run === null ? 'missing' : money(m.run)}, payslips {money(m.payslips)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-8 flex items-center justify-between gap-3 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:-mb-6 sm:px-6 lg:-mx-8 lg:-mb-8 lg:px-8">
        <Link to="/admin/payroll" className="hidden text-sm font-semibold text-ink-900 hover:underline sm:inline">
          Back to payroll
        </Link>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          {isDraft ? (
            <>
              <Button variant={computed && upToDate ? 'secondary' : 'primary'} onClick={compute} disabled={computing}>
                <Calculator className="size-4" />
                {computing ? 'Computing…' : computed ? 'Recompute draft' : 'Compute draft'}
              </Button>
              <Button onClick={doFinalize} disabled={busy || computing || !upToDate} variant={computed && upToDate ? 'primary' : 'secondary'}>
                <Lock className="size-4" /> Finalize <ArrowRight className="size-4" />
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setVoiding(true)} disabled={busy}>
              <Ban className="size-4" /> Void and reissue
            </Button>
          )}
        </div>
      </div>

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title="Payslip" wide>
        {viewing && <PayslipView slip={viewing} run={run} company={entity} showTrace />}
      </Modal>

      {exporting && (
        <PayslipExportModal
          slips={slips}
          picked={pickedSlips}
          run={run}
          company={entity}
          fileBase={`payslips_${entity.code}_${run.period_end}`}
          stamp={stamp(`Payslips ${run.control_no ?? '(draft)'}, ${runLabel(run)}`)}
          onClose={() => setExporting(false)}
        />
      )}

      {voidExport && (
        <PayslipExportModal
          slips={voidExport.payslips}
          picked={[]}
          run={{ ...voidExport.run_snapshot, status: 'finalized' }}
          company={entity}
          fileBase={`payslips_${entity.code}_${run.period_end}_${voidExport.run_control_no ?? 'unnumbered'}_VOID`}
          stamp={stamp(`Voided payslips ${voidExport.run_control_no ?? '(unnumbered)'}, ${runLabel(voidExport.run_snapshot)}`)}
          voided={{ at: voidExport.voided_at, by: voidExport.voided_by_email, reason: voidExport.reason }}
          onClose={() => setVoidExport(null)}
        />
      )}

      {voiding && (
        <VoidRunModal
          controlNo={run.control_no}
          label={runLabel(run)}
          busy={busy}
          onVoid={doVoid}
          onClose={() => setVoiding(false)}
        />
      )}

      <Modal open={showCash} onClose={() => setShowCash(false)} title="Cash payout — bills and coins per envelope" wide>
        <div className="space-y-4">
          {cashTotal.centavos > 0 && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Some cash net pays have centavos. Turn on whole-peso rounding in Client Settings, then recompute.
            </p>
          )}
          <TableShell>
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th className="text-right">Net</Th>
                {PESO_DENOMINATIONS.map((d) => (
                  <Th key={d} className="text-right">₱{d}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
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
                <Td className="text-right text-xs">{money(cashRows.reduce((sum, r) => sum + Number(r.slip.net_pay), 0))}</Td>
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
          initialEmployeeId={addingAdj.employeeId}
          initialKind={addingAdj.kind}
          onClose={() => setAddingAdj(null)}
          onSaved={async () => {
            setAddingAdj(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

type Step = { label: string; sub: string; state: 'done' | 'current' | 'todo' }

function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-3 lg:sticky lg:top-0 lg:flex-col lg:gap-5 lg:self-start">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-start gap-3" aria-current={s.state === 'current' ? 'step' : undefined}>
          {s.state === 'done' ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-leaf-500 text-white">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          ) : s.state === 'current' ? (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-ink-900 border-r-slate-300 text-[11px] font-bold text-ink-900">
              {i + 1}
            </span>
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-500">
              {i + 1}
            </span>
          )}
          <span>
            <span className={`block text-sm font-semibold ${s.state === 'todo' ? 'text-slate-500' : 'text-ink-900'}`}>{s.label}</span>
            <span className="hidden text-xs text-slate-400 lg:block">{s.sub}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function Fact({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <p className={`font-bold tracking-tight text-ink-900 ${big ? 'text-2xl' : 'text-lg'}`}>{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}

function HourFact({ value, label }: { value: string; label: string }) {
  return (
    <div className="border-l border-dashed border-slate-300 pl-3">
      <p className="text-xl font-bold text-ink-900">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  )
}

function RunFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="text-right font-semibold text-ink-900">{value}</dd>
    </div>
  )
}

function hrs(n: number) {
  return n.toLocaleString('en-PH', { maximumFractionDigits: 2 })
}

function AdjustmentModal({
  runId,
  employees,
  initialEmployeeId,
  initialKind = 'earning',
  onClose,
  onSaved,
}: {
  runId: string
  employees: Employee[]
  initialEmployeeId?: string
  initialKind?: 'earning' | 'deduction'
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({
    employee_id: initialEmployeeId && employees.some((e) => e.id === initialEmployeeId) ? initialEmployeeId : (employees[0]?.id ?? ''),
    kind: initialKind as string,
    label: '',
    amount: '',
    category: initialKind === 'earning' ? 'other_taxable' : 'other',
    authorized: '',
    dm: '' as DeMinimisKind | '',
    leaveDays: '',
    itemType: '' as PayItemType | '',
  })
  const [busy, setBusy] = useState(false)
  // maternity pay is picked like a classification: other non-taxable, marked with which one
  const benefit = f.kind === 'earning' && f.category.startsWith('benefit:') ? (f.category.slice(8) as MaternityBenefit) : null
  const needsAuthorization = f.kind === 'deduction' && f.category === 'other'
  // unused leave converted to cash: de minimis up to the yearly days ceiling, or taxable (client settings)
  const leaveConversion = f.kind === 'earning' && f.category === 'leave:conversion'
  const deMinimis = f.kind === 'earning' && f.category === 'de_minimis'

  async function save() {
    if (!employees.some((e) => e.id === f.employee_id) || !f.label.trim() || !(Number(f.amount) > 0)) {
      toast('error', 'Employee, label and a positive amount are required.')
      return
    }
    if (deMinimis && !f.dm) {
      toast('error', 'Pick the de minimis benefit: only the benefits on the BIR list are de minimis (any other benefit is taxable).')
      return
    }
    if (leaveConversion && !(Number(f.leaveDays) > 0 && Number(f.leaveDays) <= 365)) {
      toast('error', 'Enter the number of unused leave days converted to cash (up to 365).')
      return
    }
    if (needsAuthorization && !f.authorized) {
      toast('error', 'Enter the date the employee signed the written authorization for this deduction (Labor Code Art. 113).')
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
      category:
        f.kind === 'earning'
          ? benefit
            ? 'other_non_taxable'
            : leaveConversion
              ? 'de_minimis'
              : f.category
          : f.category === 'union_dues'
            ? 'union_dues'
            : 'other',
      benefit,
      de_minimis_kind: leaveConversion ? 'monetized_vl' : deMinimis ? f.dm : null,
      leave_days: leaveConversion ? Number(f.leaveDays) : null,
      pay_item_type:
        f.kind !== 'earning'
          ? null
          : f.itemType === 'christmas_bonus' && f.category === 'other_benefits'
            ? 'christmas_bonus'
            : f.itemType === 'liquidated_allowance' && LIQUIDATABLE_CATEGORIES.includes(f.category)
              ? 'liquidated_allowance'
              : (SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(f.itemType) && f.category === 'other_taxable'
                ? f.itemType
                : null,
      authorized_on: needsAuthorization ? f.authorized : null,
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
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Input value={f.label} maxLength={120} placeholder="e.g. Unpaid OT on Oct 3" onChange={(e) => setF({ ...f, label: e.target.value })} />
        </Field>
        <Field label={f.kind === 'earning' ? 'BIR classification' : 'Deduction kind'}>
          <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {f.kind === 'earning' ? (
              <>
                {EARNING_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{BIR_BUCKET_LABELS[c]}</option>
                ))}
                <optgroup label="Leave">
                  <option value="leave:conversion">Unused leave converted to cash</option>
                </optgroup>
                <optgroup label="Maternity leave (RA 11210)">
                  {(Object.keys(MATERNITY_BENEFIT_LABELS) as MaternityBenefit[]).map((b) => (
                    <option key={b} value={`benefit:${b}`}>{MATERNITY_BENEFIT_LABELS[b]}</option>
                  ))}
                </optgroup>
              </>
            ) : (
              <>
                <option value="other">Other deduction</option>
                <option value="union_dues">Union dues (tax-exempt)</option>
              </>
            )}
          </Select>
        </Field>
        {f.kind === 'earning' && f.category === 'other_benefits' && (
          <Toggle
            checked={f.itemType === 'christmas_bonus'}
            onChange={(v) => setF({ ...f, itemType: v ? 'christmas_bonus' : '' })}
            label="This is the Christmas bonus (not SSS compensation)"
          />
        )}
        {f.kind === 'earning' && f.category === 'other_taxable' && (
          <Field label="Kind" hint="Commissions, profit sharing and fees are supplementary pay with their own BIR 2316 items">
            <Select
              value={(SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(f.itemType) ? f.itemType : ''}
              onChange={(e) => setF({ ...f, itemType: e.target.value as PayItemType | '' })}
            >
              <option value="">Other taxable (regular)</option>
              {SUPPLEMENTARY_ITEM_TYPES.map((t) => (
                <option key={t} value={t}>{PAY_ITEM_TYPE_LABELS[t]}</option>
              ))}
            </Select>
          </Field>
        )}
        {f.kind === 'earning' && LIQUIDATABLE_CATEGORIES.includes(f.category) && !(SUPPLEMENTARY_ITEM_TYPES as readonly string[]).includes(f.itemType) && (
          <Toggle
            checked={f.itemType === 'liquidated_allowance'}
            onChange={(v) => setF({ ...f, itemType: v ? 'liquidated_allowance' : '' })}
            label="Subject to liquidation: a reimbursement of expenses (not SSS compensation)"
          />
        )}
        {deMinimis && (
          <Field label="De minimis benefit" hint="Non-taxable up to its BIR ceiling (counting what earlier payrolls paid); anything above is taxable.">
            <Select value={f.dm} onChange={(e) => setF({ ...f, dm: e.target.value as DeMinimisKind | '' })}>
              <option value="">Pick the benefit…</option>
              {ALLOWANCE_DE_MINIMIS.map((k) => (
                <option key={k} value={k}>{DE_MINIMIS_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
        )}
        {leaveConversion && (
          <Field
            label="Leave days converted"
            hint="A client granting 5 or more paid vacation leave days a year: de minimis up to the yearly days ceiling, the rest taxable. A client giving only the 5-day service incentive leave: taxable (Client Settings)."
          >
            <Input type="number" min={0.5} max={365} step="0.5" value={f.leaveDays} onChange={(e) => setF({ ...f, leaveDays: e.target.value })} />
          </Field>
        )}
        {needsAuthorization && (
          <Field
            label="Employee's written authorization signed on"
            hint="Required: a deduction the law doesn't provide for needs the employee's written authorization (Labor Code Art. 113). Keep the signed copy on file."
          >
            <Input type="date" value={f.authorized} onChange={(e) => setF({ ...f, authorized: e.target.value })} />
          </Field>
        )}
        {f.kind === 'earning' && (
          <p className="text-xs text-slate-400">
            {benefit
              ? 'Maternity leave days are not paid as salary: the SSS maternity benefit (advanced in full within 30 days of the leave application) and the salary differential up to full pay are their own earnings, both tax-exempt (RMC 105-2019).'
              : 'Basic-pay corrections count toward the 13th month; bonuses share the ₱90,000 cap; the statutory minimum wage package stays exempt for minimum wage earners. De minimis benefits are exempt up to their ceilings (RR 29-2025); the rest is taxed.'}
          </p>
        )}
        <Button className="w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add adjustment'}</Button>
      </div>
    </Modal>
  )
}

// ---------- bulk payslip download ----------

/**
 * Voiding a posted payroll (BIR RMO 9-2021 Annex B, item 10: a posted entry
 * is never edited): the posted run and its payslips are archived as VOID with
 * the reason, and the run returns to draft to be corrected and reissued under
 * new control numbers.
 */
function VoidRunModal({
  controlNo,
  label,
  busy,
  onVoid,
  onClose,
}: {
  controlNo: string | null
  label: string
  busy: boolean
  onVoid: (reason: string) => void
  onClose: () => void
}) {
  const [reason, setReason] = useState('')
  const trimmed = reason.trim()
  const ok = trimmed.length >= 5 && trimmed.length <= 500
  return (
    <Modal open onClose={busy ? () => {} : onClose} title={`Void ${controlNo ?? 'this payroll'} and reissue`}>
      <div className="space-y-4 text-sm">
        <p className="text-slate-600">
          A posted payroll is never edited. Voiding <b>{label}</b> keeps it and its payslips on record, marked VOID with
          your reason, and returns the run to draft without control numbers. Correct it, recompute and finalize it
          again: the reissued payroll and payslips get new control numbers.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
          <li>Employees no longer see these payslips until the reissued payroll is finalized.</li>
          <li>Loan and cash advance balances and cash-rounding carries this payroll moved are restored.</li>
          <li>A later payroll that carried this one&apos;s rounding must be voided first.</li>
        </ul>
        <Field label="Reason for voiding" hint="5 to 500 characters, kept with the voided version and in the audit log">
          <Textarea rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </Field>
        <Button className="w-full" variant="danger" disabled={!ok || busy} onClick={() => onVoid(trimmed)}>
          <Ban className="size-4" /> {busy ? 'Voiding…' : `Void ${controlNo ?? 'payroll'}`}
        </Button>
      </div>
    </Modal>
  )
}

/**
 * Download many payslips at once: everyone in the run or the ones picked in
 * the list, as one PDF (a payslip per page, for printing) or a ZIP of one
 * PDF per employee (for sending individually).
 */
function PayslipExportModal({
  slips,
  picked,
  run,
  company,
  fileBase,
  stamp,
  voided,
  onClose,
}: {
  slips: Payslip[]
  picked: Payslip[]
  run: PayslipRunInfo
  company: PayslipCompany
  fileBase: string
  stamp: ReportStamp
  /** an archived version of a voided payroll: every page is marked VOID */
  voided?: PayslipPdfOptions['voided']
  onClose: () => void
}) {
  const toast = useToast()
  const [scope, setScope] = useState<'picked' | 'all'>(picked.length > 0 ? 'picked' : 'all')
  const [format, setFormat] = useState<'pdf' | 'zip'>('pdf')
  const [done, setDone] = useState<number | null>(null)
  const chosen = scope === 'picked' ? picked : slips
  const busy = done !== null

  async function download() {
    if (busy || chosen.length === 0) return
    setDone(0)
    try {
      const opts = { stamp, voided }
      if (format === 'pdf') {
        const doc = await buildPayslipsDoc(chosen, run, company, setDone, opts)
        downloadBlob(`${fileBase}.pdf`, doc.output('blob'))
      } else {
        const zip = await buildPayslipsZip(chosen, run, company, setDone, opts)
        downloadBlob(`${fileBase}.zip`, new Blob([zip as BlobPart], { type: 'application/zip' }))
      }
      void logActivity('export', company.id, { report: stamp.title, file: `${fileBase}.${format}`, payslips: chosen.length })
      toast('success', `Downloaded ${plural(chosen.length, 'payslip')}.`)
      onClose()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not prepare the payslips'))
      setDone(null)
    }
  }

  const option = (checked: boolean, onPick: () => void, title: string, sub: string, disabled = false) => (
    <label
      className={`flex items-start gap-3 rounded-xl border p-3 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${checked ? 'border-brand-600 bg-brand-50/60' : 'border-slate-200 hover:bg-slate-50'}`}
    >
      <input type="radio" className="mt-0.5 size-4 accent-brand-700" checked={checked} disabled={disabled || busy} onChange={onPick} />
      <span>
        <span className="block text-sm font-semibold text-ink-900">{title}</span>
        <span className="block text-xs text-slate-500">{sub}</span>
      </span>
    </label>
  )

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Download payslips">
      <div className="space-y-5">
        <Field group label="Whose payslips">
          <div className="space-y-2">
            {option(
              scope === 'picked',
              () => setScope('picked'),
              `Selected employees (${picked.length})`,
              picked.length > 0 ? 'The ones ticked in the list' : 'Tick employees in the list first',
              picked.length === 0,
            )}
            {option(scope === 'all', () => setScope('all'), `Everyone in this run (${slips.length})`, 'Sorted by name, as listed')}
          </div>
        </Field>
        <Field group label="Format">
          <div className="space-y-2">
            {option(format === 'pdf', () => setFormat('pdf'), 'One PDF', 'A payslip per page, ready to print in one go')}
            {option(format === 'zip', () => setFormat('zip'), 'Separate PDFs in a ZIP', 'One file per employee, named by employee no., for sending individually')}
          </div>
        </Field>
        {run.status === 'draft' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This payroll is still a draft: every page is marked DRAFT PAYSLIP, and amounts may change before it is
            finalized.
          </p>
        )}
        <Button className="w-full" disabled={busy || chosen.length === 0} onClick={download}>
          <FileDown className="size-4" />
          {busy ? `Preparing… ${done} of ${chosen.length}` : `Download ${plural(chosen.length, 'payslip')}`}
        </Button>
      </div>
    </Modal>
  )
}
