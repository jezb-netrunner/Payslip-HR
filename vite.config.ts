/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// the software name and version printed on every report (BIR RMO 9-2021
// Annex B): the version in package.json, and the commit it was built from
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
let build = 'dev'
try {
  build = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
} catch {
  // not a git checkout
}

// the Supabase project the app talks to (VITE_SUPABASE_URL overrides it)
const DEFAULT_SUPABASE_URL = 'https://ruuhpghcgccvezkjhisy.supabase.co'

/**
 * The built app's Content-Security-Policy. GitHub Pages can't send response
 * headers, so it goes in a meta tag (which can't carry frame-ancestors).
 * Scripts come only from the app itself and requests go only to the app and
 * its Supabase project, so even injected markup could neither load a script
 * nor send data elsewhere. Styles may be inline: the print windows and React
 * style props use them. Images: the app, the authenticator QR code (a data
 * URL) and Supabase storage. Not in dev: Vite's dev server injects inline
 * scripts.
 */
function contentSecurityPolicy(supabaseUrl: string): Plugin {
  const api = new URL(supabaseUrl)
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${api.origin}`,
    "font-src 'self'",
    `connect-src 'self' ${api.origin} wss://${api.host}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  const charset = '<meta charset="UTF-8" />'
  return {
    name: 'payslip-hr-csp',
    apply: 'build',
    // right after the charset, before any tag that loads something
    transformIndexHtml(html) {
      if (!html.includes(charset)) throw new Error('index.html lost its charset tag: the CSP goes right after it')
      return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
    },
  }
}

export default defineConfig(({ mode }) => {
  const supabaseUrl = loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL
  return {
    plugins: [react(), tailwindcss(), contentSecurityPolicy(supabaseUrl)],
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_BUILD__: JSON.stringify(build),
      __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    },
    test: {
      environment: 'node',
      // the edge functions' unit tests run their real handlers with a faked
      // network (their integration tests need a local stack: npm run test:edge)
      include: ['src/**/*.test.ts', 'supabase/functions/tests/**/*.unit.test.ts'],
      alias: [
        {
          find: /^npm:@supabase\/supabase-js@2$/,
          replacement: fileURLToPath(new URL('./node_modules/@supabase/supabase-js/dist/index.mjs', import.meta.url)),
        },
      ],
    },
  }
})
