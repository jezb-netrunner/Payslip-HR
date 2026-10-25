// Spec T6: the national government pays the PhilHealth employee share (the
// NG share) only for the months it applies. Solo parent: from the start
// month, in months a valid SPIC fully covers. PWD: from the start month (the
// complete requirements), once PhilHealth's status is "confirmed". The
// employer share never changes.
import { describe, expect, it } from 'vitest'
import { pastWaivedDeductions, philhealthWaiverFor, philhealthWaiverWarnings, type PhilhealthWaiverRecord } from './philhealthWaiver'

const solo: PhilhealthWaiverRecord = { kind: 'solo_parent', startMonth: '2026-10-01', spicExpiry: '2027-03-15', pwdStatus: null }
const pwd = (pwdStatus: PhilhealthWaiverRecord['pwdStatus']): PhilhealthWaiverRecord => ({ kind: 'pwd', startMonth: '2026-10-01', spicExpiry: null, pwdStatus })

describe('T6 the NG share by month', () => {
  it('P1: a solo parent from October 2026, SPIC valid to 2027-03-15: October to February only', () => {
    const months = ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01']
    expect(months.map((m) => philhealthWaiverFor(solo, m) ?? '-')).toEqual(['-', 'solo_parent', 'solo_parent', 'solo_parent', 'solo_parent', 'solo_parent', '-', '-'])
  })

  it('a solo parent without an SPIC expiry on file: no month is covered', () => {
    expect(philhealthWaiverFor({ ...solo, spicExpiry: null }, '2026-10-01')).toBeUndefined()
  })

  it('P2: a PWD for verification pays as usual; confirmed, the NG share applies from the start month', () => {
    expect(philhealthWaiverFor(pwd('for_verification'), '2026-11-01')).toBeUndefined()
    expect(philhealthWaiverFor(pwd('confirmed'), '2026-09-01')).toBeUndefined()
    expect(philhealthWaiverFor(pwd('confirmed'), '2026-10-01')).toBe('pwd')
    expect(philhealthWaiverFor(pwd('confirmed'), '2027-06-01')).toBe('pwd')
  })

  it('no waiver: nothing applies', () => {
    expect(philhealthWaiverFor({ kind: null, startMonth: null, spicExpiry: null, pwdStatus: null }, '2026-10-01')).toBeUndefined()
  })
})

describe('T6 warnings', () => {
  it('30 days before the SPIC expires', () => {
    // February's payroll ends 2027-02-28: the SPIC expires 15 days later
    expect(philhealthWaiverWarnings(solo, '2027-02-01', '2027-02-28')).toEqual([
      'The solo parent ID (SPIC) expires on Mar 15, 2027: ask for the renewed SPIC and record its expiry. Without it, the PhilHealth employee share is deducted from March 2027.',
    ])
    expect(philhealthWaiverWarnings(solo, '2027-01-01', '2027-01-31')).toEqual([]) // 43 days before
  })

  it('a month the SPIC no longer covers, or no SPIC expiry on file', () => {
    expect(philhealthWaiverWarnings(solo, '2027-03-01', '2027-03-31')).toEqual([
      'No valid solo parent ID (SPIC) covers March 2027 (it expires on Mar 15, 2027): the PhilHealth employee share is deducted. Record the renewed SPIC\'s expiry to restore the NG share.',
    ])
    expect(philhealthWaiverWarnings({ ...solo, spicExpiry: null }, '2026-10-01', '2026-10-31')).toEqual([
      'No solo parent ID (SPIC) expiry on file: the PhilHealth employee share is deducted. Record the SPIC\'s expiry to apply the NG share.',
    ])
  })

  it('a PWD still for verification', () => {
    expect(philhealthWaiverWarnings(pwd('for_verification'), '2026-10-01', '2026-10-31')).toEqual([
      'PhilHealth status "for verification": the PWD\'s employee share is deducted as usual until PhilHealth confirms it.',
    ])
    expect(philhealthWaiverWarnings(pwd('confirmed'), '2026-10-01', '2026-10-31')).toEqual([])
  })

  it('before the start month: nothing to say', () => {
    expect(philhealthWaiverWarnings(pwd('for_verification'), '2026-09-01', '2026-09-30')).toEqual([])
  })
})

describe('T6 past periods that may need a manual adjustment', () => {
  it('P2: finalized payslips of months the NG share now covers that deducted the employee share', () => {
    const slips = [
      { period_month: '2026-09-01', philhealth_ee: 450 },
      { period_month: '2026-10-01', philhealth_ee: 225 },
      { period_month: '2026-10-01', philhealth_ee: 225 },
      { period_month: '2026-11-01', philhealth_ee: 0 },
    ]
    expect(pastWaivedDeductions(pwd('confirmed'), slips)).toEqual([{ month: '2026-10-01', amount: 450 }])
    expect(pastWaivedDeductions(pwd('for_verification'), slips)).toEqual([])
  })
})
