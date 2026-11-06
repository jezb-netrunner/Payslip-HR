// Bulk employee import: a CSV with one row per employee (the downloadable
// template's columns), parsed and checked here before anything is saved, so
// the admin sees every problem by line first. Pure: the Employees page reads
// the file, shows the preview and inserts the rows that pass.

import type { EmploymentStatus, Entity, PaymentMethod, SeparationReason } from './db'
import { EMPLOYMENT_STATUS_LABELS, FREQUENCY_LABELS, PAYMENT_METHOD_LABELS, SEPARATION_REASON_LABELS } from './labels'
import type { PayFrequency } from '../payroll/types'

/** Largest file taken in one go: a bigger client imports in parts. */
export const IMPORT_MAX_ROWS = 1000

export interface ImportColumn {
  key: string
  required?: boolean
  /** What goes in it, for the column reference. */
  hint: string
}

const enumHint = (labels: Record<string, string>) => Object.keys(labels).join(', ')

export const IMPORT_COLUMNS: ImportColumn[] = [
  { key: 'employee_no', required: true, hint: 'Unique in this client, e.g. EMP-0001' },
  { key: 'last_name', required: true, hint: 'Family name' },
  { key: 'first_name', required: true, hint: 'Given name(s)' },
  { key: 'middle_name', hint: 'Optional' },
  { key: 'suffix', hint: 'Jr., Sr., III — optional' },
  { key: 'hire_date', required: true, hint: 'Date started: YYYY-MM-DD or MM/DD/YYYY' },
  { key: 'employment_status', hint: `${enumHint(EMPLOYMENT_STATUS_LABELS)} (blank = probationary)` },
  { key: 'position', hint: 'Job title' },
  { key: 'department', hint: 'Optional' },
  { key: 'pay_type', required: true, hint: 'daily or monthly' },
  { key: 'rate', required: true, hint: 'Pesos a day (daily) or a month (monthly), e.g. 755 or 25000' },
  { key: 'pay_frequency', hint: `${enumHint(FREQUENCY_LABELS)} (blank = the client's default)` },
  { key: 'payment_method', hint: `${enumHint(PAYMENT_METHOD_LABELS)} (blank = cash)` },
  { key: 'minimum_wage_earner', hint: 'yes or no (blank = no)' },
  { key: 'days_per_year', hint: "Rate divisor, e.g. 261 or 313 (blank = the client's)" },
  { key: 'birth_date', hint: 'YYYY-MM-DD or MM/DD/YYYY' },
  { key: 'gender', hint: 'Female, Male or Prefer not to say' },
  { key: 'civil_status', hint: 'Single, Married, Widowed or Separated' },
  { key: 'nationality', hint: 'Blank = Filipino' },
  { key: 'address', hint: 'For the BIR alphalist and 2316' },
  { key: 'zip_code', hint: '4 digits' },
  { key: 'phone', hint: 'Optional' },
  { key: 'email', hint: 'Optional, unique in this client' },
  { key: 'tin', hint: '123-456-789 or 123-456-789-00000' },
  { key: 'sss_no', hint: 'Optional' },
  { key: 'philhealth_no', hint: 'Optional' },
  { key: 'pagibig_no', hint: 'Optional' },
  { key: 'bank_name', hint: 'Optional' },
  { key: 'bank_account_no', hint: 'Optional' },
  { key: 'regularization_date', hint: 'Optional: YYYY-MM-DD or MM/DD/YYYY' },
  { key: 'separation_date', hint: 'Only for someone who already left (with separation_reason)' },
  { key: 'separation_reason', hint: `${enumHint(SEPARATION_REASON_LABELS)}` },
  { key: 'emergency_contact_name', hint: 'Optional' },
  { key: 'emergency_contact_phone', hint: 'Optional' },
]

const COLUMN_KEYS = new Set(IMPORT_COLUMNS.map((c) => c.key))
const REQUIRED = IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)

/** The template: the header row only (a sample row would be imported by mistake). */
export function templateRows(): string[][] {
  return [IMPORT_COLUMNS.map((c) => c.key)]
}

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes, a BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** A header as typed ("Employee No", "employee_no*") → its column key. */
export function headerKey(h: string): string {
  return h.trim().toLowerCase().replace(/\*/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

const norm = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/** A value matched to an option by its key or its label, any case or punctuation. */
function pick<T extends string>(raw: string, labels: Record<T, string>, aliases: Record<string, T> = {}): T | null {
  const v = norm(raw)
  for (const [k, label] of Object.entries(labels) as [T, string][]) {
    if (v === k || v === norm(label)) return k
  }
  return aliases[v] ?? null
}

/** YYYY-MM-DD or M/D/YYYY (the Philippines' month-first order) → YYYY-MM-DD, or null if not a real date. */
export function parseDate(raw: string): string | null {
  const v = raw.trim()
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900 || y > 2100) return null
  return dt.toISOString().slice(0, 10)
}

/** "₱25,000.00" → 25000; null if not a number. */
export function parseAmount(raw: string): number | null {
  const v = raw.trim().replace(/[₱,\s]|php/gi, '')
  if (!/^\d+(\.\d+)?$/.test(v)) return null
  return Number(v)
}

const TIN = /^[0-9]{3}-?[0-9]{3}-?[0-9]{3}(-?[0-9]{3,5})?$/
const GENDERS = ['Female', 'Male', 'Prefer not to say']
const CIVIL = ['Single', 'Married', 'Widowed', 'Separated']

/** What one row inserts: the employee and its career events. */
export interface ImportRecord {
  employee: Record<string, unknown>
  separation: { date: string; reason: SeparationReason } | null
}

export interface ImportRow {
  /** Line in the file (the header is line 1). */
  line: number
  employeeNo: string
  name: string
  record: ImportRecord | null
  errors: string[]
  warnings: string[]
}

export interface ImportCheck {
  rows: ImportRow[]
  /** Required columns the header row lacks: nothing can be imported. */
  missingColumns: string[]
  /** Columns the app doesn't know: ignored. */
  unknownColumns: string[]
  /** A problem with the file itself (empty, too many rows). */
  fileError: string
}

export function checkImport(
  table: string[][],
  ctx: {
    entity: Pick<Entity, 'id' | 'default_pay_frequency' | 'minimum_wage_daily' | 'working_days_divisor'>
    existingNumbers: Iterable<string>
    existingEmails: Iterable<string>
    today: string
  },
): ImportCheck {
  const nonEmpty = table.map((cells, i) => ({ cells, line: i + 1 })).filter((r) => r.cells.some((c) => c.trim() !== ''))
  const empty: ImportCheck = { rows: [], missingColumns: [], unknownColumns: [], fileError: '' }
  if (nonEmpty.length === 0) return { ...empty, fileError: 'The file is empty.' }
  const header = nonEmpty[0].cells.map(headerKey)
  const missingColumns = REQUIRED.filter((k) => !header.includes(k))
  const unknownColumns = header.filter((k) => k && !COLUMN_KEYS.has(k))
  if (missingColumns.length) return { ...empty, missingColumns, unknownColumns }
  const data = nonEmpty.slice(1)
  if (data.length === 0) return { ...empty, unknownColumns, fileError: 'The file has a header row but no employees.' }
  if (data.length > IMPORT_MAX_ROWS) {
    return { ...empty, unknownColumns, fileError: `The file has ${data.length} employees: import at most ${IMPORT_MAX_ROWS} at a time.` }
  }
  const col = (cells: string[], key: string) => {
    const i = header.indexOf(key)
    return i >= 0 ? (cells[i] ?? '').trim() : ''
  }
  const numbers = new Set([...ctx.existingNumbers].map((n) => n.trim().toLowerCase()))
  const emails = new Set([...ctx.existingEmails].map((e) => e.trim().toLowerCase()))
  const seenNo = new Map<string, number>()
  const seenEmail = new Map<string, number>()
  const divisor = Number(ctx.entity.working_days_divisor) || 261
  const minWage = Number(ctx.entity.minimum_wage_daily) || 0

  const rows = data.map(({ cells, line }): ImportRow => {
    const errors: string[] = []
    const warnings: string[] = []
    const get = (k: string) => col(cells, k)
    const employeeNo = get('employee_no')
    const first = get('first_name')
    const last = get('last_name')
    const name = [first, get('middle_name'), last].filter(Boolean).join(' ')

    if (!employeeNo) errors.push('employee_no is required')
    else {
      const key = employeeNo.toLowerCase()
      if (numbers.has(key)) errors.push(`employee no. ${employeeNo} is already in this client`)
      else if (seenNo.has(key)) errors.push(`employee no. ${employeeNo} is also on line ${seenNo.get(key)}`)
      else seenNo.set(key, line)
    }
    if (!first) errors.push('first_name is required')
    if (!last) errors.push('last_name is required')

    const date = (k: string, required = false): string | null => {
      const raw = get(k)
      if (!raw) {
        if (required) errors.push(`${k} is required`)
        return null
      }
      const d = parseDate(raw)
      if (!d) errors.push(`${k} "${raw}" is not a date (YYYY-MM-DD or MM/DD/YYYY)`)
      return d
    }
    const hire = date('hire_date', true)
    const birth = date('birth_date')
    const regularized = date('regularization_date')
    const separated = date('separation_date')
    if (hire && hire > ctx.today) warnings.push(`starts in the future (${hire})`)
    if (birth && hire && birth >= hire) errors.push('birth_date is on or after hire_date')
    if (regularized && hire && regularized < hire) errors.push('regularization_date is before hire_date')

    const status: EmploymentStatus | null = get('employment_status')
      ? pick(get('employment_status'), EMPLOYMENT_STATUS_LABELS, { learner: 'apprentice', project: 'project_based' })
      : 'probationary'
    if (!status) errors.push(`employment_status "${get('employment_status')}" is not one of ${enumHint(EMPLOYMENT_STATUS_LABELS)}`)

    const payTypeRaw = norm(get('pay_type'))
    const payType = ['daily', 'daily_rated', 'day'].includes(payTypeRaw) ? 'daily' : ['monthly', 'monthly_rated', 'month'].includes(payTypeRaw) ? 'monthly' : null
    if (!get('pay_type')) errors.push('pay_type is required (daily or monthly)')
    else if (!payType) errors.push(`pay_type "${get('pay_type')}" is not daily or monthly`)

    const rate = get('rate') ? parseAmount(get('rate')) : null
    if (!get('rate')) errors.push('rate is required')
    else if (rate === null) errors.push(`rate "${get('rate')}" is not an amount`)
    else if (rate > 10_000_000) errors.push(`rate ${rate} is too large`)

    const frequency: PayFrequency | null = get('pay_frequency')
      ? pick(get('pay_frequency'), FREQUENCY_LABELS, { semimonthly: 'semi_monthly', bi_monthly: 'semi_monthly', twice_a_month: 'semi_monthly' })
      : (ctx.entity.default_pay_frequency as PayFrequency)
    if (!frequency) errors.push(`pay_frequency "${get('pay_frequency')}" is not one of ${enumHint(FREQUENCY_LABELS)}`)

    const method: PaymentMethod | null = get('payment_method')
      ? pick(get('payment_method'), PAYMENT_METHOD_LABELS, { bank: 'bank_transfer', ewallet: 'e_wallet', gcash: 'e_wallet', cheque: 'check' })
      : 'cash'
    if (!method) errors.push(`payment_method "${get('payment_method')}" is not one of ${enumHint(PAYMENT_METHOD_LABELS)}`)

    const mweRaw = norm(get('minimum_wage_earner'))
    const mwe = ['yes', 'y', 'true', '1', 'mwe'].includes(mweRaw) ? true : ['', 'no', 'n', 'false', '0'].includes(mweRaw) ? false : null
    if (mwe === null) errors.push(`minimum_wage_earner "${get('minimum_wage_earner')}" is not yes or no`)

    let daysPerYear: number | null = null
    if (get('days_per_year')) {
      daysPerYear = parseAmount(get('days_per_year'))
      if (daysPerYear === null || daysPerYear <= 0 || daysPerYear > 366) {
        errors.push(`days_per_year "${get('days_per_year')}" must be a number from 1 to 366`)
        daysPerYear = null
      }
    }

    const tin = get('tin')
    if (tin && !TIN.test(tin)) errors.push(`tin "${tin}" is not a TIN (123-456-789 or 123-456-789-00000)`)
    const email = get('email')
    if (email) {
      const key = email.toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push(`email "${email}" is not an email address`)
      else if (emails.has(key)) errors.push(`email ${email} is already used in this client`)
      else if (seenEmail.has(key)) errors.push(`email ${email} is also on line ${seenEmail.get(key)}`)
      else seenEmail.set(key, line)
    }
    const gender = get('gender') ? GENDERS.find((g) => norm(g) === norm(get('gender'))) ?? ({ f: 'Female', m: 'Male' } as Record<string, string>)[norm(get('gender'))] : null
    if (get('gender') && !gender) errors.push(`gender "${get('gender')}" is not ${GENDERS.join(', ')}`)
    const civil = get('civil_status') ? CIVIL.find((c) => norm(c) === norm(get('civil_status'))) : null
    if (get('civil_status') && !civil) errors.push(`civil_status "${get('civil_status')}" is not ${CIVIL.join(', ')}`)
    const zip = get('zip_code')
    if (zip && !/^\d{4}$/.test(zip)) warnings.push(`zip_code "${zip}" is not 4 digits`)

    const reasonRaw = get('separation_reason')
    const reason: SeparationReason | null = reasonRaw ? pick(reasonRaw, SEPARATION_REASON_LABELS, { resigned: 'resignation', terminated: 'termination', retired: 'retirement' }) : null
    if (reasonRaw && !reason) errors.push(`separation_reason "${reasonRaw}" is not one of ${enumHint(SEPARATION_REASON_LABELS)}`)
    if (get('separation_date') && !reasonRaw) errors.push('separation_reason is required with separation_date')
    if (reasonRaw && !get('separation_date')) errors.push('separation_date is required with separation_reason')
    if (separated && hire && separated < hire) errors.push('separation_date is before hire_date')

    // the same pay checks as the Add employee form
    if (rate !== null && payType && minWage > 0) {
      const daily = payType === 'daily' ? rate : (rate * 12) / (daysPerYear ?? divisor)
      if (rate === 0) warnings.push('rate is 0 (only for someone paid by output)')
      else if (daily + 0.005 < minWage) warnings.push(`below the client's minimum wage of ₱${minWage}/day`)
      else if (daily <= minWage + 0.005 && !mwe) warnings.push('at the minimum wage but not marked minimum_wage_earner')
    }

    const opt = (k: string) => get(k) || null
    const record: ImportRecord | null =
      errors.length > 0
        ? null
        : {
            employee: {
              entity_id: ctx.entity.id,
              employee_no: employeeNo,
              first_name: first,
              middle_name: opt('middle_name'),
              last_name: last,
              suffix: opt('suffix'),
              hire_date: hire,
              employment_status: status,
              regularization_date: regularized,
              position: get('position'),
              department: get('department'),
              pay_type: payType,
              monthly_rate: payType === 'monthly' ? rate : 0,
              daily_rate: payType === 'daily' ? rate : 0,
              pay_frequency: frequency,
              payment_method: method,
              is_minimum_wage_earner: mwe,
              days_per_year: daysPerYear,
              birth_date: birth,
              gender,
              civil_status: civil ?? null,
              nationality: get('nationality') || 'Filipino',
              address: opt('address'),
              zip_code: opt('zip_code'),
              phone: opt('phone'),
              email: email || null,
              tin: tin || null,
              sss_no: opt('sss_no'),
              philhealth_no: opt('philhealth_no'),
              pagibig_no: opt('pagibig_no'),
              bank_name: opt('bank_name'),
              bank_account_no: opt('bank_account_no'),
              emergency_contact_name: opt('emergency_contact_name'),
              emergency_contact_phone: opt('emergency_contact_phone'),
              separation_date: separated,
              separation_reason: reason,
            },
            separation: separated && reason ? { date: separated, reason } : null,
          }
    return { line, employeeNo, name: name || '(no name)', record, errors, warnings }
  })
  return { rows, missingColumns: [], unknownColumns, fileError: '' }
}
