import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { buildXlsx, columnName, sheetName, xmlText, type XlsxSheet } from './xlsx'

const sheets: XlsxSheet[] = [
  {
    name: 'Payslips',
    heading: [['Acme Trading Corporation'], ['VAT REG TIN 123-456-789-00000'], []],
    columns: [
      { header: 'Payslip No' },
      { header: 'Employee No' },
      { header: 'Employee', width: 30 },
      { header: 'Days', format: 'number' },
      { header: 'Net Pay', format: 'money' },
      { header: 'Employees', format: 'int' },
      { header: 'MWE' },
    ],
    rows: [
      ['PS-000001', '00012', 'Reyes, Ana & <Co> "x"', 11.5, 12345.678, 3, true],
      ['PS-000002', '00013', ' Cruz\u0007, Ben ', null, -50, undefined, false],
      ['PS-000003', '00014', '=HYPERLINK("http://x")', Infinity, 0, 1, null],
    ],
  },
  { name: 'Bad/Name: [x]?', columns: [{ header: 'A' }], rows: [] },
  { name: 'bad name   x', columns: [{ header: 'B' }], rows: [['b']] },
]

describe('xlsx writer', () => {
  const bytes = buildXlsx(sheets, { title: 'Payroll backup 2026', creator: 'Liza Santos', created: new Date('2026-10-29T01:00:00Z') })
  const files = unzipSync(bytes)
  const text = (name: string) => strFromU8(files[name])

  it('packs a complete workbook', () => {
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ])
    expect(text('docProps/core.xml')).toContain('<dc:title>Payroll backup 2026</dc:title>')
    expect(text('docProps/core.xml')).toContain('2026-10-29T01:00:00Z')
  })

  it('names sheets legally and uniquely', () => {
    expect(text('xl/workbook.xml')).toContain('<sheet name="Bad Name   x" sheetId="2"')
    expect(text('xl/workbook.xml')).toContain('<sheet name="bad name   x (2)" sheetId="3"')
    expect(sheetName('x'.repeat(40), new Set())).toHaveLength(31)
  })

  it('writes text as inline strings, escaped, and numbers with their formats', () => {
    const s = text('xl/worksheets/sheet1.xml')
    // the identification rows sit above the frozen, filtered header row
    expect(s).toContain('<pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/>')
    expect(s).toContain('<autoFilter ref="A4:G7"/>')
    expect(s).toContain('<c r="A1" t="inlineStr" s="1"><is><t>Acme Trading Corporation</t></is></c>')
    expect(s).toContain('<c r="B5" t="inlineStr"><is><t>00012</t></is></c>')
    expect(s).toContain('Reyes, Ana &amp; &lt;Co&gt; &quot;x&quot;')
    expect(s).toContain('<c r="D5"><v>11.5</v></c>')
    expect(s).toContain('<c r="E5" s="2"><v>12345.678</v></c>')
    expect(s).toContain('<c r="F5" s="3"><v>3</v></c>')
    expect(s).toContain('<c r="G5" t="inlineStr"><is><t>Yes</t></is></c>')
    // control characters dropped, surrounding spaces kept
    expect(s).toContain('<t xml:space="preserve"> Cruz, Ben </t>')
    // a formula-looking text stays text
    expect(s).toContain('<c r="C7" t="inlineStr"><is><t>=HYPERLINK(&quot;http://x&quot;)</t></is></c>')
    // empty and non-finite values leave the cell out
    expect(s).not.toContain('r="D6"')
    expect(s).not.toContain('r="D7"')
  })

  it('helpers', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
    expect(xmlText('a\u0000b<c')).toBe('ab&lt;c')
    expect(() => buildXlsx([])).toThrow()
  })
})
