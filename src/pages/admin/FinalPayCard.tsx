// "Final pay still due" on the payroll that holds a separation: the 13th
// month pay to the last day (a 13th month run for the leaver, once this
// payroll is final: its basic pay counts) and the leave left (added here as
// leave converted to cash). The amounts come from computeRun
// (computation_trace.finalPay, src/payroll/finalPay.ts).

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarCheck, Plus } from 'lucide-react'
import { Badge, Button, Card } from '../../components/ui'
import { useToast } from '../../components/toast'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { fmtDate, money } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import type { Payslip, PayrollAdjustment, PayrollRun } from '../../lib/db'
import type { PayslipComputation } from '../../payroll/types'
import { round2 } from '../../payroll/types'

type FinalPay = NonNullable<PayslipComputation['trace']['finalPay']>

/** "Service Incentive Leave converted to cash (3 day/s)": also how an added conversion is recognized. */
const conversionLabel = (name: string, days: number) => `${name} converted to cash (${days} day/s)`

export function FinalPayCard({
  run,
  slips,
  adjustments,
  onChanged,
}: {
  run: PayrollRun
  slips: Payslip[]
  adjustments: PayrollAdjustment[]
  onChanged: () => void
}) {
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState('')
  // 13th month runs already made for these leavers (draft or posted), by employee
  const [made, setMade] = useState<Record<string, string>>({})
  const due = slips
    .map((s) => ({ slip: s, fp: (s.computation_trace as { finalPay?: FinalPay } | null)?.finalPay }))
    .filter((x): x is { slip: Payslip; fp: FinalPay } => !!x.fp)
  const isDraft = run.status === 'draft'
  const ids = due.map((x) => x.slip.employee_id).join(',')

  useEffect(() => {
    if (!ids) return
    let stale = false
    supabase
      .from('payroll_runs')
      .select('id, employee_ids')
      .eq('entity_id', run.entity_id)
      .eq('run_type', 'thirteenth_month')
      .overlaps('employee_ids', ids.split(','))
      .then(({ data }) => {
        if (stale) return
        const m: Record<string, string> = {}
        for (const r of (data ?? []) as { id: string; employee_ids: string[] | null }[]) for (const e of r.employee_ids ?? []) m[e] = r.id
        setMade(m)
      })
    return () => {
      stale = true
    }
  }, [ids, run.entity_id])

  if (due.length === 0) return null

  async function addConversion(slip: Payslip, l: FinalPay['leave'][number]) {
    const daily = Number((slip.computation_trace as { dailyRate?: number }).dailyRate ?? 0)
    setBusy(`${slip.employee_id}:${l.typeId}`)
    try {
      const { error } = await supabase.from('payroll_adjustments').insert({
        payroll_run_id: run.id,
        employee_id: slip.employee_id,
        kind: 'earning',
        label: conversionLabel(l.name, l.days),
        amount: round2(daily * l.days),
        category: 'de_minimis',
        de_minimis_kind: 'monetized_vl',
        leave_days: l.days,
      })
      if (error) throw error
      toast('success', 'Leave conversion added — recompute the draft.')
      onChanged()
    } catch (err) {
      toast('error', errorMessage(err, 'Could not add the leave conversion'))
    } finally {
      setBusy('')
    }
  }

  async function createThirteenth(slip: Payslip, fp: FinalPay) {
    const sep = fp.separationDate
    const today = todayManila()
    setBusy(`${slip.employee_id}:13`)
    try {
      const { data, error } = await supabase
        .from('payroll_runs')
        .insert({
          entity_id: run.entity_id,
          run_type: 'thirteenth_month',
          pay_frequency: null,
          period_start: `${sep.slice(0, 4)}-01-01`,
          // ending on the last day: the 13th month counts in the separation month's SSS
          period_end: sep,
          pay_date: run.pay_date > today ? run.pay_date : today,
          period_month: `${sep.slice(0, 7)}-01`,
          period_index: 1,
          periods_in_month: 1,
          annualize: false,
          employee_ids: [slip.employee_id],
          status: 'draft',
        })
        .select('id')
        .single()
      if (error) throw error
      toast('success', '13th month run created — compute it, check it and finalize.')
      navigate(`/admin/payroll/${data.id}`)
    } catch (err) {
      toast('error', errorMessage(err, 'Could not create the 13th month run'))
    } finally {
      setBusy('')
    }
  }

  return (
    <Card title="Final pay still due" icon={<CalendarCheck />}>
      <p className="mb-3 text-sm text-slate-600">
        Final pay is due within 30 days of the last day (DOLE Labor Advisory 06-20): the 13th month pay to the last day
        (PD 851) and leave credits left — unused service incentive leave converts to cash (Labor Code Art. 95), other
        leave as company policy says.
      </p>
      <div className="divide-y divide-slate-100">
        {due.map(({ slip, fp }) => {
          const name = String((slip.employee_snapshot as Record<string, unknown>).name ?? '')
          const daily = Number((slip.computation_trace as { dailyRate?: number }).dailyRate ?? 0)
          return (
            <div key={slip.employee_id} className="space-y-2 py-3 text-sm">
              <p className="font-semibold text-ink-900">
                {name} <span className="font-normal text-slate-500">· last day {fmtDate(fp.separationDate)}</span>
              </p>
              {fp.thirteenth > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    13th month pay to the last day <b>{money(fp.thirteenth)}</b>
                  </span>
                  {made[slip.employee_id] ? (
                    <Button variant="secondary" onClick={() => navigate(`/admin/payroll/${made[slip.employee_id]}`)}>
                      Open its 13th month run
                    </Button>
                  ) : isDraft ? (
                    <span className="text-xs text-slate-500">Finalize this payroll first: its basic pay counts.</span>
                  ) : (
                    <Button variant="secondary" disabled={!!busy} onClick={() => createThirteenth(slip, fp)}>
                      <Plus className="size-4" /> Create 13th month run
                    </Button>
                  )}
                </div>
              )}
              {fp.leave.map((l) => {
                const added = adjustments.some((a) => a.employee_id === slip.employee_id && a.label === conversionLabel(l.name, l.days))
                return (
                  <div key={l.typeId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {l.name}: {l.days} day/s left{' '}
                      <span className="text-slate-500">({money(round2(daily * l.days))} at {money(daily)} a day)</span>{' '}
                      {l.code !== 'SIL' && <Badge tone="slate">company policy</Badge>}
                    </span>
                    {added ? (
                      <Badge tone="green">added</Badge>
                    ) : isDraft ? (
                      <Button variant="secondary" disabled={!!busy} onClick={() => addConversion(slip, l)}>
                        <Plus className="size-4" /> Add conversion
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-500">Pay it on a final pay run for {name.split(' ')[0]} (Pay Runs → New run → Final pay): this card offers it there.</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </Card>
  )
}
