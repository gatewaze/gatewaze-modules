import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `@supabase/supabase-js` is a peerDependency and is absent when this
      // suite runs standalone in CI. require-jwt.ts imports it at module scope,
      // so point it at a stub that throws if actually used.
      '@supabase/supabase-js': new URL('./__tests__/_stubs/supabase-js.ts', import.meta.url).pathname,
    },
  },
});
