import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Badge, Button, Card, EmptyState, Input, PageHeader, Spinner, TableShell, Tabs, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Employee, LeaveRequest, LeaveType } from '../../lib/db'
import { fmtDate, fullName } from '../../lib/format'
import { supabase } from '../../lib/supabase'

type RequestFull = LeaveRequest & { employees: Employee; leave_types: LeaveType }

export default function LeavesAdmin() {
  const toast = useToast()
  const [tab, setTab] = useState('pending')
  const [requests, setRequests] = useState<RequestFull[]>([])
  const [types, setTypes] = useState<LeaveType[]>([])
  const [loading, setLoading] = useState(true)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const [{ data: r }, { data: t }] = await Promise.all([
      supabase
        .from('leave_requests')
        .select('*, employees(*), leave_types(*)')
        .order('created_at', { ascending: false })
        .limit(200),
      supabase.from('leave_types').select('*').order('code'),
    ])
    setRequests((r ?? []) as RequestFull[])
    setTypes((t ?? []) as LeaveType[])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function review(id: string, approve: boolean) {
    const { data: userData } = await supabase.auth.getUser()
    const { error } = await supabase
      .from('leave_requests')
      .update({
        status: approve ? 'approved' : 'rejected',
        reviewed_by: userData.user?.id ?? null,
        reviewed_at: new Date().toISOString(),
        review_notes: notes[id] || null,
      })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) toast('error', error.message)
    else {
      toast('success', approve ? 'Leave approved — payroll will treat these days accordingly.' : 'Leave rejected.')
      await load()
    }
  }

  const pending = requests.filter((r) => r.status === 'pending')
  const shown = tab === 'pending' ? pending : requests

  return (
    <div>
      <PageHeader
        title="Leave Management"
        subtitle="Approved paid leaves count as paid days in payroll; unpaid leaves are deducted."
      />
      <Tabs
        tabs={[
          { key: 'pending', label: 'Pending', count: pending.length },
          { key: 'all', label: 'All requests' },
          { key: 'types', label: 'Leave types' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {loading ? (
        <Spinner />
      ) : tab === 'types' ? (
        <Card title="Leave types (statutory + company)">
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th className="text-right">Default days / year</Th>
                <Th>Paid</Th>
                <Th>Active</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {types.map((t) => (
                <tr key={t.id}>
                  <Td className="font-mono text-xs font-bold">{t.code}</Td>
                  <Td>{t.name}</Td>
                  <Td className="text-right">{Number(t.default_annual_days)}</Td>
                  <Td>{t.paid ? <Badge tone="green">paid</Badge> : <Badge tone="slate">unpaid</Badge>}</Td>
                  <Td>{t.active ? 'Yes' : 'No'}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <p className="mt-3 text-xs text-slate-400">
            Statutory leaves seeded: SIL 5 days (Art. 95), Maternity 105 days (RA 11210), Paternity 7
            (RA 8187), Solo Parent 7 (RA 11861), VAWC 10 (RA 9262), Special Leave for Women 60 (RA 9710).
            Per-employee overrides can be set via employee leave entitlements.
          </p>
        </Card>
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState title="No leave requests" />
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    {r.employees ? fullName(r.employees) : '—'}
                    <span className="ml-2 font-normal text-slate-500">
                      {r.leave_types?.name} · {Number(r.days)} day/s
                    </span>{' '}
                    <Badge
                      tone={
                        r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'amber' : 'slate'
                      }
                    >
                      {r.status}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {fmtDate(r.start_date)} → {fmtDate(r.end_date)}
                    {r.reason ? ` · “${r.reason}”` : ''}
                  </p>
                </div>
                {r.status === 'pending' && (
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Note (optional)"
                      value={notes[r.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                      className="w-48"
                    />
                    <Button onClick={() => review(r.id, true)}>
                      <CheckCircle2 className="size-4" /> Approve
                    </Button>
                    <Button variant="danger" onClick={() => review(r.id, false)}>
                      <XCircle className="size-4" /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
