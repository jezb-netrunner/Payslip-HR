// Set at build time from package.json and git (vite.config.ts).
declare const __APP_VERSION__: string
declare const __APP_BUILD__: string
// The Supabase project URL (VITE_SUPABASE_URL or the default in vite.config.ts,
// which also puts it in the Content-Security-Policy).
declare const __SUPABASE_URL__: string
