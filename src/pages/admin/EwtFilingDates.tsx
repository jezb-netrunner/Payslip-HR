// The EWT filing dates of consultants' fees: the computed dates, each
// replaceable for the client when the BIR moves one (an extension), like
// the filing calendar's dates.

import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { Badge, Button, Field, Input, Modal } from '../../components/ui'
import { useToast } from '../../components/toast'
import { errorMessage } from '../../lib/errors'
import { fmtDate } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import type { EwtDue } from '../../payroll/ewtDueDates'

export function EwtFilingDates({ entityId, rows, onChanged }: { entityId: string; rows: EwtDue[]; onChanged: () => void }) {
  const toast = useToast()
  const [editing, setEditing] = useState<{ row: EwtDue; due: string; note: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function save(useStandard: boolean) {
    if (!editing) return
    setBusy(true)
    const key = { entity_id: entityId, filing: editing.row.filing, period: editing.row.period }
    const { error } = useStandard
      ? await supabase.from('ewt_due_dates').delete().match(key)
      : await supabase.from('ewt_due_dates').upsert({ ...key, due_date: editing.due, note: editing.note.trim() }, { onConflict: 'entity_id,filing,period' })
    setBusy(false)
    if (error) return toast('error', errorMessage(error, 'Save failed'))
    toast('success', useStandard ? 'Back to the standard date.' : 'Due date changed (audit-logged).')
    setEditing(null)
    onChanged()
  }

  return (
    <>
      <ul className="divide-y divide-slate-100 text-sm">
        {rows.map((r) => (
          <li key={`${r.filing}${r.period}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
            <span className="min-w-0 text-slate-700">
              {r.label}
              <span className="block text-xs text-slate-500">
                {r.basis}
                {r.note && <span className={r.note.startsWith('Falls on') || r.note.includes('. Falls on') ? ' text-amber-700' : ''}> · {r.note}</span>}
              </span>
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className="font-semibold text-ink-900">{fmtDate(r.due)}</span>
              {r.overridden && <Badge tone="blue">changed</Badge>}
              <button
                type="button"
                aria-label={`Change the date of ${r.label}`}
                onClick={() => setEditing({ row: r, due: r.due, note: r.overridden ? r.note : '' })}
                className="flex items-center gap-1 text-xs font-semibold text-brand-600"
              >
                <Pencil className="size-3.5" /> Change
              </button>
            </span>
          </li>
        ))}
      </ul>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.row.label ?? ''}>
        {editing && (
          <div className="space-y-4">
            <Field label="Due date">
              <Input type="date" value={editing.due} onChange={(e) => setEditing({ ...editing, due: e.target.value })} />
            </Field>
            <Field label="Note" hint="e.g. the circular that extends it">
              <Input value={editing.note} maxLength={200} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !editing.due} onClick={() => save(false)}>
                Save
              </Button>
              {editing.row.overridden && (
                <Button variant="secondary" disabled={busy} onClick={() => save(true)}>
                  Use the standard date
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
