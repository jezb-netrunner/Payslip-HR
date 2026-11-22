import { describe, expect, it } from 'vitest'
import { isFramed } from './framing'

describe('isFramed', () => {
  it('is false for a top-level page', () => {
    const w = {} as { self: unknown; top: unknown }
    w.self = w
    w.top = w
    expect(isFramed(w)).toBe(false)
  })

  it('is true inside a frame', () => {
    const w = { self: {}, top: {} }
    expect(isFramed(w)).toBe(true)
  })

  it('is true when the parent cannot be read (cross-origin)', () => {
    const w = {
      self: {},
      get top(): unknown {
        throw new Error('blocked')
      },
    }
    expect(isFramed(w)).toBe(true)
  })
})
