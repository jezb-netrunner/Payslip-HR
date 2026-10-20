import { describe, expect, it } from 'vitest'
import { employeeLoginEmail, generateCodePart, isValidLoginCode, normalizeLoginCode } from './loginCode'

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

  it('generates unambiguous random parts', () => {
    const part = generateCodePart()
    expect(part).toMatch(/^[2-9A-HJKMNP-Z]{8}$/)
  })
})
