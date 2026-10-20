import { useCallback, useEffect, useState } from 'react'
import { Briefcase, TrendingUp } from 'lucide-react'
import { Badge, Card, PageHeader, Spinner } from '../../components/ui'
import { useAuth } from '../../lib/auth'
import type { CareerEvent } from '../../lib/db'
import { fmtDate, fullName, money } from '../../lib/format'
import {
  EMPLOYMENT_STATUS_LABELS,
  FREQUENCY_LABELS,
  PAYMENT_METHOD_LABELS,
  SEPARATION_REASON_LABELS,
} from '../../lib/labels'
import { supabase } from '../../lib/supabase'

const eventLabels: Record<string, string> = {
  hired: 'Hired',
  regularized: 'Regularized',
  promoted: 'Promoted',
  transferred: 'Transferred',
  salary_adjustment: 'Salary Adjustment',
  disciplinary: 'Disciplinary Action',
  recognition: 'Recognition',
  separated: 'Separated',
  other: 'Note',
}

export default function MyProfile() {
  const { employee } = useAuth()
  const [events, setEvents] = useState<CareerEvent[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!employee) return
    const { data } = await supabase
      .from('career_events')
      .select('*')
      .eq('employee_id', employee.id)
      .order('effective_date', { ascending: false })
    setEvents((data ?? []) as CareerEvent[])
    setLoading(false)
  }, [employee])

  useEffect(() => {
    load()
  }, [load])

  if (!employee || loading) return <Spinner />

  const endDate = employee.separation_date ? new Date(employee.separation_date) : new Date()
  const tenureYears = (endDate.getTime() - new Date(employee.hire_date).getTime()) / (365.25 * 24 * 3600 * 1000)

  const rows: [string, React.ReactNode][] = [
    ['Employee No.', employee.employee_no],
    ['Position', employee.position || '—'],
    ['Department', employee.department || '—'],
    ['Employment status', <Badge key="s" tone="blue">{EMPLOYMENT_STATUS_LABELS[employee.employment_status]}</Badge>],
    ['Date started', `${fmtDate(employee.hire_date)} (${tenureYears.toFixed(1)} yrs)`],
    ['Regularized', employee.regularization_date ? fmtDate(employee.regularization_date) : '—'],
    ...(employee.separation_date
      ? ([
          [
            'Separated',
            `${fmtDate(employee.separation_date)}${employee.separation_reason ? ` — ${SEPARATION_REASON_LABELS[employee.separation_reason]}` : ''}`,
          ],
        ] as [string, React.ReactNode][])
      : []),
    [
      'Pay',
      employee.pay_type === 'monthly'
        ? `${money(Number(employee.monthly_rate))} / month`
        : `${money(Number(employee.daily_rate))} / day`,
    ],
    ['Paid', `${FREQUENCY_LABELS[employee.pay_frequency]} · ${PAYMENT_METHOD_LABELS[employee.payment_method]}`],
    ['Work schedule', `${employee.work_schedule.start}–${employee.work_schedule.end}, break ${employee.work_schedule.break_minutes}m`],
    ['TIN', employee.tin ?? '—'],
    ['SSS No.', employee.sss_no ?? '—'],
    ['PhilHealth No.', employee.philhealth_no ?? '—'],
    ['Pag-IBIG No.', employee.pagibig_no ?? '—'],
    ['Phone', employee.phone ?? '—'],
    ['Address', employee.address ?? '—'],
  ]

  return (
    <div>
      <PageHeader title="My Profile" subtitle={fullName(employee)} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><Briefcase className="size-4" /> Employment record</span>}>
          <dl className="divide-y divide-slate-100">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 py-2">
                <dt className="text-xs font-semibold text-slate-500">{k}</dt>
                <dd className="text-right text-sm text-slate-700">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-slate-400">
            Something wrong? Tell your HR or payroll officer — records are maintained by the company.
          </p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><TrendingUp className="size-4" /> Career history</span>}>
          {events.length === 0 ? (
            <p className="text-sm text-slate-400">No recorded events yet.</p>
          ) : (
            <ol className="relative ml-2 space-y-5 border-l-2 border-brand-100 pl-5">
              {events.map((ev) => (
                <li key={ev.id} className="relative">
                  <span className="absolute -left-[27px] top-1 size-3 rounded-full border-2 border-white bg-accent-500" />
                  <p className="text-xs font-semibold text-slate-400">{fmtDate(ev.effective_date)}</p>
                  <p className="text-sm font-bold text-slate-800">
                    {eventLabels[ev.event_type] ?? ev.event_type}
                    {ev.position ? ` — ${ev.position}` : ''}
                  </p>
                  {(ev.department || ev.monthly_rate || ev.daily_rate) && (
                    <p className="text-xs text-slate-500">
                      {[
                        ev.department,
                        ev.monthly_rate ? `${money(Number(ev.monthly_rate))}/mo` : null,
                        ev.daily_rate ? `${money(Number(ev.daily_rate))}/day` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                  {ev.details && <p className="mt-0.5 text-xs text-slate-500">{ev.details}</p>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </div>
  )
}
