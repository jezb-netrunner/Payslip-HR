import { createClient } from '@supabase/supabase-js'

// The anon/publishable key is designed to be public; all data access is
// enforced by Row Level Security on the server.
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://ruuhpghcgccvezkjhisy.supabase.co'
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'sb_publishable_8xno4vxU1KLG8XQogG1jbA_Pr7jEQ1q'

/**
 * An error the Auth server sent back in the URL (e.g. a password-reset link
 * refused for a locked account): read before the client handles the URL,
 * for the sign-in screen to explain.
 */
export const urlAuthError: { code: string; description: string } | null = (() => {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search.replace(/^\?/, ''))
  const code = params.get('error_code') ?? params.get('error')
  return code ? { code, description: params.get('error_description') ?? '' } : null
})()

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
