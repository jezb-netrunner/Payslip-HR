import { describe, expect, it } from 'vitest'
import { passwordProblem } from './password'

describe('admin password rule (NIST SP 800-63B)', () => {
  it('asks for length, not a mix of character kinds', () => {
    expect(passwordProblem('blue harbor morning tide')).toBeNull()
    expect(passwordProblem('alllowercaseletters')).toBeNull()
    expect(passwordProblem('Acme2026x')).toMatch(/at least 12/)
  })
  it('counts characters, not bytes, and allows long passphrases', () => {
    expect(passwordProblem('ñandú café 12')).toBeNull()
    expect(passwordProblem('w'.repeat(3) + ' word '.repeat(20))).toBeNull()
    expect(passwordProblem('x'.repeat(129) + 'y')).toMatch(/at most 128/)
  })
  it('refuses what a guesser tries first', () => {
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/repeat/)
    expect(passwordProblem('juan.delacruz2026', 'juan.delacruz@acme.ph')).toMatch(/email name/)
    expect(passwordProblem('my payslip password')).toMatch(/app's name/)
  })
})
