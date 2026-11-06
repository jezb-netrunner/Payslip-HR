import { describe, expect, it } from 'vitest'
import { employeeProblem } from './authGuard'

describe("an employee's refused login code, in words", () => {
  it('tells a wrong code from a deactivated login, a throttled company and a busy server', () => {
    expect(employeeProblem(401, { error: 'invalid' })).toMatch(/did not work.*HR or payroll officer/)
    expect(employeeProblem(403, { error: 'deactivated' })).toMatch(/deactivated/)
    expect(employeeProblem(429, { error: 'rate_limited' })).toMatch(/Wait a minute/)
    const throttled = employeeProblem(429, { error: 'throttled', retry_at: '2026-11-06T10:15:00Z' })
    expect(throttled).toMatch(/^Too many wrong codes were tried for your company\. Try again after .+, or ask/)
    expect(throttled).toContain('6:15')
  })

  it('falls back to the server and connection messages', () => {
    expect(employeeProblem(500, { error: 'server_error' })).toMatch(/Can't reach the server/)
    expect(employeeProblem(0, {})).toMatch(/Can't reach the server/)
  })
})
