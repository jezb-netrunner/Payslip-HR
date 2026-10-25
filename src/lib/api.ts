import { fetchAll } from './fetchAll'
import { toCsv } from './csv'
import {
  isAuthApiError,
  isAuthRefreshDiscardedError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type AuthError,
} from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Employee, Entity, Holiday, StatutoryVersion } from './db'
import { DEFAULT_PAYROLL_RULES } from '../payroll/defaults'
import type { PayCode, PayrollRules, StatutoryTables } from '../payroll/types'
import { pickStatutoryTables } from '../payroll/versions'

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
  return pickStatutoryTables((data ?? []) as StatutoryVersion[], asOf)
}

/** The pay codes on file (reference data shipped by migration, read-only), in display order. */
export async function getPayCodes(): Promise<PayCode[]> {
  const { data, error } = await supabase.from('pay_codes').select('*').order('sort_order')
  if (error) throw error
  return (data ?? []) as PayCode[]
}

/** The PENDING rules company admins set for every client (one row; the defaults when it can't be read). */
export async function getPayrollRules(): Promise<PayrollRules> {
  const { data, error } = await supabase.from('payroll_rules').select('*').maybeSingle()
  if (error) throw error
  const row = (data ?? {}) as Record<string, unknown>
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  const base = DEFAULT_PAYROLL_RULES.pagibigBase
  return {
    maternityContributions: (row.maternity_contributions as PayrollRules['maternityContributions']) ?? DEFAULT_PAYROLL_RULES.maternityContributions,
    pagibigBase: {
      basic: flag(row.pagibig_base_basic, base.basic),
      cola: flag(row.pagibig_base_cola, base.cola),
      otherAllowances: flag(row.pagibig_base_other_allowances, base.otherAllowances),
    },
    pagibigCeiling: row.pagibig_ceiling == null ? DEFAULT_PAYROLL_RULES.pagibigCeiling : Number(row.pagibig_ceiling),
  }
}

/** Company admins: set one PENDING rule (spec P4, P5). */
export async function setPayrollRule(rule: string, value: string): Promise<void> {
  const { error } = await supabase.rpc('set_payroll_rule', { p_rule: rule, p_value: value })
  if (error) throw error
}

/** Company admins: whether a pay code is taxable (P1) or counts toward the 13th month (P9). */
export async function setPayCodeRule(code: string, rule: 'taxable' | 'include_in_13th_month_base', value: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_pay_code_rule', { p_code: code, p_rule: rule, p_value: value })
  if (error) throw error
}

/** Company admins: whether a pay code whose SSS treatment the law hasn't settled is in the SSS base (spec P2, P3). */
export async function setPayCodeSssInclude(code: string, include: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_pay_code_sss_include', { p_code: code, p_include: include })
  if (error) throw error
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

/** Shown when the access token outlived its session (signed out elsewhere, or revoked). */
export const SESSION_ENDED =
  'Your sign-in has ended — you were signed out on another device or tab. Please sign in again.'

const OFFLINE = 'Could not reach the server — check your connection and try again.'

const AUTH_BUSY = "Couldn't confirm your sign-in just now — please try again in a moment."

// Supabase Auth's answers that mean the session itself is over (signed out
// elsewhere, code replaced, token reused). Anything else — a 5xx, rate limit,
// another tab refreshing at the same moment — is not a reason to sign out.
const ENDED_CODES = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_banned', 'user_not_found'])
function sessionEnded(e: AuthError): boolean {
  if (isAuthSessionMissingError(e)) return true
  return isAuthApiError(e) && (ENDED_CODES.has(e.code ?? '') || e.status === 400 || e.status === 401 || e.status === 403)
}
function authProblem(e: AuthError): string {
  return isAuthRetryableFetchError(e) ? OFFLINE : sessionEnded(e) ? SESSION_ENDED : AUTH_BUSY
}

type AdminUsersResult = { ok?: boolean; error?: string; user_id?: string; code?: string }

/**
 * Calls the admin-users edge function as the signed-in user. The function
 * checks the session with Supabase Auth, which the rest of the API doesn't:
 * an access token keeps working for database reads and writes until it
 * expires, even after its session was ended (signed out on another device,
 * code replaced). So a 401 gets one token refresh and a retry; if the
 * session can't be refreshed it is over — sign out here too, instead of
 * leaving a page that looks signed in but can't save.
 */
export async function callAdminUsers(body: Record<string, unknown>): Promise<AdminUsersResult> {
  const { data: sess, error: sessErr } = await supabase.auth.getSession()
  // an expired token whose refresh couldn't reach the server is a connection problem, not a sign-out
  if (!sess.session) return { error: sessErr ? authProblem(sessErr) : SESSION_ENDED }
  let res = await postAdminUsers(sess.session.access_token, body)
  if (res.status === 401) {
    const refreshed = await supabase.auth.refreshSession()
    // (auth-js answers a discarded refresh with data: null, whatever its types say)
    let token = refreshed.data?.session?.access_token
    let error = refreshed.error
    // another tab refreshed the same session at the same moment: use what it stored
    if (error && isAuthRefreshDiscardedError(error)) {
      const again = await supabase.auth.getSession()
      token = again.data.session?.access_token
      error = again.error
    }
    if (error && !sessionEnded(error)) return { error: authProblem(error) }
    if (!token) {
      await supabase.auth.signOut({ scope: 'local' })
      return { error: SESSION_ENDED }
    }
    res = await postAdminUsers(token, body)
  }
  let payload: AdminUsersResult & { message?: string; msg?: string } = {}
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

function postAdminUsers(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(edgeFunctionUrl('admin-users'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  downloadBlob(filename, new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
}

export function downloadBlob(filename: string, blob: Blob) {
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
