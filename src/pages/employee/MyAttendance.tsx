import { useCallback, useEffect, useState } from 'react'
import { FilePen, Plus } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Spinner, TableShell, Td, Textarea, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { TimeCorrectionRequest, TimeEntry } from '../../lib/db'
import { fmtDate, fmtHours, fmtTime } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

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

  const load = useCallback(async () => {
    if (!employee) return
    setLoading(true)
    const start = `${monthStr}-01`
    const end = `${monthStr}-31`
    const [{ data: ent }, { data: reqs }] = await Promise.all([
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
    ])
    setEntries((ent ?? []) as TimeEntry[])
    setRequests((reqs ?? []) as TimeCorrectionRequest[])
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
      toast('error', err instanceof Error ? err.message : 'Failed to file request')
    } finally {
      setBusy(false)
    }
  }

  if (!employee) return <Spinner />

  const totalMinutes = entries
    .filter((e) => e.clock_out)
    .reduce((s, e) => s + (new Date(e.clock_out!).getTime() - new Date(e.clock_in).getTime()) / 60000, 0)

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
          <Card title={`Entries — ${entries.length} punch/es · ${fmtHours(totalMinutes)} total`}>
            {entries.length === 0 ? (
              <EmptyState title="No entries this month" />
            ) : (
              <TableShell>
                <thead className="bg-slate-50">
                  <tr>
                    <Th>Date</Th>
                    <Th>In</Th>
                    <Th>Out</Th>
                    <Th>Duration</Th>
                    <Th>Flags</Th>
                    <Th></Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {entries.map((e) => (
                    <tr key={e.id} className="hover:bg-slate-50">
                      <Td className="font-semibold">{fmtDate(e.work_date)}</Td>
                      <Td>{fmtTime(e.clock_in)}</Td>
                      <Td>{e.clock_out ? fmtTime(e.clock_out) : <Badge tone="green">open</Badge>}</Td>
                      <Td>
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
                          className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
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

          <Card title="My correction requests">
            {requests.length === 0 ? (
              <EmptyState title="No correction requests" />
            ) : (
              <div className="divide-y divide-slate-100">
                {requests.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div>
                      <p className="text-sm font-semibold text-slate-700">
                        {fmtDate(r.work_date)}{' '}
                        <span className="font-normal text-slate-500">
                          {r.requested_clock_in ? fmtTime(r.requested_clock_in) : '—'} →{' '}
                          {r.requested_clock_out ? fmtTime(r.requested_clock_out) : '—'}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500">{r.reason}</p>
                      {r.review_notes && (
                        <p className="text-xs italic text-slate-400">Admin: {r.review_notes}</p>
                      )}
                    </div>
                    <Badge
                      tone={
                        r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'amber' : 'slate'
                      }
                    >
                      {r.status}
                    </Badge>
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
          <div className="grid grid-cols-2 gap-3">
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
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 16)
}

/** datetime-local value (interpreted as Manila wall time) -> ISO instant. */
function manilaLocalToIso(v: string): string {
  return new Date(new Date(`${v}:00Z`).getTime() - 8 * 60 * 60 * 1000).toISOString()
}
