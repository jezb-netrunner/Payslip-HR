import { describe, expect, it } from 'vitest'
import { errorMessage } from './errors'

describe('errorMessage', () => {
  it('reads Error instances and PostgREST plain-object errors', () => {
    expect(errorMessage(new Error('boom'), 'x')).toBe('boom')
    expect(
      errorMessage({ code: '23505', message: 'duplicate key value violates unique constraint "entities_code_key"', details: null }, 'x'),
    ).toContain('entities_code_key')
    expect(errorMessage('plain', 'x')).toBe('plain')
  })

  it('falls back when there is no usable message', () => {
    expect(errorMessage(null, 'Failed')).toBe('Failed')
    expect(errorMessage({ message: '' }, 'Failed')).toBe('Failed')
    expect(errorMessage({ code: 'X' }, 'Failed')).toBe('Failed')
  })
})
