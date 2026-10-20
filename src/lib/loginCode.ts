// Employee login codes.
//
// Employees sign in with one code, "<CLIENT CODE>-<PART>" (e.g.
// ACME-7Q4KX9TB). The entity admin sets PART; the client prefix keeps codes
// unique per client, so trying codes can never reveal another client's
// employees. Supabase Auth needs an email, so each code maps to a synthetic
// address derived from a SHA-256 of the code, and the code itself is the
// password: knowing the code is the whole credential, and only Supabase's
// bcrypt hash of it is stored. The address lives on this app's own domain
// (Supabase rejects example/test domains); no mail is ever sent to it.
//
// KEEP IN SYNC with supabase/functions/admin-users/index.ts.

export const EMPLOYEE_LOGIN_DOMAIN = 'jezb-netrunner.github.io'
const HASH_PREFIX = 'payslip-hr/employee-login/v1:'

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

export async function employeeLoginEmail(code: string): Promise<string> {
  const data = new TextEncoder().encode(HASH_PREFIX + code)
  const digest = await crypto.subtle.digest('SHA-256', data)
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return `emp-${hex.slice(0, 32)}@${EMPLOYEE_LOGIN_DOMAIN}`
}

/**
 * Why an admin-chosen code part is too easy to guess, or null when it is
 * acceptable. The client prefix is public and every guess hits a different
 * synthetic account, so per-account lockout can't help: the code itself has
 * to be hard to guess. KEEP IN SYNC with the edge function.
 */
export function weakCodeReason(part: string, employeeNo = ''): string | null {
  if (!/^[A-Z0-9]{8,24}$/.test(part)) return 'The code must be 8–24 letters or digits.'
  if (part === employeeNo.toUpperCase().replace(/[^A-Z0-9]/g, '')) {
    return "Don't use the employee number as the login code — it is easy to guess."
  }
  if (/^[0-9]+$/.test(part)) return 'Mix in letters: an all-number code (a date, a phone number) is easy to guess.'
  if (new Set(part).size < 5) return 'Use at least 5 different characters.'
  const steps = [...part].slice(1).map((c, i) => c.charCodeAt(0) - part.charCodeAt(i))
  if (steps.every((d) => d === 1) || steps.every((d) => d === -1)) return 'Avoid runs like ABCDEFGH or 23456789.'
  return null
}

// Unambiguous alphabet: no 0/O, 1/I/L.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** Random code part (8 characters ≈ 39 bits), unbiased and never "weak". */
export function generateCodePart(length = 8): string {
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
