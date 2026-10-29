/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// the software name and version printed on every report (BIR RMO 9-2021
// Annex B): the version in package.json, and the commit it was built from
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
let build = 'dev'
try {
  build = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
} catch {
  // not a git checkout
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD__: JSON.stringify(build),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
