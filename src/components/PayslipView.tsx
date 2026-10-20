import { Download } from 'lucide-react'
import type { Entity, Payslip, PayrollRun } from '../lib/db'
import { fmtDate, fmtPeriod, money } from '../lib/format'
import { FREQUENCY_LABELS, PAYMENT_METHOD_LABELS } from '../lib/labels'
import { generatePayslipPdf } from '../pdf/payslipPdf'
import { Badge, Button } from './ui'

export type PayslipCompany = Pick<Entity, 'name' | 'registered_address' | 'tin' | 'tin_branch_code' | 'payslip_footer_note'>

export type PayslipRunInfo = Pick<PayrollRun, 'run_type' | 'period_start' | 'period_end' | 'pay_date' | 'status'>

/** Run info for a payslip from its own denormalized columns (employee view). */
export function runFromSlip(s: Payslip): PayslipRunInfo {
  return {
    run_type: s.run_type ?? 'regular',
    period_start: s.period_start ?? '',
    period_end: s.period_end ?? '',
    pay_date: s.pay_date ?? '',
    status: 'finalized',
  }
}

export function runLabel(run: Pick<PayrollRun, 'run_type' | 'period_start' | 'period_end'>): string {
  if (run.run_type === 'thirteenth_month') return `13th Month Pay ${run.period_end.slice(0, 4)}`
  const base = fmtPeriod(run.period_start, run.period_end)
  if (run.run_type === 'final_pay') return `${base} (final pay)`
  if (run.run_type === 'special') return `${base} (special)`
  return base
}

export default function PayslipView({
  slip,
  run,
  company,
  showTrace = false,
}: {
  slip: Payslip
  run: PayslipRunInfo
  company: PayslipCompany
  showTrace?: boolean
}) {
  const snap = slip.employee_snapshot as Record<string, string>
  const employerTotal =
    Number(slip.sss_er) + Number(slip.sss_mpf_er) + Number(slip.sss_ec_er) +
    Number(slip.philhealth_er) + Number(slip.pagibig_er)
  const trace = slip.computation_trace
  const rounding = Number(slip.rounding_adjustment)
  const computedNet = Number(slip.gross_pay) - Number(slip.total_deductions)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-lg font-extrabold text-brand-900">{snap.name}</p>
          <p className="text-xs text-slate-500">
            {snap.employee_no} • {snap.position || '—'} {snap.department ? `• ${snap.department}` : ''}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {runLabel(run)} • Pay date {fmtDate(run.pay_date)}
            {slip.pay_frequency ? ` • ${FREQUENCY_LABELS[slip.pay_frequency]}` : ''}
            {slip.payment_method ? ` • ${PAYMENT_METHOD_LABELS[slip.payment_method]}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {run.status !== 'draft' ? <Badge tone="green">Finalized</Badge> : <Badge tone="amber">Draft</Badge>}
          <Button variant="secondary" onClick={() => generatePayslipPdf(slip, run, company)}>
            <Download className="size-4" /> PDF
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Earnings
          </div>
          <div className="divide-y divide-slate-50 px-4">
            {slip.earnings.map((l, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-slate-600">
                  {l.label}
                  {l.hours ? <span className="text-slate-400"> · {l.hours}h</span> : null}
                </span>
                <span className={`font-semibold ${l.amount < 0 ? 'text-rose-600' : 'text-slate-800'}`}>
                  {money(l.amount)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5 text-sm font-bold text-brand-900">
              <span>Gross Pay</span>
              <span>{money(Number(slip.gross_pay))}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Deductions
          </div>
          <div className="divide-y divide-slate-50 px-4">
            {slip.deductions.length === 0 && (
              <p className="py-2 text-sm text-slate-400">No deductions</p>
            )}
            {slip.deductions.map((l, i) => (
              <div key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-slate-600">{l.label}</span>
                <span className={`font-semibold ${l.amount < 0 ? 'text-emerald-600' : 'text-slate-800'}`}>
                  {money(l.amount)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2.5 text-sm font-bold text-brand-900">
              <span>Total Deductions</span>
              <span>{money(Number(slip.total_deductions))}</span>
            </div>
          </div>
        </div>
      </div>

      {rounding !== 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 px-4 py-2.5 text-xs text-slate-600">
          <div className="flex justify-between">
            <span>Computed net pay</span>
            <span className="font-semibold">{money(computedNet)}</span>
          </div>
          <div className="flex justify-between">
            <span>
              Cash rounding
              {Number(slip.rounding_carry_in) > 0 && ` (incl. ${money(Number(slip.rounding_carry_in))} carried in)`}
              {Number(slip.rounding_carry_out) > 0 && ` — ${money(Number(slip.rounding_carry_out))} carried to next payroll`}
            </span>
            <span className="font-semibold">{rounding > 0 ? '+' : ''}{money(rounding)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-accent-500 to-accent-600 px-5 py-4 text-white shadow-sm">
        <span className="text-sm font-bold uppercase tracking-wide">Net Pay</span>
        <span className="text-2xl font-extrabold tracking-tight">{money(Number(slip.net_pay))}</span>
      </div>

      {employerTotal > 0 && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Employer contributions (not deducted from your pay)
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-3 lg:grid-cols-6">
            <div>SSS: <b>{money(Number(slip.sss_er))}</b></div>
            <div>SSS MPF: <b>{money(Number(slip.sss_mpf_er))}</b></div>
            <div>EC: <b>{money(Number(slip.sss_ec_er))}</b></div>
            <div>PhilHealth: <b>{money(Number(slip.philhealth_er))}</b></div>
            <div>Pag-IBIG: <b>{money(Number(slip.pagibig_er))}</b></div>
            <div>Total: <b>{money(employerTotal)}</b></div>
          </div>
        </div>
      )}

      {showTrace && (trace?.notes?.length || trace?.warnings?.length) ? (
        <div className="rounded-xl border border-slate-200 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
            Computation notes
          </p>
          {trace.warnings?.map((w, i) => (
            <p key={`w${i}`} className="text-xs text-rose-600">⚠ {w}</p>
          ))}
          {trace.notes?.map((n, i) => (
            <p key={`n${i}`} className="text-xs text-slate-500">• {n}</p>
          ))}
          <p className="mt-2 text-xs text-slate-400">
            Rates used: daily {money(trace.dailyRate ?? 0)} · hourly {money(trace.hourlyRate ?? 0)} ·
            statutory monthly base {money(trace.statutoryMonthlyBase ?? 0)}
          </p>
        </div>
      ) : null}
      {company.name && (
        <p className="text-[11px] text-slate-400">
          {company.name}
          {company.tin ? ` · TIN ${company.tin}` : ''}
        </p>
      )}
    </div>
  )
}
