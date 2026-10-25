// BIR & Reports → Due dates (spec T9): a year's filing and remittance dates
// for the selected client, computed from its filing settings, never moved
// for weekends or holidays (a Saturday or Sunday is marked), each one
// overridable with a note.

import { useEffect, useState } from 'react'
import { CalendarClock, Pencil } from 'lucide-react'
import { Badge, Button, Card, Field, IconButton, Input, LoadFailed, Modal, Spinner, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import type { DueDateOverrideRow, Entity } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fmtDate, fmtMonth } from '../../lib/format'
import { OBLIGATION_LABELS } from '../../lib/labels'
import { isoWeekday } from '../../lib/manila'
import { supabase } from '../../lib/supabase'
import { dueCalendar, type DueItem } from '../../payroll/dueDates'

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHLY = new Set(['1601c', 'sss', 'philhealth', 'pagibig'])

export default function DueDates({ entity, year }: { entity: Entity; year: number }) {
  const toast = useToast()
  const [overrides, setOverrides] = useState<DueDateOverrideRow[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [version, setVersion] = useState(0)
  const [editing, setEditing] = useState<{ item: DueItem; date: string; note: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('due_date_overrides')
      .select('*')
      .eq('entity_id', entity.id)
      .gte('period', `${year}-01-01`)
      .lte('period', `${year}-12-01`)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setLoadError(errorMessage(error, 'Failed to load the due-date overrides'))
        else {
          setOverrides((data ?? []) as DueDateOverrideRow[])
          setLoadError('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [entity.id, year, version])

  if (loadError) return <LoadFailed message={loadError} onRetry={() => setVersion((v) => v + 1)} />
  if (!overrides) return <Spinner />

  const items = dueCalendar({
    year,
    filing: { mode: entity.filing_mode, group: entity.efps_group },
    contributionDays: { sss: entity.sss_due_day, philhealth: entity.philhealth_due_day, pagibig: entity.pagibig_due_day },
    overrides,
  })
    // in date order; a date the settings don't give goes last
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.period.localeCompare(b.period))
  const noContributions = !entity.sss_due_day && !entity.philhealth_due_day && !entity.pagibig_due_day

  async function save() {
    if (!editing) return
    if (!editing.date) return toast('error', 'Enter the due date.')
    if (!editing.note.trim()) return toast('error', 'Say why the date differs (for example the RMC that extended it).')
    setBusy(true)
    const { error } = await supabase.from('due_date_overrides').upsert(
      { entity_id: entity.id, obligation: editing.item.key, period: editing.item.period, due_date: editing.date, note: editing.note.trim() },
      { onConflict: 'entity_id,obligation,period' },
    )
    setBusy(false)
    if (error) return toast('error', errorMessage(error, 'Save failed'))
    toast('success', 'Due date overridden (audit-logged).')
    setEditing(null)
    setVersion((v) => v + 1)
  }

  async function removeOverride() {
    if (!editing) return
    setBusy(true)
    const { error } = await supabase
      .from('due_date_overrides')
      .delete()
      .eq('entity_id', entity.id)
      .eq('obligation', editing.item.key)
      .eq('period', editing.item.period)
    setBusy(false)
    if (error) return toast('error', errorMessage(error, 'Failed'))
    toast('success', 'Back to the computed date.')
    setEditing(null)
    setVersion((v) => v + 1)
  }

  const covers = (i: DueItem) => (MONTHLY.has(i.key) ? fmtMonth(i.period) : `Tax year ${year}`)
  return (
    <Card title={`Due dates — ${year}`} icon={<CalendarClock />}>
      {(!entity.filing_mode || (entity.filing_mode === 'efps' && !entity.efps_group)) && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Choose how this client files with the BIR (manual or eBIRForms, or eFPS and its group) in Client Settings to see the
          1601-C dates.
        </p>
      )}
      {noContributions && (
        <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          SSS, PhilHealth and Pag-IBIG dates appear once their due day is set in Client Settings (pending legal confirmation: no
          default).
        </p>
      )}
      <TableShell>
        <thead className="bg-slate-50">
          <tr>
            <Th>Due</Th>
            <Th>Obligation</Th>
            <Th>Covers</Th>
            <Th>Note</Th>
            <Th></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((i) => (
            <tr key={`${i.key}${i.period}`} className="hover:bg-slate-50">
              <Td className="whitespace-nowrap">
                {i.date ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{fmtDate(i.date)}</span>
                    <span className="text-xs text-slate-400">{WEEKDAY[isoWeekday(i.date) - 1]}</span>
                    {i.weekend && <Badge tone="amber">weekend</Badge>}
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">not set</span>
                )}
              </Td>
              <Td>{OBLIGATION_LABELS[i.key]}</Td>
              <Td className="whitespace-nowrap text-xs">{covers(i)}</Td>
              <Td className="text-xs">
                {i.overridden ? (
                  <span>
                    <Badge tone="blue">override</Badge> {i.note}
                    {i.computed && <span className="block text-slate-400">computed {fmtDate(i.computed)}</span>}
                  </span>
                ) : (
                  ''
                )}
              </Td>
              <Td>
                <IconButton
                  size="sm"
                  label={`Override the due date of ${OBLIGATION_LABELS[i.key]}, ${covers(i)}`}
                  onClick={() => setEditing({ item: i, date: i.date ?? '', note: i.note })}
                >
                  <Pencil className="size-3.5" />
                </IconButton>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
      <p className="mt-3 text-[11px] text-slate-400">
        The 1601-C is due on the 10th of the next month (manual or eBIRForms) or on the eFPS group's day (A 15th to E 11th);
        December's on January 15 or the group's day of January. A year's refunds are due by January 25, the 2316 to employees
        and the 1604-C with the alphalist by January 31 (the 2316 at final pay for those who leave), the scanned 2316
        duplicates by February 28. Dates are not moved for weekends or holidays: when the BIR extends a deadline (by RMC),
        override the date with a note.
      </p>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `${OBLIGATION_LABELS[editing.item.key]} — ${covers(editing.item)}` : ''}>
        {editing && (
          <div className="space-y-4">
            {editing.item.computed && <p className="text-xs text-slate-500">Computed date: {fmtDate(editing.item.computed)}</p>}
            <Field label="Due date">
              <Input type="date" value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
            </Field>
            <Field label="Note" hint="Why the date differs, e.g. the RMC that extended it">
              <Input value={editing.note} maxLength={500} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <div className="flex gap-2">
              <Button className="flex-1" onClick={save} disabled={busy}>Save</Button>
              {editing.item.overridden && (
                <Button variant="secondary" onClick={removeOverride} disabled={busy}>Use the computed date</Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}
