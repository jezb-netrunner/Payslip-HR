// Employee login codes.
//
// Employees sign in with one code, "<CLIENT CODE>-<PART>" (e.g.
// ACME-7Q4KX9TB). The entity admin sets PART; the client prefix keeps codes
// unique per client, so trying codes can never reveal another client's
// employees. The code is the whole credential. Supabase Auth needs an email,
// so the auth-guard edge function maps the code to an address and a password
// (HMACs under a server secret) and signs the employee in: the browser never
// knows the address, so a session left on a shared computer can't be worked
// back into the code. No mail is ever sent to the address.
//
// KEEP normalizeLoginCode, isValidLoginCode and weakCodeReason IN SYNC with
// supabase/functions/auth-guard and admin-users.

/** Uppercase, strip whitespace, normalize dash-like characters. */
export function normalizeLoginCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[‐-―−_.]/g, '-')
}

/** Valid full code: client code (2–10) + '-' + 8–24 letters/digits. */
export function isValidLoginCode(code: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}-[A-Z0-9]{8,24}$/.test(code)
}

/**
 * Why an admin-chosen code part is too easy to guess, or null when it is
 * acceptable. The client prefix is public and every guess hits a different
 * synthetic account, so per-account lockout can't help: the code itself has
 * to be hard to guess. KEEP IN SYNC with the edge function.
 */
export function weakCodeReason(part: string, employeeNo = '', names: string[] = []): string | null {
  if (!/^[A-Z0-9]{8,24}$/.test(part)) return 'The code must be 8–24 letters or digits.'
  if (part === employeeNo.toUpperCase().replace(/[^A-Z0-9]/g, '')) {
    return "Don't use the employee number as the login code — it is easy to guess."
  }
  if (/^[0-9]+$/.test(part)) return 'Mix in letters: an all-number code (a date, a phone number) is easy to guess.'
  if (/^[A-Z]+$/.test(part)) return 'Mix in digits: an all-letter code (a word or a name) is easy to guess.'
  const name = names
    .map((n) => n.toUpperCase().replace(/[^A-Z]/g, ''))
    .find((n) => n.length >= 3 && part.includes(n))
  if (name) return "Don't put the employee's name in the login code."
  if (new Set(part).size < 5) return 'Use at least 5 different characters.'
  const steps = [...part].slice(1).map((c, i) => c.charCodeAt(0) - part.charCodeAt(i))
  if (steps.every((d) => d === 1) || steps.every((d) => d === -1)) return 'Avoid runs like ABCDEFGH or 23456789.'
  return null
}

// Unambiguous alphabet: no 0/O, 1/I/L.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** Random code part (8 characters ≈ 39 bits), unbiased and never "weak". */
export function generateCodePart(length = 8): string {
  if (!Number.isInteger(length) || length < 8 || length > 24) throw new Error('A code part has 8–24 characters.')
  const limit = 256 - (256 % ALPHABET.length) // reject bytes that would bias the alphabet
  for (;;) {
    let part = ''
    while (part.length < length) {
      const bytes = new Uint8Array(length)
      crypto.getRandomValues(bytes)
      for (const b of bytes) if (b < limit && part.length < length) part += ALPHABET[b % ALPHABET.length]
    }
    if (!weakCodeReason(part)) return part
  }
}
