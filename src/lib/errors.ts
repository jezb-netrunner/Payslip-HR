/**
 * Human-readable message for anything caught or returned as an error.
 * supabase-js hands back PostgREST / RPC failures as plain
 * `{ message, code, details, hint }` objects — not Error instances — so an
 * `instanceof Error` check alone would hide the database's own message
 * (trigger and RPC guidance, constraint names) behind a generic fallback.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  if (typeof err === 'string' && err) return err
  return fallback
}
