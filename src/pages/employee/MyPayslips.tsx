import { useCallback, useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import PayslipView from '../../components/PayslipView'
import { Badge, Card, EmptyState, Modal, PageHeader, Spinner } from '../../components/ui'
import { getSettings } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import type { CompanySettings, Payslip, PayrollRun } from '../../lib/db'
import { fmtDate, fmtPeriod, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'

// Employees can only SELECT payslips of finalized runs (RLS), and run info is
// denormalized onto the payslip — no payroll_runs access needed.
function runFromSlip(s: Payslip): PayrollRun {
  return {
    id: s.payroll_run_id,
    run_type: s.run_type ?? 'regular',
    period_start: s.period_start ?? '',
    period_end: s.period_end ?? '',
    pay_date: s.pay_date ?? '',
    status: 'finalized',
    notes: '',
    totals: {},
    finalized_at: null,
    created_at: '',
  }
}

export default function MyPayslips() {
  const { employee } = useAuth()
  const [slips, setSlips] = useState<Payslip[]>([])
  const [settings, setSettings] = useState<CompanySettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<Payslip | null>(null)

  const load = useCallback(async () => {
    if (!employee) return
    const [{ data }, s] = await Promise.all([
      supabase
        .from('payslips')
        .select('*')
        .eq('employee_id', employee.id)
        .order('period_end', { ascending: false }),
      getSettings(),
    ])
    setSlips((data ?? []) as Payslip[])
    setSettings(s)
    setLoading(false)
  }, [employee])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <Spinner />

  const thisYear = String(new Date().getFullYear())
  const ytdNet = slips
    .filter((s) => (s.period_end ?? '').slice(0, 4) === thisYear)
    .reduce((sum, s) => sum + Number(s.net_pay), 0)

  return (
    <div>
      <PageHeader
        title="My Payslips"
        subtitle={`Finalized payslips only · YTD net pay ${money(ytdNet)}`}
      />
      {slips.length === 0 ? (
        <Card>
          <EmptyState
            title="No payslips yet"
            sub="Payslips appear here once a payroll run that includes you is finalized."
          />
        </Card>
      ) : (
        <div className="grid gap-3">
          {slips.map((s) => (
            <button
              key={s.id}
              onClick={() => setViewing(s)}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50">
                  <FileText className="size-5 text-brand-600" />
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {s.run_type === 'thirteenth_month'
                      ? `13th Month Pay ${(s.period_end ?? '').slice(0, 4)}`
                      : s.period_start && s.period_end
                        ? fmtPeriod(s.period_start, s.period_end)
                        : 'Payslip'}
                  </p>
                  <p className="text-xs text-slate-500">Paid {fmtDate(s.pay_date)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {s.run_type === 'thirteenth_month' && <Badge tone="orange">13th month</Badge>}
                <div className="text-right">
                  <p className="text-xs text-slate-400">Net pay</p>
                  <p className="text-lg font-extrabold text-brand-900">{money(Number(s.net_pay))}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title="Payslip" wide>
        {viewing && settings && (
          <PayslipView slip={viewing} run={runFromSlip(viewing)} company={settings} />
        )}
      </Modal>
    </div>
  )
}
