import { useCallback, useEffect, useState } from 'react'
import { History, Plus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import { getHolidaysBetween } from '../../lib/api'
import type { Holiday, LeaveRequest, LeaveType } from '../../lib/db'
import { fmtDate, plural } from '../../lib/format'
import { eligibleFrom, leaveDaysInYear, leaveWorkdays, notYetUsable, showsBalance, usableOn } from '../../lib/leave'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { useQuickAction } from '../../lib/quickAction'

export default function MyLeaves() {
  const { employee } = useAuth()
  const toast = useToast()
  const [types, setTypes] = useState<LeaveType[]>([])
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  // credits HR set, by year then leave type: this year's balances, next year's leaves filed ahead
  const [credits, setCredits] = useState<Record<number, Record<string, number>>>({})
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)

  useQuickAction('leave', () => setOpen(true), !loading)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ type: '', start: todayManila(), end: todayManila(), reason: '' })

  const year = Number(todayManila().slice(0, 4))

  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    if (!employee) return
    setLoadError('')
    try {
      const [tRes, rRes, eRes, hols] = await Promise.all([
        supabase.from('leave_types').select('*').eq('active', true).order('code'),
        supabase
          .from('leave_requests')
          .select('*')
          .eq('employee_id', employee.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('employee_leave_entitlements')
          .select('*')
          .eq('employee_id', employee.id)
          .in('year', [year, year + 1]),
        // this year and next: leave can be filed ahead and across New Year
        getHolidaysBetween(employee.entity_id, `${year}-01-01`, `${year + 1}-12-31`),
      ])
      // a failed read must not show as zero balances
      const failed = tRes.error ?? rRes.error ?? eRes.error
      if (failed) throw failed
      setHolidays(hols)
      setTypes((tRes.data ?? []) as LeaveType[])
      setRequests((rRes.data ?? []) as LeaveRequest[])
      const byYear: Record<number, Record<string, number>> = {}
      for (const e of eRes.data ?? []) {
        const y = Number(e.year)
        byYear[y] = { ...byYear[y], [e.leave_type_id as string]: Number(e.days) }
      }
      setCredits(byYear)
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load your leaves'))
    } finally {
      setLoading(false)
    }
  }, [employee, year])

  useEffect(() => {
    load()
  }, [load])

  /** Leave days charged: scheduled workdays that aren't holidays. */
  function workdayCount(start: string, end: string): number {
    if (!employee) return 0
    return leaveWorkdays(start, end, employee.work_schedule.days, holidays)
  }

  /** Why the picked type can't start on the picked date yet, if it can't. */
  function eligibilityProblem(): string {
    const type = types.find((t) => t.id === form.type)
    if (!employee || !type || !form.start) return ''
    const credit = credits[Number(form.start.slice(0, 4))]?.[type.id]
    if (usableOn(type, employee.hire_date, form.start, credit)) return ''
    return notYetUsable(type, eligibleFrom(type, employee.hire_date)!)
  }

  async function submit() {
    if (!employee) return
    const days = workdayCount(form.start, form.end)
    if (!form.type || days <= 0) {
      toast('error', 'Pick a leave type and a valid date range.')
      return
    }
    const problem = eligibilityProblem()
    if (problem) {
      toast('error', problem)
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase.from('leave_requests').insert({
        employee_id: employee.id,
        leave_type_id: form.type,
        start_date: form.start,
        end_date: form.end,
        days,
        reason: form.reason.trim(),
        status: 'pending',
      })
      if (error) throw error
      toast('success', 'Leave request submitted.')
      setOpen(false)
      setForm({ type: '', start: todayManila(), end: todayManila(), reason: '' })
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed to submit'))
    } finally {
      setBusy(false)
    }
  }

  async function cancel(id: string) {
    const { data, error } = await supabase
      .from('leave_requests')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
    if (error) toast('error', errorMessage(error, 'Could not cancel the request'))
    else if (!data || data.length === 0) toast('error', 'This request was already reviewed — it can no longer be cancelled.')
    else toast('success', 'Request cancelled.')
    await load()
  }

  if (loadError) {
    return (
      <Card>
        <p className="text-sm text-rose-600">
          {loadError}{' '}
          <button type="button" onClick={load} className="font-semibold underline">
            Try again
          </button>
        </p>
      </Card>
    )
  }
  if (loading || !employee) return <Spinner />

  const usedByType: Record<string, number> = {}
  for (const r of requests) {
    if (r.status !== 'approved') continue
    const d = leaveDaysInYear(r, year, employee.work_schedule.days, holidays)
    if (d > 0) usedByType[r.leave_type_id] = (usedByType[r.leave_type_id] ?? 0) + d
  }

  const entitlements = credits[year] ?? {}
  const balanceLeft = (t: LeaveType) => (entitlements[t.id] ?? Number(t.default_annual_days)) - (usedByType[t.id] ?? 0)
  const balanceTypes = types.filter((t) => showsBalance(t, entitlements[t.id]))
  const problem = open ? eligibilityProblem() : ''
  const picked = types.find((t) => t.id === form.type)

  return (
    <div>
      <PageHeader
        title="My Leaves"
        subtitle={`Balances for ${year}`}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Request leave
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {balanceTypes.map((t) => {
          const total = entitlements[t.id] ?? t.default_annual_days
          const used = usedByType[t.id] ?? 0
          const left = total - used // negative = taken beyond the entitlement
          // not usable at all this year (no credits from HR): say when it opens instead of a balance
          const from = eligibleFrom(t, employee.hire_date)
          const opensLater = from && !usableOn(t, employee.hire_date, `${year}-12-31`, entitlements[t.id]) ? from : null
          const opensThisYear = from && !opensLater && !usableOn(t, employee.hire_date, todayManila(), entitlements[t.id]) ? from : null
          if (opensLater) {
            return (
              <div key={t.id} className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
                <p className="text-xs font-semibold text-slate-500">{t.name}</p>
                <p className="mt-1 text-base font-bold text-ink-900">Available {fmtDate(opensLater)}</p>
                <p className="mt-1 text-xs text-slate-500">after {t.min_service_months} months of service</p>
              </div>
            )
          }
          return (
            <div key={t.id} className="rounded-xl border border-slate-200/80 bg-white p-4">
              <p className="text-xs font-semibold text-slate-500">{t.name}</p>
              <p className={`mt-1 text-xl font-bold ${left < 0 ? 'text-rose-600' : 'text-ink-900'}`}>
                {left}
                <span className="text-sm font-medium text-slate-400"> / {total} days</span>
              </p>
              {left < 0 && <p className="text-xs text-rose-600">{plural(-left, 'day')} beyond your entitlement</p>}
              {opensThisYear && <p className="text-xs text-slate-500">usable from {fmtDate(opensThisYear)}</p>}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-600"
                  style={{ width: `${total > 0 ? Math.max(0, (left / total) * 100) : 0}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>

      <Card title="Request history" icon={<History />}>
        {requests.length === 0 ? (
          <EmptyState title="No leave requests yet" />
        ) : (
          <div className="divide-y divide-slate-100">
            {requests.map((r) => {
              const type = types.find((t) => t.id === r.leave_type_id)
              return (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-700">
                      {type?.name ?? 'Leave'} · {plural(Number(r.days), 'day')}
                    </p>
                    <p className="break-words text-xs text-slate-500">
                      {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </p>
                    {r.review_notes && (
                      <p className="break-words text-xs italic text-slate-400">Admin: {r.review_notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        r.status === 'approved'
                          ? 'green'
                          : r.status === 'rejected'
                            ? 'red'
                            : r.status === 'pending'
                              ? 'amber'
                              : 'slate'
                      }
                    >
                      {r.status}
                    </Badge>
                    {r.status === 'pending' && (
                      <button
                        type="button"
                        onClick={() => cancel(r.id)}
                        className="-my-2 rounded-lg px-2 py-2 text-xs font-semibold text-slate-600 hover:bg-rose-50 hover:text-rose-600"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Request leave">
        <div className="space-y-4">
          <Field label="Leave type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="">Select…</option>
              {types.map((t) => {
                const from = eligibleFrom(t, employee.hire_date)
                const later = from && !usableOn(t, employee.hire_date, todayManila(), entitlements[t.id])
                return (
                  <option key={t.id} value={t.id}>
                    {t.name} {t.paid ? '(paid)' : '(unpaid)'}
                    {later ? ` — from ${fmtDate(from)}` : ''}
                  </option>
                )
              })}
            </Select>
          </Field>
          {/* one column on phones: two native date pickers side by side overflow a narrow dialog */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">
              <Input
                type="date"
                value={form.start}
                onChange={(e) => {
                  const start = e.target.value
                  // keep the range valid: moving the start past the end moves the end along
                  setForm({ ...form, start, end: start && form.end < start ? start : form.end })
                }}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={form.end}
                min={form.start || undefined}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </Field>
          </div>
          {problem ? (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {problem}
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Working days requested: <b>{workdayCount(form.start, form.end)}</b>
              {picked && showsBalance(picked, entitlements[picked.id]) && (
                <> · {balanceLeft(picked) > 0 ? `${plural(balanceLeft(picked), 'day')} left this year` : 'no days left this year'}</>
              )}
            </p>
          )}
          <Field label="Reason">
            <Textarea
              rows={3}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
          <Button className="w-full" disabled={busy || !!problem} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit request'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
