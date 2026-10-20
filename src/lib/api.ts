import { fetchAll } from './fetchAll'
import { toCsv } from './csv'
import { supabase } from './supabase'
import type { Employee, Entity, Holiday, StatutoryVersion } from './db'
import type {
  BirAnnualData,
  BirWhtData,
  PagibigData,
  PhilHealthData,
  SssTableData,
  StatutoryTables,
} from '../payroll/types'

export async function getEntity(id: string): Promise<Entity> {
  const { data, error } = await supabase.from('entities').select('*').eq('id', id).single()
  if (error) throw error
  return data as Entity
}

/**
 * Load the statutory tables in force on a given date from the versioned
 * rows in the database (latest effective_from <= asOf per kind).
 */
export async function getStatutoryTables(asOf: string): Promise<StatutoryTables> {
  const { data, error } = await supabase
    .from('statutory_versions')
    .select('*')
    .lte('effective_from', asOf)
    .order('effective_from', { ascending: false })
  if (error) throw error
  const rows = (data ?? []) as StatutoryVersion[]
  const pick = (kind: StatutoryVersion['kind']) => rows.find((r) => r.kind === kind)?.data
  const sss = pick('sss') as SssTableData | undefined
  const philhealth = pick('philhealth') as PhilHealthData | undefined
  const pagibig = pick('pagibig') as PagibigData | undefined
  const bir_wht = pick('bir_wht') as BirWhtData | undefined
  const bir_annual = pick('bir_annual') as BirAnnualData | undefined
  if (!sss || !philhealth || !pagibig || !bir_wht || !bir_annual) {
    throw new Error(
      'Statutory tables are incomplete for ' + asOf + '. Ask a company admin to add the missing table versions.',
    )
  }
  return { sss, philhealth, pagibig, bir_wht, bir_annual }
}

const HOLIDAY_STRENGTH: Record<Holiday['kind'], number> = {
  regular: 3,
  special_non_working: 2,
  special_working: 1,
}

/**
 * National holidays plus the client's local holidays in a date range. When
 * two fall on the same date the stronger one governs pay (regular >
 * special non-working > special working).
 */
export async function getHolidaysBetween(entityId: string, start: string, end: string): Promise<Holiday[]> {
  const { data, error } = await supabase
    .from('holidays')
    .select('*')
    .or(`entity_id.is.null,entity_id.eq.${entityId}`)
    .gte('holiday_date', start)
    .lte('holiday_date', end)
    .order('holiday_date')
  if (error) throw error
  const byDate = new Map<string, Holiday>()
  for (const h of (data ?? []) as Holiday[]) {
    const cur = byDate.get(h.holiday_date)
    if (!cur || HOLIDAY_STRENGTH[h.kind] > HOLIDAY_STRENGTH[cur.kind]) byDate.set(h.holiday_date, h)
  }
  return [...byDate.values()].sort((a, b) => a.holiday_date.localeCompare(b.holiday_date))
}

/** Employed (not yet separated) as of the given date. */
export function isActiveOn(e: Pick<Employee, 'separation_date'>, date: string): boolean {
  return !e.separation_date || e.separation_date >= date
}

export async function getEmployees(entityId: string): Promise<Employee[]> {
  // separated employees stay on file, so large clients pass 1000 rows
  return fetchAll<Employee>((from, to) =>
    supabase.from('employees').select('*').eq('entity_id', entityId).order('last_name').order('id').range(from, to),
  )
}

export function edgeFunctionUrl(name: string): string {
  const base =
    import.meta.env.VITE_SUPABASE_URL ?? 'https://ruuhpghcgccvezkjhisy.supabase.co'
  return `${base}/functions/v1/${name}`
}

export async function callAdminUsers(
  body: Record<string, unknown>,
): Promise<{ ok?: boolean; error?: string; user_id?: string; code?: string }> {
  const { data: sess } = await supabase.auth.getSession()
  const token = sess.session?.access_token
  const res = await fetch(edgeFunctionUrl('admin-users'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  let payload: { ok?: boolean; error?: string; message?: string; msg?: string; user_id?: string; code?: string } = {}
  try {
    payload = await res.json()
  } catch {
    // non-JSON body (gateway / network error page)
  }
  // Gateway failures (expired session, function not deployed, worker crash)
  // carry no `error` key — never let a non-2xx response read as success.
  if (!res.ok) return { error: payload.error ?? payload.message ?? payload.msg ?? `Request failed (${res.status})` }
  return payload
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revoking right away can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
