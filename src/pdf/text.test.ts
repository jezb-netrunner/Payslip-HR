import { describe, expect, it } from 'vitest'
import { pdfText, safeDoc } from './text'

describe('PDF text', () => {
  it('keeps what the built-in fonts print and replaces the rest', () => {
    expect(pdfText('₱1,000 – Peñaflor • Ñino “ok” …')).toBe('PHP 1,000 – Peñaflor • Ñino “ok” …')
    expect(pdfText('Nguyễn Thị ≥ 5 → 6')).toBe('Nguyen Thi >= 5 -> 6')
    expect(pdfText('Leave 😀 day')).toBe('Leave ? day')
  })

  it('cleans every text a document draws', () => {
    const doc = safeDoc({ unit: 'mm', format: 'a4' })
    doc.text('₱500 for Nguyễn', 10, 10)
    const out = doc.output()
    expect(out).toContain('PHP 500 for Nguyen')
    expect(doc.splitTextToSize('₱1', 100)).toEqual(['PHP 1'])
  })
})
