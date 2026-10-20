import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { useAuth } from '../../lib/auth'
import type { Holiday } from '../../lib/db'
import { useEntity } from '../../lib/entity'
import { fmtDate } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errors'

const kindLabels: Record<string, { label: string; tone: string; pay: string }> = {
  regular: { label: 'Regular holiday', tone: 'red', pay: '200% worked / 100% unworked' },
  special_non_working: { label: 'Special non-working', tone: 'amber', pay: '130% worked / no work no pay' },
  special_working: { label: 'Special working', tone: 'slate', pay: 'Ordinary pay, no premium' },
}

export default function Holidays() {
  const toast = useToast()
  const { isCompanyAdmin } = useAuth()
  const { entity } = useEntity()
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)))
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState<'national' | 'local' | null>(null)
  const [f, setF] = useState({ date: '', name: '', kind: 'regular' })
  const [busy, setBusy] = useState(false)

  const latest = useRef(0)
  const load = useCallback(async () => {
    const mine = ++latest.current
    setLoading(true)
    let q = supabase
      .from('holidays')
      .select('*')
      .gte('holiday_date', `${year}-01-01`)
      .lte('holiday_date', `${year}-12-31`)
      .order('holiday_date')
    q = entity ? q.or(`entity_id.is.null,entity_id.eq.${entity.id}`) : q.is('entity_id', null)
    const { data } = await q
    if (mine !== latest.current) return // switched client/year meanwhile
    setHolidays((data ?? []) as Holiday[])
    setLoading(false)
  }, [year, entity])

  useEffect(() => {
    load()
  }, [load])

  async function add() {
    if (!f.date || !f.name) return toast('error', 'Date and name are required.')
    setBusy(true)
    try {
      const { error } = await supabase.from('holidays').insert({
        holiday_date: f.date,
        name: f.name,
        kind: f.kind,
        entity_id: adding === 'local' ? entity?.id : null,
      })
      if (error) throw error
      toast('success', 'Holiday added.')
      setAdding(null)
      setF({ date: '', name: '', kind: 'regular' })
      await load()
    } catch (err) {
      toast('error', errorMessage(err, 'Failed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(h: Holiday) {
    if (!confirm('Remove this holiday? Draft payrolls covering it change when recomputed.')) return
    const { error } = await supabase.from('holidays').delete().eq('id', h.id)
    if (error) toast('error', error.message)
    else await load()
  }

  const canEdit = (h: Holiday) => (h.entity_id ? true : isCompanyAdmin)

  return (
    <div>
      <PageHeader
        title="Holidays"
        subtitle={`National holidays apply to every client (2026 from Proclamations 1006, 1189 and 1264). Local holidays${entity ? ` apply to ${entity.name} only` : ' apply per client'}.`}
        actions={
          <>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
            {entity && (
              <Button variant="secondary" onClick={() => setAdding('local')}>
                <Plus className="size-4" /> Local holiday
              </Button>
            )}
            {isCompanyAdmin && (
              <Button onClick={() => setAdding('national')}>
                <Plus className="size-4" /> National holiday
              </Button>
            )}
          </>
        }
      />
      {loading ? (
        <Spinner />
      ) : (
        <Card>
          <TableShell>
            <thead className="bg-slate-50">
              <tr>
                <Th>Date</Th>
                <Th>Name</Th>
                <Th>Scope</Th>
                <Th>Type</Th>
                <Th>Pay rule</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {holidays.map((h) => (
                <tr key={h.id} className="hover:bg-slate-50">
                  <Td className="font-semibold">{fmtDate(h.holiday_date)}</Td>
                  <Td>{h.name}</Td>
                  <Td>{h.entity_id ? <Badge tone="violet">local</Badge> : <Badge tone="blue">national</Badge>}</Td>
                  <Td><Badge tone={kindLabels[h.kind].tone}>{kindLabels[h.kind].label}</Badge></Td>
                  <Td className="text-xs text-slate-500">{kindLabels[h.kind].pay}</Td>
                  <Td>
                    {canEdit(h) && (
                      <button onClick={() => remove(h)} className="text-slate-300 hover:text-rose-500">
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
              {holidays.length === 0 && (
                <tr>
                  <Td colSpan={6} className="py-8 text-center text-slate-400">
                    No holidays for {year} — {isCompanyAdmin ? 'add them' : 'ask a company admin to add them'} before running payroll.
                  </Td>
                </tr>
              )}
            </tbody>
          </TableShell>
          <p className="mt-3 text-[11px] text-slate-400">
            Holiday dates (especially Eid'l Fitr / Eid'l Adha) are set by separate proclamations — keep this list
            current; premiums depend on it.
          </p>
        </Card>
      )}

      <Modal open={adding !== null} onClose={() => setAdding(null)} title={adding === 'local' ? `Add local holiday — ${entity?.name}` : 'Add national holiday'}>
        <div className="space-y-4">
          <Field label="Date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={adding === 'local' ? 'e.g. City Charter Day' : "e.g. Eid'l Fitr"} />
          </Field>
          <Field label="Type">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {Object.entries(kindLabels).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </Select>
          </Field>
          <Button className="w-full" disabled={busy} onClick={add}>
            {busy ? 'Saving…' : 'Add holiday'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
