import { useCallback, useEffect, useState } from 'react'
import { History, Plus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, Textarea } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import { getHolidaysBetween } from '../../lib/api'
import type { Holiday, LeaveRequest, LeaveType } from '../../lib/db'
import { fmtDate, plural } from '../../lib/format'
import { leaveDaysInYear, leaveWorkdays, showsBalance } from '../../lib/leave'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'
import { useQuickAction } from '../../lib/quickAction'

export default function MyLeaves() {
  const { employee } = useAuth()
  const toast = useToast()
  const [types, setTypes] = useState<LeaveType[]>([])
  const [requests, setRequests] = useState<LeaveRequest[]>([])
  const [entitlements, setEntitlements] = useState<Record<string, number>>({})
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
          .eq('year', year),
        // this year and next: leave can be filed ahead and across New Year
        getHolidaysBetween(employee.entity_id, `${year}-01-01`, `${year + 1}-12-31`),
      ])
      // a failed read must not show as zero balances
      const failed = tRes.error ?? rRes.error ?? eRes.error
      if (failed) throw failed
      setHolidays(hols)
      setTypes((tRes.data ?? []) as LeaveType[])
      setRequests((rRes.data ?? []) as LeaveRequest[])
      const map: Record<string, number> = {}
      for (const e of eRes.data ?? []) map[e.leave_type_id as string] = Number(e.days)
      setEntitlements(map)
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

  async function submit() {
    if (!employee) return
    const days = workdayCount(form.start, form.end)
    if (!form.type || days <= 0) {
      toast('error', 'Pick a leave type and a valid date range.')
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

  const balanceTypes = types.filter((t) => showsBalance(t, entitlements[t.id]))

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
          return (
            <div key={t.id} className="rounded-xl border border-slate-200/80 bg-white p-4">
              <p className="text-xs font-semibold text-slate-500">{t.name}</p>
              <p className={`mt-1 text-xl font-bold ${left < 0 ? 'text-rose-600' : 'text-ink-900'}`}>
                {left}
                <span className="text-sm font-medium text-slate-400"> / {total} days</span>
              </p>
              {left < 0 && <p className="text-[11px] text-rose-600">{plural(-left, 'day')} beyond your entitlement</p>}
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
                        onClick={() => cancel(r.id)}
                        className="text-xs font-semibold text-slate-400 hover:text-rose-600"
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
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.paid ? '(paid)' : '(unpaid)'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input
                type="date"
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
              />
            </Field>
          </div>
          <p className="text-xs text-slate-500">
            Working days requested: <b>{workdayCount(form.start, form.end)}</b>
          </p>
          <Field label="Reason">
            <Textarea
              rows={3}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
          <Button className="w-full" disabled={busy} onClick={submit}>
            {busy ? 'Submitting…' : 'Submit request'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
