// The password rule of admin accounts (BIR RMO 9-2021 Annex B: passwords mix
// letters and digits). KEEP IN SYNC with passwordProblem in
// supabase/functions/auth-guard/index.ts and admin-users/index.ts.

export const PASSWORD_RULE = 'At least 8 characters, with letters and digits, not containing your email name. Changed every 30 days.'

export function passwordProblem(password: string, email = ''): string | null {
  if (password.length < 8) return 'Use at least 8 characters.'
  if (password.length > 72) return 'Use at most 72 characters.'
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return 'Mix letters and digits.'
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  if (local.length >= 3 && password.toLowerCase().includes(local)) return "Don't put your email name in the password."
  return null
}
