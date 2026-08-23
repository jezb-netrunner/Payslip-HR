import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Eye, Plus, XCircle } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Tabs, Td, Textarea, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { getEmployees, signedSelfieUrl } from '../../lib/api'
import type { Employee, TimeCorrectionRequest, TimeEntry } from '../../lib/db'
import { fmtDate, fmtDateTime, fmtHours, fmtTime, fullName } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

type EntryWithEmployee = TimeEntry & { employees: Employee }
type RequestWithEmployee = TimeCorrectionRequest & { employees: Employee }

export default function Attendance() {
  const toast = useToast()
  const [tab, setTab] = useState('today')
  const [entries, setEntries] = useState<EntryWithEmployee[]>([])
  const [requests, setRequests] = useState<RequestWithEmployee[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [from, setFrom] = useState(todayManila())
  const [to, setTo] = useState(todayManila())
  const [reviewing, setReviewing] = useState<EntryWithEmployee | null>(null)
  const [addingManual, setAddingManual] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: ent }, { data: reqs }, emps] = await Promise.all([
      supabase
        .from('time_entries')
        .select('*, employees(*)')
        .gte('work_date', tab === 'today' ? todayManila() : from)
        .lte('work_date', tab === 'today' ? todayManila() : to)
        .order('clock_in', { ascending: false }),
      supabase
        .from('time_correction_requests')
        .select('*, employees(*)')
        .order('created_at', { ascending: false })
        .limit(50),
      getEmployees(true),
    ])
    setEntries((ent ?? []) as EntryWithEmployee[])
    setRequests((reqs ?? []) as RequestWithEmployee[])
    setEmployees(emps)
    setLoading(false)
  }, [tab, from, to])

  useEffect(() => {
    load()
  }, [load])

  const flagged = entries.filter((e) => e.flags.filter((f) => f !== 'corrected').length > 0)
  const pendingReqs = requests.filter((r) => r.status === 'pending')
  const clockedIn = entries.filter((e) => !e.clock_out)

  async function reviewRequest(id: string, approve: boolean, notes: string) {
    const { error } = await supabase.rpc('review_time_correction', {
      p_request_id: id,
      p_approve: approve,
      p_notes: notes || null,
    })
    if (error) toast('error', error.message)
    else {
      toast('success', approve ? 'Correction applied.' : 'Request rejected.')
      await load()
    }
  }

  return (
    <div>
      <PageHeader
        title="Time & Attendance"
        subtitle="Server-timestamped punches with selfie, device and location verification"
        actions={
          <Button variant="secondary" onClick={() => setAddingManual(true)}>
            <Plus className="size-4" /> Manual entry
          </Button>
        }
      />

      <Tabs
        tabs={[
          { key: 'today', label: `Today (${clockedIn.length} in)` },
          { key: 'range', label: 'Date range' },
          { key: 'flagged', label: 'Flagged', count: flagged.length },
          { key: 'corrections', label: 'Corrections', count: pendingReqs.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'range' && (
        <div className="mb-4 flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
          <span className="text-slate-400">→</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : tab === 'corrections' ? (
        <CorrectionsList requests={requests} onReview={reviewRequest} />
      ) : (
        <EntriesTable
          entries={tab === 'flagged' ? flagged : entries}
          onReview={setReviewing}
        />
      )}

      <ReviewModal entry={reviewing} onClose={() => setReviewing(null)} onChanged={load} />
      <ManualEntryModal
        open={addingManual}
        employees={employees}
        onClose={() => setAddingManual(false)}
        onSaved={async () => {
          setAddingManual(false)
          await load()
        }}
      />
    </div>
  )
}

function EntriesTable({
  entries,
  onReview,
}: {
  entries: EntryWithEmployee[]
  onReview: (e: EntryWithEmployee) => void
}) {
  if (entries.length === 0)
    return (
      <Card>
        <EmptyState title="No time entries" sub="Punches appear here as employees clock in." />
      </Card>
    )
  return (
    <TableShell>
      <thead className="bg-slate-50">
        <tr>
          <Th>Employee</Th>
          <Th>Date</Th>
          <Th>In</Th>
          <Th>Out</Th>
          <Th>Hours</Th>
          <Th>Verification</Th>
          <Th></Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {entries.map((e) => (
          <tr key={e.id} className="hover:bg-slate-50">
            <Td className="font-semibold">{e.employees ? fullName(e.employees) : '—'}</Td>
            <Td>{fmtDate(e.work_date)}</Td>
            <Td>{fmtTime(e.clock_in)}</Td>
            <Td>{e.clock_out ? fmtTime(e.clock_out) : <Badge tone="green">on the clock</Badge>}</Td>
            <Td>
              {e.clock_out
                ? fmtHours((new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime()) / 60000)
                : '—'}
            </Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {e.manually_edited && <Badge tone="violet">corrected</Badge>}
                {e.source === 'admin' && <Badge tone="blue">admin</Badge>}
                {e.flags.filter((f) => f !== 'corrected').length === 0 && !e.manually_edited ? (
                  <Badge tone="green">verified</Badge>
                ) : (
                  e.flags
                    .filter((f) => f !== 'corrected')
                    .map((f) => (
                      <Badge key={f} tone="amber">
                        <AlertTriangle className="mr-0.5 size-3" />
                        {f.replaceAll('_', ' ')}
                      </Badge>
                    ))
                )}
              </div>
            </Td>
            <Td>
              <button
                onClick={() => onReview(e)}
                className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800"
              >
                <Eye className="size-3.5" /> Review
              </button>
            </Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  )
}

function ReviewModal({
  entry,
  onClose,
  onChanged,
}: {
  entry: EntryWithEmployee | null
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [inUrl, setInUrl] = useState<string | null>(null)
  const [outUrl, setOutUrl] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    setInUrl(null)
    setOutUrl(null)
    setNotes(entry?.admin_notes ?? '')
    if (entry?.clock_in_selfie_path) signedSelfieUrl(entry.clock_in_selfie_path).then(setInUrl)
    if (entry?.clock_out_selfie_path) signedSelfieUrl(entry.clock_out_selfie_path).then(setOutUrl)
  }, [entry])

  if (!entry) return null
  const device = entry.clock_in_device ?? {}
  const loc = entry.clock_in_location

  async function saveNotes() {
    const { error } = await supabase
      .from('time_entries')
      .update({ admin_notes: notes })
      .eq('id', entry!.id)
    if (error) toast('error', error.message)
    else {
      toast('success', 'Notes saved.')
      await onChanged()
    }
  }

  async function clearFlags() {
    const { error } = await supabase
      .from('time_entries')
      .update({ flags: entry!.flags.filter((f) => f === 'corrected'), admin_notes: notes || 'Flags cleared after review' })
      .eq('id', entry!.id)
    if (error) toast('error', error.message)
    else {
      toast('success', 'Marked as reviewed — flags cleared.')
      await onChanged()
      onClose()
    }
  }

  return (
    <Modal open onClose={onClose} title={`Punch review — ${entry.employees ? fullName(entry.employees) : ''}`} wide>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-bold uppercase text-slate-500">Clock in — {fmtDateTime(entry.clock_in)}</p>
            {inUrl ? (
              <img src={inUrl} alt="Clock-in selfie" className="aspect-[4/3] w-full rounded-xl object-cover" />
            ) : (
              <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-slate-100 text-xs text-slate-400">
                No selfie captured
              </div>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-bold uppercase text-slate-500">
              Clock out — {entry.clock_out ? fmtDateTime(entry.clock_out) : 'still open'}
            </p>
            {outUrl ? (
              <img src={outUrl} alt="Clock-out selfie" className="aspect-[4/3] w-full rounded-xl object-cover" />
            ) : (
              <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-slate-100 text-xs text-slate-400">
                No selfie captured
              </div>
            )}
          </div>
        </div>

        <div className="grid gap-2 rounded-xl bg-slate-50 p-4 text-xs text-slate-600 sm:grid-cols-2">
          <p><b>Flags:</b> {entry.flags.length ? entry.flags.join(', ').replaceAll('_', ' ') : 'none'}</p>
          <p><b>Source:</b> {entry.source}{entry.manually_edited ? ' (manually edited)' : ''}</p>
          <p><b>IP (in/out):</b> {entry.clock_in_ip ?? '—'} / {entry.clock_out_ip ?? '—'}</p>
          <p><b>Device:</b> {(device.platform || '—') + ' · ' + (device.fingerprint ? device.fingerprint.slice(0, 8) : 'no fingerprint')}</p>
          <p className="sm:col-span-2">
            <b>Location:</b>{' '}
            {loc ? (
              <a
                className="text-brand-600 underline"
                target="_blank"
                rel="noreferrer"
                href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}
              >
                {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)} (±{loc.accuracy ?? '?'}m)
              </a>
            ) : (
              'not shared'
            )}
          </p>
        </div>

        <Field label="Admin notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={saveNotes}>Save notes</Button>
          {entry.flags.filter((f) => f !== 'corrected').length > 0 && (
            <Button onClick={clearFlags}>
              <CheckCircle2 className="size-4" /> Verified — clear flags
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

function CorrectionsList({
  requests,
  onReview,
}: {
  requests: RequestWithEmployee[]
  onReview: (id: string, approve: boolean, notes: string) => Promise<void>
}) {
  const [notes, setNotes] = useState<Record<string, string>>({})
  if (requests.length === 0)
    return (
      <Card>
        <EmptyState title="No correction requests" />
      </Card>
    )
  return (
    <div className="space-y-3">
      {requests.map((r) => (
        <Card key={r.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-800">
                {r.employees ? fullName(r.employees) : '—'}
                <span className="ml-2 font-normal text-slate-500">{fmtDate(r.work_date)}</span>
                <Badge tone={r.status === 'pending' ? 'amber' : r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'slate'}>
                  {r.status}
                </Badge>
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Requested: {r.requested_clock_in ? fmtDateTime(r.requested_clock_in) : '—'} →{' '}
                {r.requested_clock_out ? fmtDateTime(r.requested_clock_out) : '—'}
                {!r.time_entry_id && <Badge tone="blue">new entry</Badge>}
              </p>
              <p className="mt-1 text-xs italic text-slate-500">“{r.reason}”</p>
            </div>
            {r.status === 'pending' && (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Review note (optional)"
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                  className="w-52"
                />
                <Button onClick={() => onReview(r.id, true, notes[r.id] ?? '')}>
                  <CheckCircle2 className="size-4" /> Approve
                </Button>
                <Button variant="danger" onClick={() => onReview(r.id, false, notes[r.id] ?? '')}>
                  <XCircle className="size-4" /> Reject
                </Button>
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}

function ManualEntryModal({
  open,
  employees,
  onClose,
  onSaved,
}: {
  open: boolean
  employees: Employee[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const toast = useToast()
  const [f, setF] = useState({ employee: '', date: todayManila(), in: '09:00', out: '18:00' })
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!f.employee) {
      toast('error', 'Pick an employee.')
      return
    }
    setBusy(true)
    try {
      const mkIso = (hhmm: string) =>
        new Date(new Date(`${f.date}T${hhmm}:00Z`).getTime() - 8 * 3600 * 1000).toISOString()
      const { error } = await supabase.from('time_entries').insert({
        employee_id: f.employee,
        work_date: f.date,
        clock_in: mkIso(f.in),
        clock_out: mkIso(f.out),
        source: 'admin',
        status: 'closed',
        manually_edited: true,
        flags: ['admin_entry'],
        admin_notes: 'Manually entered by admin',
      })
      if (error) throw error
      toast('success', 'Entry added (audit-logged).')
      await onSaved()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add manual time entry">
      <div className="space-y-4">
        <Field label="Employee">
          <Select value={f.employee} onChange={(e) => setF({ ...f, employee: e.target.value })}>
            <option value="">Select…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{fullName(e)} ({e.employee_no})</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="In (Manila)">
            <Input type="time" value={f.in} onChange={(e) => setF({ ...f, in: e.target.value })} />
          </Field>
          <Field label="Out (Manila)">
            <Input type="time" value={f.out} onChange={(e) => setF({ ...f, out: e.target.value })} />
          </Field>
        </div>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Add entry'}
        </Button>
        <p className="text-center text-[11px] text-slate-400">
          Manual entries are flagged, marked as admin-sourced, and recorded in the audit log.
        </p>
      </div>
    </Modal>
  )
}
