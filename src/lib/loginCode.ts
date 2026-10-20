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

// Unambiguous alphabet: no 0/O, 1/I/L.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** Random 8-character code part (~39 bits). */
export function generateCodePart(length = 8): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}
