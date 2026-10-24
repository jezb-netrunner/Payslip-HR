import { describe, expect, it } from 'vitest'
import {
  advancesReport,
  attendanceReport,
  cellText,
  costReport,
  customReport,
  headcountReport,
  leaveReport,
  monthsIn,
  overtimeReport,
  presetRange,
  probationEnds,
  reportCsv,
  toDayFacts,
  toSlipFact,
  whoOf,
  type AdvanceRow,
  type PersonRow,
  type SlipFact,
} from './insights'

const fact = (over: Partial<SlipFact>): SlipFact => ({
  employeeId: 'e1',
  name: 'Ana Cruz',
  employeeNo: 'E1',
  department: 'Sales',
  position: 'Clerk',
  payType: 'monthly',
  month: '2026-09',
  runType: 'regular',
  periodEnd: '2026-09-15',
  basic: 10000,
  overtime: 0,
  nightDiff: 0,
  premiums: 0,
  allowances: 0,
  thirteenth: 0,
  other: 0,
  gross: 10000,
  er: 1000,
  ee: 800,
  tax: 0,
  net: 9200,
  absenceDeduction: 0,
  tardinessDeduction: 0,
  advanceDeducted: 0,
  loanDeducted: 0,
  otHours: 0,
  ndHours: 0,
  lateMinutes: 0,
  undertimeMinutes: 0,
  absentDays: 0,
  daysWorked: 11,
  hoursWorked: 88,
  ...over,
})

const person = (over: Partial<PersonRow>): PersonRow => ({
  id: 'p1',
  first_name: 'Ana',
  middle_name: null,
  last_name: 'Cruz',
  suffix: null,
  employee_no: 'E1',
  department: 'Sales',
  position: 'Clerk',
  hire_date: '2020-01-06',
  separation_date: null,
  separation_reason: null,
  employment_status: 'regular',
  pay_type: 'monthly',
  monthly_rate: 26100,
  daily_rate: 0,
  days_per_year: null,
  ...over,
})

const texts = (r: { insights: { text: string }[] }) => r.insights.map((i) => i.text)

describe('periods', () => {
  it('turns presets into whole payroll months', () => {
    expect(presetRange('last_3', '2026-10-24')).toEqual({ from: '2026-08', to: '2026-10' })
    expect(presetRange('last_month', '2026-01-05')).toEqual({ from: '2025-12', to: '2025-12' })
    expect(presetRange('this_year', '2026-10-24')).toEqual({ from: '2026-01', to: '2026-10' })
    expect(presetRange('last_year', '2026-10-24')).toEqual({ from: '2025-01', to: '2025-12' })
    expect(monthsIn({ from: '2025-11', to: '2026-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
})

describe('payslip facts', () => {
  it('sorts the lines into the cost parts and keeps gross whole', () => {
    const f = toSlipFact({
      employee_id: 'e1',
      run_type: 'regular',
      period_month: '2026-10-01',
      period_start: '2026-10-01',
      period_end: '2026-10-15',
      employee_snapshot: { name: 'Ana Cruz', employee_no: 'E1', department: 'Sales', position: 'Clerk', pay_type: 'monthly' },
      earnings: [
        { code: 'basic', label: 'Basic Pay', amount: 10000 },
        { code: 'absence', label: 'Absences', amount: -500 },
        { code: 'late', label: 'Tardiness', amount: -100 },
        { code: 'ot', label: 'Overtime Pay', amount: 1200, hours: 8 },
        { code: 'nd', label: 'Night Differential', amount: 300 },
        { code: 'holiday', label: 'Holiday Pay', amount: 800 },
        { code: 'allowance', label: 'Rice', amount: 1000 },
        { code: 'adjustment', label: 'Bonus', amount: 200 },
      ],
      deductions: [
        { code: 'other:cash_advance', label: 'Cash advance', amount: 500 },
        { code: 'other:company_loan', label: 'Loan', amount: 300 },
      ],
      gross_pay: 12900,
      net_pay: 10000,
      withholding_tax: 400,
      sss_ee: 500,
      sss_mpf_ee: 0,
      philhealth_ee: 250,
      pagibig_ee: 200,
      sss_er: 1000,
      sss_mpf_er: 0,
      sss_ec_er: 10,
      philhealth_er: 250,
      pagibig_er: 200,
      overtime_hours: 8,
      night_diff_hours: 3,
      late_minutes: 12,
      undertime_minutes: 0,
      absent_days: 1,
      days_worked: 10,
      hours_worked: 80,
    })
    expect(f).toMatchObject({
      month: '2026-10',
      department: 'Sales',
      basic: 9400,
      overtime: 1200,
      nightDiff: 300,
      premiums: 800,
      allowances: 1000,
      other: 200,
      gross: 12900,
      er: 1460,
      ee: 950,
      absenceDeduction: 500,
      tardinessDeduction: 100,
      advanceDeducted: 500,
      loanDeducted: 300,
    })
  })
})

describe('payroll cost report', () => {
  const slips = [
    fact({}),
    fact({ employeeId: 'e2', name: 'Ben Diaz', department: 'Ops', basic: 8000, overtime: 2000, gross: 10000, er: 900 }),
    fact({ month: '2026-10' }),
    fact({ month: '2026-10', employeeId: 'e2', name: 'Ben Diaz', department: 'Ops', basic: 8000, overtime: 4000, gross: 12000, er: 900 }),
    fact({ month: '2026-11', gross: 99999 }), // outside the range
  ]
  const r = costReport(slips, { from: '2026-09', to: '2026-10' }, 'month')

  it('totals employer cost and its parts by month', () => {
    const t = r.tables[0]
    expect(t.rows.map((x) => [x.label, x.cost, x.perHead])).toEqual([
      ['Sep 2026', 21900, 10950],
      ['Oct 2026', 23900, 11950],
    ])
    expect(t.total).toMatchObject({ gross: 42000, er: 3800, cost: 45800, perHead: 11450, employees: 2 })
    // the stacked parts add up to each month's cost
    const chart = r.charts[0]
    expect(chart.stacked).toBe(true)
    expect(chart.series.reduce((s, x) => s + x.values[0], 0)).toBe(21900)
  })

  it('explains what moved and what stands out', () => {
    const t = texts(r)
    expect(t).toContain('Oct 2026 cost ₱23,900.00, up 9.1% from Sep 2026 — mostly overtime & premiums (+₱2,000.00).')
    expect(r.insights.find((i) => i.text.startsWith('Overtime, night differential'))?.tone).toBe('warn')
    expect(t.some((x) => x.includes('about ₱3,000.00 for this period'))).toBe(true) // 36,000 basic / 12
    expect(t.some((x) => x.startsWith('Ops takes 52% of the cost with 50% of the headcount'))).toBe(true)
  })

  it('groups by department, largest first', () => {
    const byDept = costReport(slips, { from: '2026-09', to: '2026-10' }, 'department')
    expect(byDept.tables[0].rows.map((x) => [x.label, x.cost])).toEqual([
      ['Ops', 23800],
      ['Sales', 22000],
    ])
    expect(byDept.charts.map((c) => c.kind)).toEqual(['columns', 'bars'])
  })

  it('says so when nothing was finalized', () => {
    const empty = costReport([], { from: '2026-09', to: '2026-10' }, 'month')
    expect(empty.charts).toEqual([])
    expect(texts(empty)[0]).toMatch(/No finalized payroll/)
  })
})

describe('overtime report', () => {
  const ot = (id: string, name: string, hours: number, end: string) =>
    fact({ employeeId: id, name, month: '2026-10', periodEnd: end, otHours: hours, overtime: hours * 100 })
  const slips = [
    ot('e1', 'Ana', 40, '2026-10-05'),
    ot('e1', 'Ana', 40, '2026-10-12'),
    ot('e1', 'Ana', 40, '2026-10-19'),
    ot('e2', 'Ben', 30, '2026-10-05'),
    ot('e2', 'Ben', 30, '2026-10-12'),
    ot('e3', 'Carla', 20, '2026-10-05'),
    ot('e4', 'Dan', 5, '2026-10-05'),
    fact({ employeeId: 'e5', name: 'Eve', month: '2026-10' }),
  ]
  const r = overtimeReport(slips, { from: '2026-10', to: '2026-10' }, 'employee', { standardHours: 8, workingDaysPerYear: 261 })

  it('ranks who works overtime', () => {
    expect(r.tables[0].rows.slice(0, 2).map((x) => [x.label, x.otHours, x.withOt])).toEqual([
      ['Ana', 120, '3 of 3'],
      ['Ben', 60, '2 of 2'],
    ])
    expect(r.kpis[0]).toMatchObject({ value: '205', sub: '4 employees with overtime' })
  })

  it('flags concentration, routine overtime and its full-time equivalent', () => {
    const t = texts(r)
    expect(t[0]).toMatch(/^Ana, Ben and Carla worked 98% of all overtime hours/)
    expect(r.insights[0].tone).toBe('warn')
    expect(t.some((x) => x.startsWith('Overtime is routine for 1 employee') && x.includes('Ana (3 of 3)'))).toBe(true)
    // 205 h against 8 h × 261/12 days = 174 h a month
    expect(t.some((x) => x.includes('equal about 1.2 full-time'))).toBe(true)
  })
})

describe('attendance report', () => {
  const who = (id: string, name: string) => whoOf(id, { name, department: 'Ops', pay_type: 'monthly' })
  const weekdays = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']
  const weeks = [0, 7, 14]
  const shift = (d: string, n: number) => {
    const t = new Date(`${d}T00:00:00Z`)
    t.setUTCDate(t.getUTCDate() + n)
    return t.toISOString().slice(0, 10)
  }
  const day = (date: string, over: Record<string, unknown> = {}) => ({
    date,
    dayType: 'regular',
    scheduled: true,
    workedMinutes: 480,
    absent: false,
    onPaidLeave: false,
    onUnpaidLeave: false,
    lateMinutes: 0,
    undertimeMinutes: 0,
    ...over,
  })
  const anaDays = weeks.flatMap((w) =>
    weekdays.map((d) => {
      const date = shift(d, w)
      if (d === '2026-10-05') return day(date, { workedMinutes: 0, absent: true })
      if (w === 0 && d !== '2026-10-09') return day(date, { lateMinutes: 15 })
      return day(date)
    }),
  )
  const benDays = weeks.flatMap((w) => weekdays.map((d) => day(shift(d, w))))
  const days = [
    ...toDayFacts(who('a', 'Ana'), anaDays),
    ...toDayFacts(who('b', 'Ben'), benDays),
    // the same Monday again from an off-cycle payslip: counted once
    ...toDayFacts(who('a', 'Ana'), [day('2026-10-05', { workedMinutes: 0, absent: true })]),
    // a rest day worked is not a scheduled day
    ...toDayFacts(who('b', 'Ben'), [day('2026-10-10', { scheduled: false, dayType: 'rest_day' })]),
  ]
  const r = attendanceReport(days, [], { from: '2026-10', to: '2026-10' }, 'employee')

  it('rates absences on scheduled days and late arrivals on days worked', () => {
    expect(r.tables[0].total).toMatchObject({ expected: 30, worked: 27, absent: 3, late: 3, lateMinutes: 45 })
    expect(r.kpis[0]).toMatchObject({ value: '10%', tone: 'warn' })
  })

  it('finds the weekday pattern, the frequent late and absent, and perfect attendance', () => {
    const t = texts(r)
    expect(t).toContain('Absences peak on Mondays: 50% of scheduled days against 0% on the other days.')
    expect(t).toContain('Most often late: Ana (3 times, 45m).')
    expect(t).toContain('Absent 3 days or more without leave: Ana (3).')
    expect(t.some((x) => x.startsWith('Perfect attendance') && x.endsWith('Ben.'))).toBe(true)
    expect(r.charts[0].categories).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
  })
})

describe('headcount and turnover report', () => {
  const people = [
    person({ id: 'p1' }),
    person({ id: 'p2', first_name: 'Ben', employment_status: 'probationary', hire_date: '2026-04-01' }),
    person({ id: 'p3', first_name: 'Carla', employment_status: 'probationary', hire_date: '2026-05-10' }),
    person({ id: 'p4', first_name: 'Dan', hire_date: '2026-06-01', separation_date: '2026-08-15', separation_reason: 'resignation' }),
    person({ id: 'p5', first_name: 'Eve', hire_date: '2025-01-01', separation_date: '2026-09-30', separation_reason: 'end_of_contract' }),
    person({ id: 'p6', first_name: 'Fe', hire_date: '2026-08-01', pay_type: 'daily', daily_rate: 500, monthly_rate: 0 }),
    person({ id: 'p7', first_name: 'Gil', hire_date: '2026-07-05', separation_date: '2026-07-31', separation_reason: 'termination' }),
  ]
  const r = headcountReport(people, { from: '2026-07', to: '2026-10' }, '2026-10-24', { workingDaysPerYear: 261, minimumWageDaily: 645, minimumWageRegion: 'NCR' })

  it('counts headcount, hires and separations month by month', () => {
    expect(r.tables[0].rows.map((x) => [x.label, x.opening, x.hires, x.seps, x.closing])).toEqual([
      ['Jul 2026', 5, 1, 1, 6],
      ['Aug 2026', 6, 1, 1, 5],
      ['Sep 2026', 5, 0, 1, 5],
      ['Oct 2026', 5, 0, 0, 4],
    ])
    expect(r.kpis.map((k) => k.value)).toEqual(['4', '2', '3', '60%', expect.any(String)])
    expect(r.kpis[3].sub).toBe('about 180% a year at this pace')
  })

  it('flags early leavers, probation deadlines and pay under the minimum wage', () => {
    const t = texts(r)
    expect(probationEnds('1996-05-27')).toBe('1996-11-23') // the Mitsubishi case
    expect(probationEnds('2026-05-10')).toBe('2026-11-06')
    expect(t.some((x) => x.startsWith('2 of the 3 separations came within the first six months'))).toBe(true)
    expect(t.some((x) => x.startsWith('Still probationary after six months: Ben Cruz (since Apr 1, 2026)'))).toBe(true)
    expect(t.some((x) => x.startsWith('Probation ends within 30 days for Carla Cruz (Nov 6, 2026)'))).toBe(true)
    expect(t.some((x) => x.startsWith("Paid below the client's minimum wage setting (₱645.00 a day, NCR; 75% of it for apprentices and learners): Fe Cruz (₱500.00)"))).toBe(true)
    expect(t).toContain('Why they left: resignation 1, end of contract / project 1, termination 1.')
  })
})

describe('leave report', () => {
  const types = [
    { id: 'sil', code: 'SIL', name: 'Service Incentive Leave', paid: true, default_annual_days: 5, min_service_months: 12 },
    { id: 'sl', code: 'SL', name: 'Sick Leave', paid: true, default_annual_days: 5, min_service_months: 0 },
    { id: 'lw', code: 'LWOP', name: 'Leave without pay', paid: false, default_annual_days: 0, min_service_months: 0 },
  ]
  const people = [
    person({ id: 'p1' }),
    person({ id: 'p2', first_name: 'Ben', hire_date: '2026-04-01' }),
    person({ id: 'p3', first_name: 'Carla', hire_date: '2024-01-01', department: 'Ops', pay_type: 'daily', daily_rate: 600, monthly_rate: 0 }),
  ]
  const requests = [
    { employee_id: 'p1', leave_type_id: 'sil', start_date: '2026-03-02', end_date: '2026-03-03', days: 2 },
    { employee_id: 'p1', leave_type_id: 'sl', start_date: '2026-10-05', end_date: '2026-10-05', days: 1 },
    { employee_id: 'p3', leave_type_id: 'lw', start_date: '2026-10-12', end_date: '2026-10-14', days: 3 },
    { employee_id: 'p3', leave_type_id: 'sil', start_date: '2026-08-10', end_date: '2026-08-10', days: 1 },
  ]
  const entitlements = [{ employee_id: 'p3', leave_type_id: 'sil', year: 2026, days: 7 }]
  const r = leaveReport(requests, types, people, entitlements, { from: '2026-10', to: '2026-10' }, 'leave_type', '2026-10-24', {
    workingDaysPerYear: 261,
    minimumWageDaily: 0,
  })

  it('counts leave starting in the period, paid and unpaid', () => {
    expect(r.tables[0].rows.map((x) => [x.label, x.days, x.unpaid])).toEqual([
      ['Leave without pay', 3, 3],
      ['Sick Leave', 1, 0],
    ])
  })

  it('values unused SIL at current daily rates', () => {
    // Ana: 5 - 2 = 3 days × 26,100 × 12 / 261 = 1,200; Carla: 7 - 1 = 6 days × 600; Ben has not served a year
    expect(r.tables[1].rows.map((x) => [x.label, x.left, x.value])).toEqual([
      ['Ana Cruz', 3, 3600],
      ['Carla Cruz', 6, 3600],
    ])
    expect(r.kpis[3]).toMatchObject({ value: '₱7,200.00' })
    expect(texts(r).some((x) => x.startsWith('Unused service incentive leave: 9 days across 2 employees, about ₱7,200.00'))).toBe(true)
    expect(texts(r)).toContain('No leave taken in 2026 yet: Ben Cruz.')
  })
})

describe('cash advances report', () => {
  const adv = (over: Partial<AdvanceRow>): AdvanceRow => ({
    id: 'a1',
    employee_id: 'e1',
    category: 'cash_advance',
    label: 'Cash advance',
    total_amount: 10000,
    balance: 8000,
    amount_per_period: 1000,
    active: true,
    released_on: '2026-06-01',
    ...over,
  })
  const deductions = [
    adv({}),
    adv({ id: 'a2', employee_id: 'e2', total_amount: 6000, balance: 6000, amount_per_period: 0, released_on: '2026-09-10' }),
    adv({ id: 'a3', employee_id: 'e2', total_amount: 2000, balance: 1500, amount_per_period: 500, active: false, released_on: '2026-08-20' }),
    adv({ id: 'a4', total_amount: 3000, balance: 3000, released_on: '2026-10-20' }),
    adv({ id: 'l1', category: 'company_loan', total_amount: 5000, balance: 5000, released_on: null }),
  ]
  const people = [
    person({ id: 'e1', monthly_rate: 20000 }),
    person({ id: 'e2', first_name: 'Ben', pay_type: 'daily', daily_rate: 500, monthly_rate: 0 }),
  ]
  const slips = [
    fact({ employeeId: 'e1', month: '2026-10', periodEnd: '2026-10-15', advanceDeducted: 1000 }),
    fact({ employeeId: 'e1', month: '2026-09', periodEnd: '2026-09-30', advanceDeducted: 1000 }),
    fact({ employeeId: 'e2', month: '2026-10', periodEnd: '2026-10-15' }),
    fact({ employeeId: 'e2', month: '2026-09', periodEnd: '2026-09-30' }),
  ]
  const r = advancesReport(deductions, [{ advance_id: 'a1', amount: 500, paid_on: '2026-10-10' }], slips, people, { from: '2026-10', to: '2026-10' }, '2026-10-24', {
    workingDaysPerYear: 261,
    minimumWageDaily: 0,
  })

  it('totals what is owed, released and collected', () => {
    expect(r.kpis.map((k) => k.value)).toEqual(['₱18,500.00', '₱3,000.00', '₱1,500.00', '₱5,000.00'])
    expect(r.tables[0].rows.map((x) => [x.label, x.owed, x.installment])).toEqual([
      ['Ana Cruz', 11000, '₱2,000.00'],
      ['Ben Cruz', 7500, 'agreed each payroll'],
    ])
    expect(r.tables[1].rows.find((b) => b.label === 'Over 90 days')).toMatchObject({ advances: 1, owed: 8000 })
  })

  it('flags old balances, exposure, stalled and paused advances', () => {
    const t = texts(r)
    expect(t[0]).toBe('₱3,000.00 released and ₱1,500.00 collected in the period: what employees owe grew by ₱1,500.00.')
    expect(t).toContain('₱8,000.00 (1 advance) was released more than 90 days ago and is still owed.')
    // 11,000 of 20,000; 7,500 of 500 × 261 / 12 = 10,875
    expect(t.some((x) => x.startsWith("Owing half a month's pay or more: Ana Cruz (55%) and Ben Cruz (69%)"))).toBe(true)
    expect(t.some((x) => x.startsWith('Nothing deducted in their last 2 payrolls: Ben Cruz (₱7,500.00)'))).toBe(true)
    expect(t).toContain('1 paused advance (₱1,500.00) is not being collected.')
  })
})

describe('custom report and exports', () => {
  const slips = [
    fact({ department: 'Ops', gross: 12000, otHours: 5 }),
    fact({ employeeId: 'e2', department: 'Ops', gross: 8000, otHours: 1 }),
    fact({ employeeId: 'e3', department: 'Sales', gross: 9000 }),
  ]
  const r = customReport(slips, { from: '2026-09', to: '2026-09' }, 'department', ['gross', 'otHours', 'nope'])

  it('groups the chosen figures', () => {
    expect(r.tables[0].columns.map((c) => c.key)).toEqual(['label', 'gross', 'otHours', 'employees', 'payslips'])
    expect(r.tables[0].rows.map((x) => [x.label, x.gross, x.otHours, x.employees])).toEqual([
      ['Ops', 20000, 6, 2],
      ['Sales', 9000, 0, 1],
    ])
    expect(texts(r)[0]).toBe('Ops has the most gross pay: ₱20,000.00, 69% of the total.')
  })

  it('writes plain numbers to the CSV and formatted ones on screen', () => {
    const csv = reportCsv('Custom payroll report', 'Sep 2026', r)
    expect(csv[0]).toEqual(['Custom payroll report'])
    expect(csv[4]).toEqual(['Department', 'Gross pay', 'Overtime hours', 'Employees', 'Payslips'])
    expect(csv[5]).toEqual(['Ops', 20000, 6, 2, 2])
    expect(cellText(0.125, 'percent')).toBe('13%')
    expect(cellText(0.032, 'percent')).toBe('3.2%')
    expect(cellText(95, 'minutes')).toBe('1h 35m')
    expect(cellText(null, 'money')).toBe('—')
  })
})

describe('review fixes', () => {
  it('does not compare the current month while its payrolls are still to come', () => {
    const slips = [fact({ month: '2026-09' }), fact({ month: '2026-09', employeeId: 'e2' }), fact({ month: '2026-10' })]
    const r = costReport(slips, { from: '2026-09', to: '2026-10' }, 'month', '2026-10-24')
    const t = texts(r)
    expect(t[0]).toBe("Oct 2026 so far: ₱11,000.00 — its remaining payrolls are still to come, so it isn't compared yet.")
    expect(t.some((x) => x.includes('down'))).toBe(false)
  })

  it('leaves days outside the employment out of attendance', () => {
    const who = whoOf('n', { name: 'New Hire', department: 'Ops' })
    const day = (date: string, absent: boolean) => ({ date, dayType: 'regular', scheduled: true, workedMinutes: absent ? 0 : 480, absent, lateMinutes: 0, undertimeMinutes: 0 })
    // payroll marks the days before the hire absent to prorate the period
    const days = toDayFacts(who, [day('2026-10-12', true), day('2026-10-13', true), day('2026-10-14', false), day('2026-10-15', false)])
    const r = attendanceReport(days, [], { from: '2026-10', to: '2026-10' }, 'employee', new Map([['n', { hire: '2026-10-14', separation: null }]]))
    expect(r.tables[0].total).toMatchObject({ expected: 2, absent: 0, worked: 2 })
  })
})
