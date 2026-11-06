import { describe, expect, it } from 'vitest'
import { checkImport, headerKey, IMPORT_COLUMNS, parseAmount, parseCsv, parseDate, templateRows } from './employeeImport'
import { toCsv } from './csv'

const entity = { id: 'ent', default_pay_frequency: 'semi_monthly', minimum_wage_daily: 755, working_days_divisor: 261 } as const
const ctx = { entity, existingNumbers: ['EMP-001'], existingEmails: ['taken@acme.ph'], today: '2026-11-06' }
const HEAD = 'employee_no,last_name,first_name,hire_date,pay_type,rate'
const check = (csv: string) => checkImport(parseCsv(csv), ctx as never)

describe('CSV parsing', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n"line\nbreak",,x\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['line\nbreak', '', 'x'],
    ])
  })
  it('reads back what the app writes', () => {
    const rows = [['EMP-1', 'Dela Cruz, Jr.', 'Ana "Annie"', '2026-01-05']]
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
  it('matches headers however they are typed', () => {
    expect(['Employee No*', ' employee_no ', 'EMPLOYEE-NO'].map(headerKey)).toEqual(['employee_no', 'employee_no', 'employee_no'])
  })
  it('reads ISO and month-first dates and refuses impossible ones', () => {
    expect(['2026-01-05', '1/5/2026', '01/05/2026', '2024-02-29'].map(parseDate)).toEqual(['2026-01-05', '2026-01-05', '2026-01-05', '2024-02-29'])
    expect(['2026-02-30', '13/01/2026', '5 Jan 2026', '2026/01/05', ''].map(parseDate)).toEqual([null, null, null, null, null])
  })
  it('reads amounts with peso signs and thousands separators', () => {
    expect(['25,000.00', '₱755', 'PHP 1,234.5', '0'].map(parseAmount)).toEqual([25000, 755, 1234.5, 0])
    expect(['-5', '1.2.3', 'abc', '1e5'].map(parseAmount)).toEqual([null, null, null, null])
  })
  it('the template is the header row of every column', () => {
    expect(templateRows()).toEqual([IMPORT_COLUMNS.map((c) => c.key)])
  })
})

describe('checking an import', () => {
  it('builds the employee from a minimal row with the defaults', () => {
    const r = check(`${HEAD}\nEMP-100,Santos,Maria,2026-03-01,monthly,"25,000"`)
    expect(r.fileError).toBe('')
    expect(r.rows[0]).toMatchObject({ line: 2, employeeNo: 'EMP-100', name: 'Maria Santos', errors: [], warnings: [] })
    expect(r.rows[0].record!.employee).toMatchObject({
      entity_id: 'ent', employee_no: 'EMP-100', first_name: 'Maria', last_name: 'Santos', hire_date: '2026-03-01',
      employment_status: 'probationary', pay_type: 'monthly', monthly_rate: 25000, daily_rate: 0,
      pay_frequency: 'semi_monthly', payment_method: 'cash', is_minimum_wage_earner: false, nationality: 'Filipino',
      separation_date: null, separation_reason: null,
    })
    expect(r.rows[0].record!.separation).toBeNull()
  })

  it('takes options by key or label, any case', () => {
    const r = check(
      'employee_no,last_name,first_name,hire_date,pay_type,rate,employment_status,pay_frequency,payment_method,minimum_wage_earner,gender,civil_status\n' +
        'E1,Cruz,Ana,1/5/2026,Daily,755,Project-based,Semi-monthly,Bank transfer,Yes,f,married\n' +
        'E2,Reyes,Jose,2026-01-05,MONTHLY,30000,regular,weekly,GCash,no,Male,Single',
    )
    expect(r.rows.map((x) => x.errors)).toEqual([[], []])
    expect(r.rows[0].record!.employee).toMatchObject({
      employment_status: 'project_based', pay_frequency: 'semi_monthly', payment_method: 'bank_transfer',
      is_minimum_wage_earner: true, daily_rate: 755, gender: 'Female', civil_status: 'Married', hire_date: '2026-01-05',
    })
    expect(r.rows[1].record!.employee).toMatchObject({ employment_status: 'regular', pay_frequency: 'weekly', payment_method: 'e_wallet', gender: 'Male' })
  })

  it('reports every problem of a row, by line, and builds nothing for it', () => {
    const r = check(
      'employee_no,last_name,first_name,hire_date,pay_type,rate,tin,email,pay_frequency,separation_date\n' +
        ',,,2026-13-01,hourly,abc,12-34,not-an-email,fortnightly,2026-05-01\n',
    )
    expect(r.rows[0].record).toBeNull()
    expect(r.rows[0].errors).toEqual([
      'employee_no is required',
      'first_name is required',
      'last_name is required',
      'hire_date "2026-13-01" is not a date (YYYY-MM-DD or MM/DD/YYYY)',
      'pay_type "hourly" is not daily or monthly',
      'rate "abc" is not an amount',
      'pay_frequency "fortnightly" is not one of weekly, semi_monthly, monthly',
      'tin "12-34" is not a TIN (123-456-789 or 123-456-789-00000)',
      'email "not-an-email" is not an email address',
      'separation_reason is required with separation_date',
    ])
  })

  it('skips employee numbers and emails already in the client or earlier in the file', () => {
    const r = check(
      `${HEAD},email\nEMP-001,A,B,2026-01-05,daily,800,\nemp-200,C,D,2026-01-05,daily,800,x@acme.ph\nEMP-200,E,F,2026-01-05,daily,800,X@acme.ph\nEMP-300,G,H,2026-01-05,daily,800,TAKEN@acme.ph`,
    )
    expect(r.rows.map((x) => x.errors)).toEqual([
      ['employee no. EMP-001 is already in this client'],
      [],
      ['employee no. EMP-200 is also on line 3', 'email X@acme.ph is also on line 3'],
      ['email TAKEN@acme.ph is already used in this client'],
    ])
  })

  it('records a separation with its reason, and checks the dates against the hire date', () => {
    const r = check(
      `${HEAD},separation_date,separation_reason,birth_date\nE1,A,B,2025-01-06,monthly,30000,2026-06-30,Resigned,1990-02-03\nE2,C,D,2026-01-05,daily,800,2025-12-31,resignation,2026-02-01`,
    )
    expect(r.rows[0].record!.separation).toEqual({ date: '2026-06-30', reason: 'resignation' })
    expect(r.rows[0].record!.employee).toMatchObject({ separation_date: '2026-06-30', separation_reason: 'resignation', birth_date: '1990-02-03' })
    expect(r.rows[1].errors).toEqual(['birth_date is on or after hire_date', 'separation_date is before hire_date'])
  })

  it('warns like the Add employee form about the minimum wage, without blocking', () => {
    const r = check(`${HEAD},minimum_wage_earner\nE1,A,B,2026-01-05,daily,700,no\nE2,C,D,2026-01-05,daily,755,no\nE3,E,F,2026-01-05,monthly,16421.25,yes\nE4,G,H,2027-01-05,daily,900,`)
    expect(r.rows.map((x) => x.warnings)).toEqual([
      ["below the client's minimum wage of ₱755/day"],
      ['at the minimum wage but not marked minimum_wage_earner'],
      [],
      ['starts in the future (2027-01-05)'],
    ])
    expect(r.rows.every((x) => x.record)).toBe(true)
  })

  it('refuses a file without the required columns, and lists unknown ones', () => {
    const r = check('employee_no,first_name,favourite_color\nE1,Ana,blue')
    expect(r.missingColumns).toEqual(['last_name', 'hire_date', 'pay_type', 'rate'])
    expect(r.unknownColumns).toEqual(['favourite_color'])
    expect(r.rows).toEqual([])
  })

  it('ignores blank lines and says when there is nothing to import', () => {
    expect(check('').fileError).toBe('The file is empty.')
    expect(check(`${HEAD}\n,,,,,\n\n`).fileError).toBe('The file has a header row but no employees.')
    const r = check(`\n${HEAD}\n\nE1,A,B,2026-01-05,daily,800\n`)
    expect(r.rows.map((x) => x.line)).toEqual([4])
  })

  it('caps one import at 1,000 employees', () => {
    const body = Array.from({ length: 1001 }, (_, i) => `E${i},A,B,2026-01-05,daily,800`).join('\n')
    expect(check(`${HEAD}\n${body}`).fileError).toBe('The file has 1001 employees: import at most 1000 at a time.')
  })
})
