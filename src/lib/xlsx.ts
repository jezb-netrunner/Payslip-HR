// A small Excel (.xlsx) writer: one workbook of plain sheets, each a few
// identification rows on top, then a bold header row (frozen, with a
// filter) and the data. Text is written as inline strings, so codes like
// TINs and employee numbers keep their leading zeros and nothing a user
// typed is ever read as a formula. Opens in Excel, LibreOffice, Google
// Sheets and Numbers.

import { strToU8, zipSync } from 'fflate'

export type XlsxCell = string | number | boolean | null | undefined

export interface XlsxColumn {
  header: string
  /** money: #,##0.00, int: whole numbers, number: as computed; text (default): as given */
  format?: 'text' | 'money' | 'int' | 'number'
  /** width in characters (default from the header) */
  width?: number
}

export interface XlsxSheet {
  name: string
  /** rows above the table, e.g. the report identification (first row bold) */
  heading?: string[][]
  columns: XlsxColumn[]
  rows: XlsxCell[][]
}

// Excel's own limits
const MAX_TEXT = 32767
const MAX_ROWS = 1_048_576

// style ids, in the order of cellXfs below
const S_TEXT = 0
const S_BOLD = 1
const S_MONEY = 2
const S_INT = 3
const S_HEADER = 4

/** XML text: escaped, without the control characters XML forbids. */
export function xmlText(v: string): string {
  return v
    // eslint-disable-next-line no-control-regex -- XML 1.0 forbids these characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** A legal, unique sheet name: at most 31 characters, none of : \ / ? * [ ]. */
export function sheetName(name: string, taken: Set<string>): string {
  const base = (name.replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Sheet').slice(0, 31)
  let candidate = base
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`
    candidate = base.slice(0, 31 - suffix.length) + suffix
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

function textCell(ref: string, v: string, style = S_TEXT): string {
  const t = xmlText(v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v)
  const space = /^\s|\s$/.test(t) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${space}>${t}</t></is></c>`
}

function cell(ref: string, v: XlsxCell, format: XlsxColumn['format']): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'boolean') return textCell(ref, v ? 'Yes' : 'No')
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return ''
    if (format === 'text') return textCell(ref, String(v))
    const style = format === 'money' ? S_MONEY : format === 'int' ? S_INT : S_TEXT
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${v}</v></c>`
  }
  // a numeric column given text (e.g. "12.50") stays text: never guessed
  return textCell(ref, v)
}

function sheetXml(sheet: XlsxSheet): string {
  const heading = sheet.heading ?? []
  const headerRow = heading.length + 1
  const lastCol = columnName(Math.max(0, sheet.columns.length - 1))
  const rows: string[] = []
  heading.forEach((line, i) => {
    const r = i + 1
    rows.push(`<row r="${r}">${line.map((v, c) => (v ? textCell(`${columnName(c)}${r}`, v, i === 0 ? S_BOLD : S_TEXT) : '')).join('')}</row>`)
  })
  rows.push(
    `<row r="${headerRow}">${sheet.columns.map((c, i) => textCell(`${columnName(i)}${headerRow}`, c.header, S_HEADER)).join('')}</row>`,
  )
  const room = MAX_ROWS - headerRow
  sheet.rows.slice(0, room).forEach((row, i) => {
    const r = headerRow + 1 + i
    rows.push(`<row r="${r}">${sheet.columns.map((c, j) => cell(`${columnName(j)}${r}`, row[j], c.format)).join('')}</row>`)
  })
  const cols = sheet.columns
    .map((c, i) => {
      const w = Math.min(60, Math.max(8, c.width ?? c.header.length + 2))
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
    })
    .join('')
  const lastRow = headerRow + Math.min(sheet.rows.length, room)
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    (sheet.columns.length ? `<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>` : '') +
    '</worksheet>'
  )
}

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>'

/** The workbook as .xlsx bytes. `creator` and `title` fill the file's properties. */
export function buildXlsx(sheets: XlsxSheet[], props: { title?: string; creator?: string; created?: Date } = {}): Uint8Array {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.')
  const taken = new Set<string>()
  const names = sheets.map((s) => sheetName(s.name, taken))
  const created = (props.created ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  // the filter range of each sheet, as Excel itself records it
  const filters = sheets
    .map((s, i) => {
      if (!s.columns.length) return ''
      const headerRow = (s.heading?.length ?? 0) + 1
      const last = headerRow + Math.min(s.rows.length, MAX_ROWS - headerRow)
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlText(names[i].replace(/'/g, "''"))}'!$A$${headerRow}:$${columnName(s.columns.length - 1)}$${last}</definedName>`
    })
    .join('')
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        '</Relationships>',
    ),
    'docProps/core.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${xmlText(props.title ?? '')}</dc:title><dc:creator>${xmlText(props.creator ?? '')}</dc:creator>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` +
        '</cp:coreProperties>',
    ),
    'docProps/app.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Payslip HR</Application></Properties>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets>${names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
        (filters ? `<definedNames>${filters}</definedNames>` : '') +
        '</workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(STYLES),
  }
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))
  })
  return zipSync(files, { level: 6 })
}
