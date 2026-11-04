// The password rule of admin accounts, after current practice (NIST SP
// 800-63B): length rather than a mix of character kinds, no expiry, and
// passwords found in known data breaches refused (that check runs on the
// server). KEEP IN SYNC with passwordProblem in
// supabase/functions/auth-guard/index.ts and admin-users/index.ts.

export const PASSWORD_MIN = 12
export const PASSWORD_MAX = 128

export const PASSWORD_RULE = `At least ${PASSWORD_MIN} characters — a few words make a strong passphrase. No symbols or digits needed. Passwords found in known data breaches are refused.`

export function passwordProblem(password: string, email = ''): string | null {
  const length = [...password].length
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters: a few words make a strong passphrase.`
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`
  if (/^(.)\1+$/su.test(password)) return "Don't repeat one character."
  const lower = password.toLowerCase()
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  if (local.length >= 3 && lower.includes(local)) return "Don't put your email name in the password."
  if (lower.includes('payslip')) return "Don't put the app's name in the password."
  return null
}
