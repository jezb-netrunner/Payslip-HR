// Output reports: private files in the output-reports bucket, at
// <client id>/<employee id>/<file> — only the client's admins can store,
// read or remove them (storage policies).

import type { EmployeeOutput } from './db'
import { supabase } from './supabase'

export const OUTPUT_REPORTS_BUCKET = 'output-reports'

/** What the bucket accepts (a CSV can come as Excel's type). */
export const OUTPUT_REPORT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
]
export const OUTPUT_REPORT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx,.xls,.csv'
const MAX_BYTES = 10 * 1024 * 1024

/** Why a file can't be an output report, or '' when it can. */
export function outputReportProblem(file: File): string {
  if (!OUTPUT_REPORT_TYPES.includes(file.type)) return 'Attach a PDF, an image (JPG, PNG, WebP), a Word or Excel file, or a CSV.'
  if (file.size > MAX_BYTES) return 'The output report is over 10 MB: attach a smaller file.'
  return ''
}

/** A new, unique place for an employee's output report; the file name is kept readable. */
export function outputReportPath(entityId: string, employeeId: string, fileName: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(-80) || 'report'
  return `${entityId}/${employeeId}/${crypto.randomUUID()}-${safe}`
}

export async function uploadOutputReport(path: string, file: File): Promise<void> {
  const { error } = await supabase.storage.from(OUTPUT_REPORTS_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
}

/** Best effort: a file left behind is only clutter, never pay. */
export async function removeOutputReport(path: string | null | undefined): Promise<void> {
  if (!path) return
  await supabase.storage.from(OUTPUT_REPORTS_BUCKET).remove([path])
}

/** Opens the report in a new tab through a link that works for a minute. */
export async function openOutputReport(output: Pick<EmployeeOutput, 'report_path'>): Promise<void> {
  if (!output.report_path) return
  // open the tab first: a window opened after an await is a blocked pop-up
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  const { data, error } = await supabase.storage.from(OUTPUT_REPORTS_BUCKET).createSignedUrl(output.report_path, 60)
  if (error || !data?.signedUrl) {
    tab?.close()
    throw error ?? new Error('The output report could not be opened.')
  }
  if (tab) tab.location.href = data.signedUrl
  else window.location.assign(data.signedUrl)
}
