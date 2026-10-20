import { describe, expect, it } from 'vitest'
import { employeeLoginEmail, generateCodePart, isValidLoginCode, normalizeLoginCode, weakCodeReason } from './loginCode'

describe('employee login codes', () => {
  it('normalizes what employees type', () => {
    expect(normalizeLoginCode(' acme–7q4k x9tb ')).toBe('ACME-7Q4KX9TB')
    expect(normalizeLoginCode('acme_7q4kx9tb')).toBe('ACME-7Q4KX9TB')
  })

  it('requires the client prefix and an 8+ character part', () => {
    expect(isValidLoginCode('ACME-7Q4KX9TB')).toBe(true)
    expect(isValidLoginCode('ACME7Q4KX9TB')).toBe(false)
    expect(isValidLoginCode('ACME-1234')).toBe(false)
  })

  // The edge function derives the same address server-side; this vector
  // pins the derivation so the two can never drift apart silently.
  it('derives a stable synthetic sign-in address', async () => {
    expect(await employeeLoginEmail('ACME-7Q4KX9TB')).toBe(
      'emp-bce06882b7902c9f3fdc424817f6a827@jezb-netrunner.github.io',
    )
  })

  it('generates unambiguous random parts that pass the strength rules', () => {
    for (let i = 0; i < 200; i++) {
      const part = generateCodePart()
      expect(part).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
      expect(weakCodeReason(part)).toBeNull()
    }
  })

  it('rejects guessable codes', () => {
    expect(weakCodeReason('7Q4KX9TB')).toBeNull()
    expect(weakCodeReason('SHORT1')).toMatch(/8–24/)
    expect(weakCodeReason('K7M2Q9XA', 'A-001')).toBeNull()
    expect(weakCodeReason('EMP12345', 'emp-12345')).toMatch(/employee number/)
    expect(weakCodeReason('19900115')).toMatch(/letters/)
    expect(weakCodeReason('AAAABBBB')).toMatch(/5 different/)
    expect(weakCodeReason('ABCDEFGH')).toMatch(/runs/)
    expect(weakCodeReason('98765432')).toMatch(/letters/)
    expect(weakCodeReason('HGFEDCBA')).toMatch(/runs/)
  })
})
