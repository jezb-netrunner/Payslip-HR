// The built-in PDF fonts print Windows-1252 only: any other character (₱, an
// emoji, a Vietnamese letter) garbles the whole line it is in. Every document
// is made with safeDoc, which cleans text on its way in — the app's own
// wording and whatever users typed (names, addresses, leave or holiday names).

import { jsPDF, type jsPDFOptions } from 'jspdf'

// Windows-1252 characters outside Latin-1
const WINANSI_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'])

const printable = (c: string) => {
  const n = c.codePointAt(0) ?? 0
  return c === '\n' || (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || WINANSI_EXTRA.has(c)
}

/** Text the built-in fonts can print: ₱ as "PHP", accents kept where the font has them, else the bare letter. */
export function pdfText(s: string): string {
  const t = s
    .replace(/₱\s?/g, 'PHP ')
    .replace(/[‐-‒−]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/[  ]/g, ' ')
  let out = ''
  for (const c of t) {
    if (printable(c)) {
      out += c
      continue
    }
    const bare = c.normalize('NFD').replace(/[̀-ͯ]/g, '')
    out += bare && [...bare].every(printable) ? bare : '?'
  }
  return out
}

/** A jsPDF document whose text (including jspdf-autotable cells) is cleaned with pdfText. */
export function safeDoc(options: jsPDFOptions): jsPDF {
  const doc = new jsPDF(options)
  const text = doc.text.bind(doc) as (t: string | string[], ...rest: unknown[]) => jsPDF
  doc.text = ((t: string | string[], ...rest: unknown[]) => text(Array.isArray(t) ? t.map(pdfText) : pdfText(String(t)), ...rest)) as typeof doc.text
  const split = doc.splitTextToSize.bind(doc) as (t: string, ...rest: unknown[]) => string[]
  doc.splitTextToSize = ((t: string, ...rest: unknown[]) => split(pdfText(String(t)), ...rest)) as typeof doc.splitTextToSize
  return doc
}
