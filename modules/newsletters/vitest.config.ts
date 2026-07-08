import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['{lib,admin,workers}/**/__tests__/**/*.test.ts', 'admin/**/__tests__/**/*.test.tsx'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      // The HelixAiContent registry entry imports the
      // helix-ai-field-adapter, which transitively pulls react-dom +
      // @heroicons/react + the admin's RichTextEditor + supabase
      // client. None of those resolve in the node-env vitest run for
      // this module (which only checks registry shape, not runtime
      // behaviour). Stub the whole adapter file so the import graph
      // terminates cleanly. Runtime behaviour is exercised in the
      // browser at edit time, where the real adapter loads.
      '../helix-ai-field-adapter.js': resolve(
        __dirname,
        './admin/__test-stubs__/helix-ai-field-adapter.tsx',
      ),
      // Same reasoning for the image-field adapter — pulls
      // host-media's uploadHostMedia (→ supabase) + heroicons +
      // sonner. Registry shape tests don't render it.
      '../image-field-adapter.js': resolve(
        __dirname,
        './admin/__test-stubs__/image-field-adapter.tsx',
      ),
    },
  },
});
