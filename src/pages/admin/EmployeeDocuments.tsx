// PhilHealth NG share paperwork on an employee's Pay tab (spec T6): the
// document slots PhilHealth's circulars ask the employer to keep, and the
// finalized payrolls that deducted the employee share in months the NG share
// now covers (a status confirmed, or a start month recorded, late).

import { useEffect, useState } from 'react'
import { FileText, Trash2, Upload } from 'lucide-react'
import { useToast } from '../../components/toast'
import type { Employee } from '../../lib/db'
import { errorMessage } from '../../lib/errors'
import { fmtDate, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { pastWaivedDeductions } from '../../payroll/philhealthWaiver'

const BUCKET = 'employee-documents'
const MAX_BYTES = 10 * 1024 * 1024

type Slot = 'pmrf' | 'id_front' | 'id_back' | 'spis' | 'annex_a' | 'annex_b'

interface EmployeeDocument {
  id: string
  slot: Slot
  file_path: string
  file_name: string
  uploaded_at: string
}

const slotsFor = (kind: Employee['philhealth_ee_waiver']): { slot: Slot; label: string }[] => {
  const id = kind === 'pwd' ? 'PWD ID' : 'Solo parent ID (SPIC)'
  return [
    { slot: 'pmrf', label: 'PMRF (PhilHealth Member Registration Form)' },
    { slot: 'id_front', label: `${id} — front` },
    { slot: 'id_back', label: `${id} — back` },
    { slot: 'spis', label: 'SPIS record (when available)' },
    { slot: 'annex_a', label: 'Annex A — employer certification' },
    { slot: 'annex_b', label: 'PhilHealth Annex B — advisory or verification report' },
  ]
}

/** Where an upload goes: the employee's folder (storage policies check it), the slot, a unique name. */
function storagePath(employeeId: string, slot: Slot, fileName: string): string {
  return `${employeeId}/${slot}/${Date.now()}-${fileName.replace(/[^\w.-]+/g, '_')}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthText = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`

export function EmployeeDocuments({ employee }: { employee: Employee }) {
  const toast = useToast()
  const [docs, setDocs] = useState<EmployeeDocument[]>([])
  const [busy, setBusy] = useState('')
  // bumped after an upload or removal: the list loads again
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    supabase
      .from('employee_documents')
      .select('id, slot, file_path, file_name, uploaded_at')
      .eq('employee_id', employee.id)
      .order('uploaded_at')
      .then(({ data, error }) => {
        if (!live) return
        if (error) toast('error', errorMessage(error, 'Could not load the documents'))
        else setDocs((data ?? []) as EmployeeDocument[])
      })
    return () => {
      live = false
    }
  }, [employee.id, version, toast])

  async function upload(slot: Slot, file: File) {
    if (file.size > MAX_BYTES) {
      toast('error', 'Files up to 10 MB (PDF, JPEG, PNG or WebP).')
      return
    }
    setBusy(slot)
    const path = storagePath(employee.id, slot, file.name)
    try {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file)
      if (upErr) throw upErr
      const { error } = await supabase
        .from('employee_documents')
        .insert({ employee_id: employee.id, slot, file_path: path, file_name: file.name.slice(0, 200) })
      if (error) {
        await supabase.storage.from(BUCKET).remove([path])
        throw error
      }
      toast('success', 'Document uploaded.')
      setVersion((v) => v + 1)
    } catch (err) {
      toast('error', errorMessage(err, 'Upload failed'))
    } finally {
      setBusy('')
    }
  }

  async function open(doc: EmployeeDocument) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(doc.file_path, 60)
    if (error || !data) toast('error', errorMessage(error, 'Could not open the document'))
    else window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function remove(doc: EmployeeDocument) {
    if (!confirm(`Remove ${doc.file_name}?`)) return
    setBusy(doc.id)
    try {
      const { error } = await supabase.from('employee_documents').delete().eq('id', doc.id)
      if (error) throw error
      await supabase.storage.from(BUCKET).remove([doc.file_path])
      setVersion((v) => v + 1)
    } catch (err) {
      toast('error', errorMessage(err, 'Could not remove the document'))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-600">PhilHealth NG share documents</p>
      {slotsFor(employee.philhealth_ee_waiver).map(({ slot, label }) => (
        <div key={slot} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-600">{label}</span>
            <label className={`inline-flex cursor-pointer items-center gap-1 text-xs font-semibold ${busy ? 'text-slate-300' : 'text-brand-600'}`}>
              <Upload className="size-3.5" /> {busy === slot ? 'Uploading…' : 'Upload'}
              <input
                type="file"
                className="hidden"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                disabled={busy !== ''}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) upload(slot, file)
                }}
              />
            </label>
          </div>
          {docs
            .filter((d) => d.slot === slot)
            .map((d) => (
              <div key={d.id} className="mt-1 flex items-center justify-between gap-2 text-xs">
                <button type="button" onClick={() => open(d)} className="flex min-w-0 items-center gap-1 text-brand-700 hover:underline">
                  <FileText className="size-3.5 shrink-0" /> <span className="truncate">{d.file_name}</span>
                </button>
                <span className="flex shrink-0 items-center gap-2 text-slate-400">
                  {fmtDate(d.uploaded_at.slice(0, 10))}
                  <button type="button" disabled={busy !== ''} onClick={() => remove(d)} aria-label={`Remove ${d.file_name}`} className="hover:text-rose-500">
                    <Trash2 className="size-3.5" />
                  </button>
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

/** Finalized payrolls that deducted the employee share in months the NG share now covers. */
export function PhilhealthWaiverPast({ employee }: { employee: Employee }) {
  // the deductions found for one waiver record (`key`): a stale result never shows for another
  const [found, setFound] = useState<{ key: string; past: { month: string; amount: number }[] }>({ key: '', past: [] })
  const w = {
    kind: employee.philhealth_ee_waiver ?? null,
    startMonth: employee.philhealth_waiver_start_month ?? null,
    spicExpiry: employee.philhealth_spic_expiry ?? null,
    pwdStatus: employee.philhealth_pwd_status ?? null,
  }
  const key = JSON.stringify(w)

  useEffect(() => {
    let live = true
    const record = JSON.parse(key) as typeof w
    if (!record.kind || !record.startMonth) return
    supabase
      .from('payslips')
      .select('period_month, philhealth_ee, payroll_runs!inner(status)')
      .eq('employee_id', employee.id)
      .in('payroll_runs.status', ['finalized', 'paid'])
      .gte('period_month', record.startMonth)
      .then(({ data }) => {
        if (live) setFound({ key, past: pastWaivedDeductions(record, (data ?? []) as { period_month: string | null; philhealth_ee: number }[]) })
      })
    return () => {
      live = false
    }
  }, [employee.id, key])

  const past = found.key === key && w.kind && w.startMonth ? found.past : []
  if (past.length === 0) return null
  return (
    <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
      The government pays the employee share for these months, but finalized payrolls deducted it:{' '}
      {past.map((p) => `${monthText(p.month)} ${money(p.amount)}`).join('; ')}. If PhilHealth applies the NG share to
      them, refund it to the employee with a one-time earning on the next payroll.
    </p>
  )
}
