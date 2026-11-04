// Pay changes of a year for the selected client: every rate change that took
// effect in it (not hire rates, not corrections), from what to what, and the
// change in monthly payroll cost.

import { useEffect, useMemo, useState } from 'react'
import { Download, TrendingUp } from 'lucide-react'
import { Button, Card, LoadFailed } from '../../components/ui'
import type { EmployeePayRate, Entity } from '../../lib/db'
import { downloadCsv } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fetchAll } from '../../lib/fetchAll'
import { fmtDate, money } from '../../lib/format'
import { PAY_RATE_REASON_LABELS } from '../../lib/labels'
import { rateText } from '../../lib/payHistory'
import { supabase } from '../../lib/supabase'
import { changesBetween } from '../../payroll/payRates'
import { useReportStamp } from '../../lib/useReportStamp'

interface Person {
  id: string
  first_name: string
  last_name: string
  employee_no: string
  days_per_year: number | null
}

export function PayChanges({ entity, year }: { entity: Entity; year: number }) {
  const stamp = useReportStamp(entity)
  const [data, setData] = useState<{ rates: EmployeePayRate[]; people: Person[] } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setLoadError('')
    Promise.all([
      fetchAll<EmployeePayRate>((from, to) =>
        supabase.from('employee_pay_rates').select('*').eq('entity_id', entity.id).order('id').range(from, to),
      ),
      fetchAll<Person>((from, to) =>
        supabase.from('employees').select('id, first_name, last_name, employee_no, days_per_year').eq('entity_id', entity.id).order('id').range(from, to),
      ),
    ])
      .then(([rates, people]) => {
        if (!cancelled) setData({ rates, people })
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, 'Failed to load'))
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, reload])

  const rows = useMemo(() => {
    if (!data) return []
    const byEmployee = new Map<string, EmployeePayRate[]>()
    for (const r of data.rates) byEmployee.set(r.employee_id, [...(byEmployee.get(r.employee_id) ?? []), r])
    return data.people
      .flatMap((p) =>
        changesBetween(byEmployee.get(p.id) ?? [], `${year}-01-01`, `${year}-12-31`, Number(p.days_per_year ?? entity.working_days_divisor)).map((c) => ({
          person: p,
          ...c,
        })),
      )
      .sort((a, b) => a.row.effective_from.localeCompare(b.row.effective_from) || a.person.last_name.localeCompare(b.person.last_name))
  }, [data, year, entity.working_days_divisor])

  if (loadError) return <LoadFailed message={loadError} onRetry={() => setReload((n) => n + 1)} />

  const raises = rows.filter((r) => r.monthlyChange > 0)
  const people = new Set(rows.map((r) => r.person.id)).size
  const avgPct = raises.length > 0 ? raises.reduce((s, r) => s + (r.pct ?? 0), 0) / raises.length : 0
  const costChange = rows.reduce((s, r) => s + r.monthlyChange, 0)
  const name = (p: Person) => `${p.last_name}, ${p.first_name}`

  function exportCsv() {
    downloadCsv(`pay-changes-${entity.code}-${year}.csv`, [
      ['Employee no.', 'Employee', 'Effective', 'Reason', 'From', 'To', 'Change', 'Change %', 'Monthly cost change', 'Approved by', 'Note'],
      ...rows.map((r) => [
        r.person.employee_no,
        name(r.person),
        r.row.effective_from,
        PAY_RATE_REASON_LABELS[r.row.reason],
        rateText(r.previous),
        rateText(r.row),
        r.change ?? '',
        r.pct ?? '',
        r.monthlyChange,
        r.row.approved_by,
        r.row.note,
      ]),
    ], stamp(`Pay changes ${year}`))
  }

  return (
    <Card
      title={`Pay changes in ${year}`}
      icon={<TrendingUp />}
      actions={
        rows.length > 0 && (
          <Button size="sm" variant="secondary" onClick={exportCsv}>
            <Download className="size-4" /> CSV
          </Button>
        )
      }
    >
      {!data ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">No pay rate changed in {year}. Rates are recorded on each employee's Pay History tab.</p>
      ) : (
        <>
          <dl className="mb-4 grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-slate-500">Changes</dt>
              <dd className="font-semibold text-ink-900">{rows.length} for {people} employee{people === 1 ? '' : 's'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Average increase</dt>
              <dd className="font-semibold text-ink-900">{raises.length > 0 ? `${avgPct.toFixed(1)}% (${raises.length} increase${raises.length === 1 ? '' : 's'})` : '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Monthly payroll cost change</dt>
              <dd className="font-semibold text-ink-900">{costChange >= 0 ? '+' : '−'}{money(Math.abs(costChange))} a month</dd>
            </div>
          </dl>
          <div className="scroll-thin overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="py-1.5 pr-4 font-semibold">Employee</th>
                  <th className="py-1.5 pr-4 font-semibold">Effective</th>
                  <th className="py-1.5 pr-4 font-semibold">Reason</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">From</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">To</th>
                  <th className="py-1.5 pr-4 text-right font-semibold">Change</th>
                  <th className="py-1.5 font-semibold">Approved by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.row.id}>
                    <td className="py-2 pr-4 text-slate-700">
                      {name(r.person)} <span className="text-xs text-slate-400">{r.person.employee_no}</span>
                    </td>
                    <td className="whitespace-nowrap py-2 pr-4 text-slate-700">{fmtDate(r.row.effective_from)}</td>
                    <td className="py-2 pr-4 text-slate-700">{PAY_RATE_REASON_LABELS[r.row.reason]}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-600">{rateText(r.previous)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-ink-900">{rateText(r.row)}</td>
                    <td className="whitespace-nowrap py-2 pr-4 text-right tabular-nums text-slate-600">
                      {r.pct !== undefined ? `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%` : ''}
                    </td>
                    <td className="py-2 text-slate-600">{r.row.approved_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">Monthly cost compares monthly amounts: a daily rate × the days-per-year factor ÷ 12.</p>
        </>
      )}
    </Card>
  )
}
