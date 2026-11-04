// The edge functions' integration tests: run the real handlers under Node
// (a Deno shim) against a local Supabase stack — see guard.int.test.ts.
//   STACK_ANON_KEY=… npm run test:edge
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))

export default {
  resolve: {
    // the functions import supabase-js the Deno way
    alias: [{ find: /^npm:@supabase\/supabase-js@2$/, replacement: `${root}node_modules/@supabase/supabase-js/dist/index.mjs` }],
  },
  test: {
    root,
    include: ['supabase/functions/tests/**/*.int.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
}
