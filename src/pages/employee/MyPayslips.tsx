import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'
import PayslipView, { runFromSlip, runLabel } from '../../components/PayslipView'
import { Badge, Card, EmptyState, Modal, PageHeader, Select, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth'
import type { Entity, Payslip } from '../../lib/db'
import { fmtDate, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'

// Employees can only SELECT their own payslips of finalized runs (RLS), and
// run info is copied onto the payslip — no payroll_runs access needed.
export default function MyPayslips() {
  const { employee } = useAuth()
  const [slips, setSlips] = useState<Payslip[]>([])
  const [entity, setEntity] = useState<Entity | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<Payslip | null>(null)
  const [year, setYear] = useState('')

  const load = useCallback(async () => {
    if (!employee) return
    const [{ data }, { data: ent }] = await Promise.all([
      supabase.from('payslips').select('*').eq('employee_id', employee.id).order('pay_date', { ascending: false }),
      supabase.from('entities').select('*').eq('id', employee.entity_id).maybeSingle(),
    ])
    setSlips((data ?? []) as Payslip[])
    setEntity((ent as Entity) ?? null)
    setLoading(false)
  }, [employee])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <Spinner />

  const years = [...new Set(slips.map((s) => (s.pay_date ?? s.period_month ?? '').slice(0, 4)).filter(Boolean))]
  const shown = slips.filter((s) => !year || (s.pay_date ?? s.period_month ?? '').startsWith(year))
  const totalNet = shown.reduce((sum, s) => sum + Number(s.net_pay), 0)

  return (
    <div>
      <PageHeader
        title="My Payslips"
        subtitle={`Finalized payslips · ${year || 'all years'} take-home ${money(totalNet)}`}
        actions={
          years.length > 1 && (
            <Select value={year} onChange={(e) => setYear(e.target.value)} className="w-32">
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          )
        }
      />
      {shown.length === 0 ? (
        <Card>
          <EmptyState title="No payslips yet" sub="Payslips appear here once a payroll run that includes you is finalized." />
        </Card>
      ) : (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200/80 bg-white">
          {shown.map((s) => (
            <button
              key={s.id}
              onClick={() => setViewing(s)}
              className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-50"
            >
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-slate-100">
                  <FileText className="size-5 text-slate-500" />
                </div>
                <div>
                  <p className="text-sm font-bold text-ink-900">{runLabel(runFromSlip(s))}</p>
                  <p className="text-xs text-slate-500">Paid {fmtDate(s.pay_date)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {s.run_type === 'thirteenth_month' && <Badge tone="orange">13th month</Badge>}
                <div className="text-right">
                  <p className="text-xs text-slate-400">Net pay</p>
                  <p className="text-lg font-bold text-ink-900">{money(Number(s.net_pay))}</p>
                </div>
                <ChevronRight className="size-4 text-slate-300" />
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title="Payslip" wide>
        {viewing && entity && <PayslipView slip={viewing} run={runFromSlip(viewing)} company={entity} />}
      </Modal>
    </div>
  )
}
