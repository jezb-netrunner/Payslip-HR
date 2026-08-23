import { createClient } from '@supabase/supabase-js'

// The anon/publishable key is designed to be public; all data access is
// enforced by Row Level Security on the server.
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ?? 'https://ruuhpghcgccvezkjhisy.supabase.co'
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'sb_publishable_8xno4vxU1KLG8XQogG1jbA_Pr7jEQ1q'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
