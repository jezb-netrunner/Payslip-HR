// Import employees from a CSV: download the template, fill one row per
// employee, upload, read every problem by line, then add the rows that pass.
// Each employee is added like the Add employee form does (the database starts
// the pay history at the hire date) with its "hired" career event, and a
// "separated" one for someone who already left. A row whose employee number
// is already in the client is skipped, so a file can be uploaded again after
// fixing the rows that failed.

import { useRef, useState } from 'react'
import { Download, FileUp } from 'lucide-react'
import { Badge, Button, Modal, TableShell, Td, Th } from '../../components/ui'
import { useToast } from '../../components/toast'
import { downloadCsv, getEmployees } from '../../lib/api'
import type { Entity } from '../../lib/db'
import { checkImport, decodeCsv, IMPORT_COLUMNS, IMPORT_MAX_ROWS, parseCsvRows, templateRows, type ImportCheck, type ImportRow } from '../../lib/employeeImport'
import { errorMessage } from '../../lib/errors'
import { SEPARATION_REASON_LABELS } from '../../lib/labels'
import { todayManila } from '../../lib/manila'
import { supabase } from '../../lib/supabase'

/** Rows shown in the preview; the counts cover all of them. */
const PREVIEW_ROWS = 200

type Result = { added: number; failed: { row: ImportRow; message: string }[]; notes: string[] }

export function EmployeeImportModal({ open, entity, onClose, onImported }: { open: boolean; entity: Entity; onClose: () => void; onImported: () => void }) {
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [checked, setChecked] = useState<ImportCheck | null>(null)
  const [reading, setReading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  const reset = () => {
    setFileName('')
    setChecked(null)
    setResult(null)
    setProgress(null)
    if (fileInput.current) fileInput.current.value = ''
  }
  const close = () => {
    if (progress) return // an import under way finishes first
    if (result && result.added > 0) onImported()
    reset()
    onClose()
  }

  async function readFile(file: File) {
    setReading(true)
    setResult(null)
    setFileName(file.name)
    try {
      if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
        throw new Error('Choose a CSV file. In Excel or Google Sheets: File → Save as / Download → CSV (comma-separated).')
      }
      // the client's employees now, not as the list last loaded
      const existing = await getEmployees(entity.id)
      const parsed = parseCsvRows(decodeCsv(await file.arrayBuffer()))
      setChecked(
        checkImport(
          parsed.map((r) => r.cells),
          {
            entity,
            existingNumbers: existing.map((e) => e.employee_no),
            existingEmails: existing.map((e) => e.email ?? '').filter(Boolean),
            today: todayManila(),
          },
          parsed.map((r) => r.line),
        ),
      )
    } catch (err) {
      setChecked(null)
      toast('error', errorMessage(err, 'Could not read the file'))
    } finally {
      setReading(false)
      // the same file can be chosen again after fixing it
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function runImport() {
    if (!checked) return
    const ready = checked.rows.filter((r) => r.record)
    const out: Result = { added: 0, failed: [], notes: [] }
    setProgress({ done: 0, total: ready.length })
    for (const [i, row] of ready.entries()) {
      const { employee, separation } = row.record!
      const { data, error } = await supabase.from('employees').insert(employee).select('id').single()
      if (error || !data) {
        const msg = errorMessage(error, 'Failed')
        out.failed.push({
          row,
          message: /employee_no/.test(msg)
            ? 'That employee number is already used in this client.'
            : /email/.test(msg)
              ? 'That email is already used in this client.'
              : msg,
        })
      } else {
        out.added++
        const events: Record<string, unknown>[] = [
          {
            employee_id: data.id,
            event_type: 'hired',
            effective_date: employee.hire_date,
            position: employee.position || null,
            department: employee.department || null,
            details: 'Start of employment (imported)',
          },
        ]
        if (separation) {
          events.push({ employee_id: data.id, event_type: 'separated', effective_date: separation.date, details: SEPARATION_REASON_LABELS[separation.reason] })
        }
        const { error: evErr } = await supabase.from('career_events').insert(events)
        if (evErr) out.notes.push(`Line ${row.line} (${row.employeeNo}): added, but its career history wasn't saved — ${errorMessage(evErr, 'failed')}. Add it on the employee's Career History tab.`)
      }
      setProgress({ done: i + 1, total: ready.length })
    }
    setProgress(null)
    setResult(out)
    setChecked(null)
    if (fileInput.current) fileInput.current.value = ''
    toast(out.failed.length ? 'error' : 'success', `${out.added} employee${out.added === 1 ? '' : 's'} added${out.failed.length ? `, ${out.failed.length} failed` : ''}.`)
  }

  const ready = checked?.rows.filter((r) => r.record) ?? []
  const withErrors = checked?.rows.filter((r) => !r.record) ?? []
  const withWarnings = ready.filter((r) => r.warnings.length > 0)
  // problems first, then warnings, then the rest, each by line
  const preview = [...withErrors, ...withWarnings, ...ready.filter((r) => r.warnings.length === 0)].slice(0, PREVIEW_ROWS)

  return (
    <Modal open={open} onClose={close} title={`Import employees — ${entity.name}`} wide>
      <div className="space-y-5 text-sm">
        <section>
          <h4 className="font-semibold text-ink-900">1. Fill in the template</h4>
          <p className="mt-1 text-slate-600">
            One row per employee, up to {IMPORT_MAX_ROWS.toLocaleString()} per file. Save it as CSV (comma-separated) from Excel or
            Google Sheets. Dates as YYYY-MM-DD or MM/DD/YYYY (month first).
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => downloadCsv(`employee_import_template_${entity.code}.csv`, templateRows())}>
              <Download className="size-4" /> Download template
            </Button>
          </div>
          <details className="mt-2 rounded-lg bg-slate-50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-slate-600">Columns ({IMPORT_COLUMNS.filter((c) => c.required).length} required)</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]">
              {IMPORT_COLUMNS.map((c) => (
                <div key={c.key} className="contents">
                  <dt className="font-mono text-ink-900">
                    {c.key}
                    {c.required ? ' *' : ''}
                  </dt>
                  <dd className="mb-1 text-slate-500 sm:mb-0">{c.hint}</dd>
                </div>
              ))}
            </dl>
          </details>
        </section>

        <section>
          <h4 className="font-semibold text-ink-900">2. Upload it and check</h4>
          <p className="mt-1 text-slate-600">Nothing is saved until you import. Rows with problems are left out; fix them and upload the file again.</p>
          <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-ink-900 shadow-xs hover:bg-slate-50">
            <FileUp className="size-4" />
            {reading ? 'Reading…' : fileName ? `Choose another file (${fileName})` : 'Choose CSV file'}
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              disabled={reading || !!progress}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void readFile(f)
              }}
            />
          </label>
        </section>

        {checked && (
          <section className="space-y-3">
            {checked.fileError && <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">{checked.fileError}</p>}
            {checked.missingColumns.length > 0 && (
              <p className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">
                The header row lacks required columns: {checked.missingColumns.join(', ')}. Start from the template.
              </p>
            )}
            {checked.unknownColumns.length > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">Ignored columns (not in the template): {checked.unknownColumns.join(', ')}.</p>
            )}
            {checked.rows.length > 0 && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="green">{ready.length} ready</Badge>
                  {withWarnings.length > 0 && <Badge tone="amber">{withWarnings.length} with warnings (imported)</Badge>}
                  {withErrors.length > 0 && <Badge tone="red">{withErrors.length} with problems (left out)</Badge>}
                </div>
                <div className="max-h-80 overflow-y-auto">
                  <TableShell>
                    <thead>
                      <tr>
                        <Th>Line</Th>
                        <Th>Employee</Th>
                        <Th>Check</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r) => (
                        <tr key={r.line}>
                          <Td className="align-top text-slate-500">{r.line}</Td>
                          <Td className="align-top">
                            <p className="font-semibold text-ink-900">{r.name}</p>
                            <p className="text-xs text-slate-500">{r.employeeNo || '—'}</p>
                          </Td>
                          <Td className="align-top whitespace-normal">
                            {r.errors.map((m) => (
                              <p key={m} className="text-xs text-rose-700">{m}</p>
                            ))}
                            {r.warnings.map((m) => (
                              <p key={m} className="text-xs text-amber-700">{m}</p>
                            ))}
                            {r.errors.length === 0 && r.warnings.length === 0 && <p className="text-xs text-emerald-700">Ready</p>}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </TableShell>
                </div>
                {checked.rows.length > PREVIEW_ROWS && (
                  <p className="text-xs text-slate-500">Showing {PREVIEW_ROWS} of {checked.rows.length} rows, problems first.</p>
                )}
                <Button className="w-full" disabled={ready.length === 0 || !!progress} onClick={runImport}>
                  {progress
                    ? `Importing ${progress.done} of ${progress.total}…`
                    : `Import ${ready.length} employee${ready.length === 1 ? '' : 's'}`}
                </Button>
              </>
            )}
          </section>
        )}

        {result && (
          <section className="space-y-2">
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-800">
              {result.added} employee{result.added === 1 ? '' : 's'} added. Next: their schedules (Schedules), allowances and deductions
              (each employee's Pay tab) and login codes.
            </p>
            {result.failed.length > 0 && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-rose-700">
                <p className="font-semibold">Not added:</p>
                {result.failed.map((f) => (
                  <p key={f.row.line} className="text-xs">
                    Line {f.row.line} ({f.row.employeeNo}): {f.message}
                  </p>
                ))}
              </div>
            )}
            {result.notes.map((n) => (
              <p key={n} className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{n}</p>
            ))}
            <Button variant="secondary" onClick={close}>Done</Button>
          </section>
        )}
      </div>
    </Modal>
  )
}
