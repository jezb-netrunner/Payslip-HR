import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, FilePen, Plus } from 'lucide-react'
import AttendanceTimeline, { type TimelineLeave } from '../../components/AttendanceTimeline'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Spinner,
  StatCard,
  StatGroup,
  TableShell,
  Td,
  Textarea,
  Th,
} from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Holiday, TimeCorrectionRequest, TimeEntry } from '../../lib/db'
import { fmtDate, fmtHours, fmtTime, plural } from '../../lib/format'
import { endOfMonth, manilaDateStr, manilaHHMM, manilaWallToIso, todayManila } from '../../lib/manila'
import { getHolidaysBetween } from '../../lib/api'
import { supabase } from '../../lib/supabase'
import { dayTimeline } from '../../lib/timeline'
import { errorMessage } from '../../lib/errors'
import { useQuickAction } from '../../lib/quickAction'

export default function MyAttendance() {
  const { employee } = useAuth()
  const toast = useToast()
  const [entries, setEntries] = useState<TimeEntry[]>([])
  const [requests, setRequests] = useState<TimeCorrectionRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [monthStr, setMonthStr] = useState(todayManila().slice(0, 7))
  const [correcting, setCorrecting] = useState<{ entry: TimeEntry | null } | null>(null)
  const [form, setForm] = useState({ work_date: '', in: '', out: '', reason: '' })
  const [busy, setBusy] = useState(false)
  const [leaves, setLeaves] = useState<TimelineLeave[]>([])
  const [view, setView] = useState<'timeline' | 'list'>('timeline')
  const [graceMinutes, setGraceMinutes] = useState(0)
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const seq = useRef(0)

  useQuickAction('correction', () => openCorrection(null))

  const load = useCallback(async () => {
    if (!employee) return
    // quick month changes: only the latest request may fill the page
    const my = ++seq.current
    setLoading(true)
    const start = `${monthStr}-01`
    const end = endOfMonth(start)
    const [{ data: ent }, { data: reqs }, { data: lv }, { data: client }, hol] = await Promise.all([
      supabase
        .from('time_entries')
        .select('*')
        .eq('employee_id', employee.id)
        .gte('work_date', start)
        .lte('work_date', end)
        .order('clock_in', { ascending: false }),
      supabase
        .from('time_correction_requests')
        .select('*')
        .eq('employee_id', employee.id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase
        .from('leave_requests')
        .select('start_date, end_date, leave_types(name)')
        .eq('employee_id', employee.id)
        .eq('status', 'approved')
        .lte('start_date', end)
        .gte('end_date', start),
      // "late" on the timeline follows payroll: an ordinary working day (not a
      // non-working holiday), after the shift start plus the client's grace period
      supabase.from('entities').select('grace_period_minutes').eq('id', employee.entity_id).maybeSingle(),
      getHolidaysBetween(employee.entity_id, start, end).catch(() => [] as Holiday[]),
    ])
    if (my !== seq.current) return
    setGraceMinutes(Number(client?.grace_period_minutes) || 0)
    setHolidays(hol)
    setEntries((ent ?? []) as TimeEntry[])
    setRequests((reqs ?? []) as TimeCorrectionRequest[])
    setLeaves(
      ((lv ?? []) as unknown as { start_date: string; end_date: string; leave_types: { name: string } | null }[]).map((l) => ({
        start_date: l.start_date,
        end_date: l.end_date,
        label: l.leave_types?.name ?? 'Leave',
      })),
    )
    setLoading(false)
  }, [employee, monthStr])

  useEffect(() => {
    load()
  }, [load])

  function openCorrection(entry: TimeEntry | null) {
    setCorrecting({ entry })
    setForm({
      work_date: entry?.work_date ?? todayManila(),
      in: entry ? toLocalInput(entry.clock_in) : '',
      out: entry?.clock_out ? toLocalInput(entry.clock_out) : '',
      reason: '',
    })
  }

  async function submitCorrection() {
    if (!employee || !correcting) return
    if (!form.reason.trim()) {
      toast('error', 'Please state the reason for the correction.')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase.from('time_correction_requests').insert({
        employee_id: employee.id,
        time_entry_id: correcting.entry?.id ?? null,
        work_date: form.work_date,
        requested_clock_in: form.in ? manilaLocalToIso(form.in) : null,
        requested_clock_out: form.out ? manilaLocalToIso(form.out) : null,
        reason: form.reason.trim(),
        status: 'pending',
      })
      if (error) throw error
      toast('success', 'Correction request filed for admin review.')
      setCorrecting(null)
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed to file request'))
    } finally {
      setBusy(false)
    }
  }

  async function cancelRequest(id: string) {
    const { data, error } = await supabase
      .from('time_correction_requests')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')
    if (error) toast('error', errorMessage(error, 'Could not cancel the request'))
    else if (!data || data.length === 0) toast('error', 'This request was already reviewed — it can no longer be cancelled.')
    else toast('success', 'Request cancelled.')
    await load()
  }

  if (!employee) return <Spinner />

  const totalMinutes = entries
    .filter((e) => e.clock_out)
    .reduce((s, e) => s + (new Date(e.clock_out!).getTime() - new Date(e.clock_in).getTime()) / 60000, 0)
  const monthStart = `${monthStr}-01`
  const days = [...new Set(entries.map((e) => e.work_date))]
  const lateDays = days.filter(
    (d) =>
      dayTimeline(
        d,
        entries.filter((e) => e.work_date === d),
        employee.work_schedule,
        { graceMinutes, holiday: holidays.some((h) => h.holiday_date === d && h.kind !== 'special_working') },
      ).late,
  ).length
  const openEntries = entries.filter((e) => !e.clock_out).length

  return (
    <div>
      <PageHeader
        title="My Attendance"
        subtitle="Your time entries are read-only; request a correction if something is wrong."
        actions={
          <>
            <Input
              type="month"
              value={monthStr}
              onChange={(e) => setMonthStr(e.target.value)}
              className="w-40"
            />
            <Button variant="secondary" onClick={() => openCorrection(null)}>
              <Plus className="size-4" /> Missing entry
            </Button>
          </>
        }
      />

      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-6">
          <StatGroup>
            <StatCard label="Days recorded" value={days.length} sub={`${plural(entries.length, 'entry', 'entries')}`} />
            <StatCard label="Hours on record" value={fmtHours(totalMinutes)} />
            <StatCard label="Late time in" value={lateDays} tone={lateDays > 0 ? 'warn' : 'default'} sub="workdays, after the shift start and grace period" />
            <StatCard label="No time out" value={openEntries} tone={openEntries > 0 ? 'warn' : 'default'} />
            <StatCard label="Pending corrections" value={requests.filter((r) => r.status === 'pending').length} />
          </StatGroup>

          <Card
            title="Time entries"
            icon={<Clock />}
            actions={
              <Segmented
                label="Show entries as"
                value={view}
                onChange={setView}
                options={[
                  { key: 'timeline', label: 'Timeline' },
                  { key: 'list', label: 'List' },
                ]}
              />
            }
          >
            {view === 'timeline' ? (
              <AttendanceTimeline
                entries={entries}
                schedule={employee.work_schedule}
                graceMinutes={graceMinutes}
                holidays={holidays}
                leaves={leaves}
                from={monthStart}
                to={endOfMonth(monthStart)}
                today={todayManila()}
                emptyTitle="No entries this month"
                onRequestFix={(e) => openCorrection(e)}
              />
            ) : entries.length === 0 ? (
              <EmptyState title="No entries this month" />
            ) : (
              <TableShell>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>In</Th>
                    <Th>Out</Th>
                    <Th>Duration</Th>
                    <Th>Flags</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap font-semibold">{fmtDate(e.work_date)}</Td>
                      <Td className="whitespace-nowrap">{fmtTime(e.clock_in)}</Td>
                      <Td className="whitespace-nowrap">{e.clock_out ? fmtTime(e.clock_out) : <Badge tone="green">open</Badge>}</Td>
                      <Td className="whitespace-nowrap">
                        {e.clock_out
                          ? fmtHours((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000)
                          : '—'}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {e.manually_edited && <Badge tone="violet">corrected</Badge>}
                          {e.flags.filter((f) => f !== 'corrected').map((f) => (
                            <Badge key={f} tone="amber">{f.replaceAll('_', ' ')}</Badge>
                          ))}
                        </div>
                      </Td>
                      <Td>
                        <button
                          type="button"
                          className="flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-brand-700 hover:text-brand-800"
                          onClick={() => openCorrection(e)}
                        >
                          <FilePen className="size-3.5" /> Request fix
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableShell>
            )}
          </Card>

          <Card title="My correction requests" icon={<FilePen />}>
            {requests.length === 0 ? (
              <EmptyState title="No correction requests" />
            ) : (
              <div className="divide-y divide-slate-100">
                {requests.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-700">
                        {fmtDate(r.work_date)}{' '}
                        <span className="font-normal text-slate-500">
                          {r.requested_clock_in ? fmtTime(r.requested_clock_in) : '—'} →{' '}
                          {r.requested_clock_out ? fmtTime(r.requested_clock_out) : '—'}
                        </span>
                      </p>
                      <p className="break-words text-xs text-slate-500">{r.reason}</p>
                      {r.review_notes && (
                        <p className="break-words text-xs italic text-slate-400">Admin: {r.review_notes}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        tone={
                          r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'amber' : 'slate'
                        }
                      >
                        {r.status}
                      </Badge>
                      {r.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => cancelRequest(r.id)}
                          className="text-xs font-semibold text-rose-600 hover:text-rose-800"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      <Modal
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        title={correcting?.entry ? 'Request a time correction' : 'Report a missing entry'}
      >
        <div className="space-y-4">
          <Field label="Work date">
            <Input
              type="date"
              value={form.work_date}
              onChange={(e) => setForm({ ...form, work_date: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Correct clock in">
              <Input
                type="datetime-local"
                value={form.in}
                onChange={(e) => setForm({ ...form, in: e.target.value })}
              />
            </Field>
            <Field label="Correct clock out">
              <Input
                type="datetime-local"
                value={form.out}
                onChange={(e) => setForm({ ...form, out: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Reason" hint="Corrections are reviewed and logged; the original punch stays on record.">
            <Textarea
              rows={3}
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="e.g. Forgot to clock out — actual end of shift was 6:10 PM"
            />
          </Field>
          <Button className="w-full" disabled={busy} onClick={submitCorrection}>
            {busy ? 'Filing…' : 'File correction request'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

/** ISO timestamptz -> value for datetime-local input, in Manila time. */
function toLocalInput(iso: string): string {
  return `${manilaDateStr(new Date(iso))}T${manilaHHMM(iso)}`
}

/** datetime-local value (interpreted as Manila wall time) -> ISO instant. */
function manilaLocalToIso(v: string): string {
  return manilaWallToIso(v.slice(0, 10), v.slice(11, 16))
}
