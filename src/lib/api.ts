import { supabase } from './supabase'
import type { CompanySettings, Employee, Holiday, StatutoryVersion } from './db'
import type {
  BirAnnualData,
  BirWhtData,
  PagibigData,
  PhilHealthData,
  SssTableData,
  StatutoryTables,
} from '../payroll/types'

export async function getSettings(): Promise<CompanySettings> {
  const { data, error } = await supabase.from('company_settings').select('*').eq('id', 1).single()
  if (error) throw error
  return data as CompanySettings
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
      'Statutory tables are incomplete for ' + asOf + '. Seed statutory_versions first.',
    )
  }
  return { sss, philhealth, pagibig, bir_wht, bir_annual }
}

export async function getHolidaysBetween(start: string, end: string): Promise<Holiday[]> {
  const { data, error } = await supabase
    .from('holidays')
    .select('*')
    .gte('holiday_date', start)
    .lte('holiday_date', end)
    .order('holiday_date')
  if (error) throw error
  return (data ?? []) as Holiday[]
}

export async function getEmployees(activeOnly = false): Promise<Employee[]> {
  let q = supabase.from('employees').select('*').order('last_name')
  if (activeOnly) {
    q = q.not('employment_status', 'in', '("resigned","terminated","retired")')
  }
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as Employee[]
}

// ---------- punch device helpers ----------

export function getDeviceInfo(): Record<string, string> {
  let fingerprint = ''
  try {
    fingerprint = localStorage.getItem('phr_device_id') ?? ''
    if (!fingerprint) {
      fingerprint = crypto.randomUUID()
      localStorage.setItem('phr_device_id', fingerprint)
    }
  } catch {
    fingerprint = 'no-storage'
  }
  return {
    fingerprint,
    user_agent: navigator.userAgent,
    platform: navigator.platform ?? '',
    screen: `${window.screen.width}x${window.screen.height}`,
  }
}

export function getLocation(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 },
    )
  })
}

export async function uploadPunchSelfie(
  employeeId: string,
  blob: Blob,
  direction: 'in' | 'out',
): Promise<string> {
  const path = `${employeeId}/${Date.now()}-${direction}.jpg`
  const { error } = await supabase.storage
    .from('punch-selfies')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false })
  if (error) throw error
  return path
}

export async function signedSelfieUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('punch-selfies').createSignedUrl(path, 3600)
  if (error) return null
  return data.signedUrl
}

export function edgeFunctionUrl(name: string): string {
  const base =
    import.meta.env.VITE_SUPABASE_URL ?? 'https://ruuhpghcgccvezkjhisy.supabase.co'
  return `${base}/functions/v1/${name}`
}

export async function callAdminUsers(body: Record<string, unknown>): Promise<{ ok?: boolean; error?: string; user_id?: string }> {
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
  return res.json()
}

export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
