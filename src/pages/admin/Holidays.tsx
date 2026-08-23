import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { Holiday } from '../../lib/db'
import { fmtDate } from '../../lib/format'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

const kindLabels: Record<string, { label: string; tone: string; pay: string }> = {
  regular: { label: 'Regular holiday', tone: 'red', pay: '200% worked / 100% unworked' },
  special_non_working: { label: 'Special non-working', tone: 'amber', pay: '130% worked / no work no pay' },
  special_working: { label: 'Special working', tone: 'slate', pay: 'Ordinary pay, no premium' },
}

export default function Holidays() {
  const toast = useToast()
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [year, setYear] = useState(Number(todayManila().slice(0, 4)))
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ date: '', name: '', kind: 'regular' })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('holidays')
      .select('*')
      .gte('holiday_date', `${year}-01-01`)
      .lte('holiday_date', `${year}-12-31`)
      .order('holiday_date')
    setHolidays((data ?? []) as Holiday[])
    setLoading(false)
  }, [year])

  useEffect(() => {
    load()
  }, [load])

  async function add() {
    if (!f.date || !f.name) {
      toast('error', 'Date and name are required.')
      return
    }
    setBusy(true)
    try {
      const { error } = await supabase.from('holidays').insert({
        holiday_date: f.date,
        name: f.name,
        kind: f.kind,
      })
      if (error) throw error
      toast('success', 'Holiday added.')
      setAdding(false)
      setF({ date: '', name: '', kind: 'regular' })
      await load()
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this holiday? Payroll for periods containing it will change on recompute.')) return
    const { error } = await supabase.from('holidays').delete().eq('id', id)
    if (error) toast('error', error.message)
    else await load()
  }

  return (
    <div>
      <PageHeader
        title="Holidays"
        subtitle="2026 calendar seeded from Proclamations 1006, 1189 and 1264. Keep this updated when new proclamations are issued — payroll premiums depend on it."
        actions={
          <>
            <Select value={year} onChange={(e) => setYear(Number(e.target.value))} className="w-28">
              {[year - 1, year, year + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add holiday
            </Button>
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
                  <Td><Badge tone={kindLabels[h.kind].tone}>{kindLabels[h.kind].label}</Badge></Td>
                  <Td className="text-xs text-slate-500">{kindLabels[h.kind].pay}</Td>
                  <Td>
                    <button onClick={() => remove(h.id)} className="text-slate-300 hover:text-rose-500">
                      <Trash2 className="size-4" />
                    </button>
                  </Td>
                </tr>
              ))}
              {holidays.length === 0 && (
                <tr><Td colSpan={5} className="py-8 text-center text-slate-400">No holidays for {year} — add them before running payroll.</Td></tr>
              )}
            </tbody>
          </TableShell>
        </Card>
      )}

      <Modal open={adding} onClose={() => setAdding(false)} title="Add holiday">
        <div className="space-y-4">
          <Field label="Date">
            <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Eid'l Fitr" />
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
