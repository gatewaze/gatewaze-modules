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
      // The image-field adapter pulls
      // host-media's uploadHostMedia (→ supabase) + heroicons +
      // sonner. Registry shape tests don't render it.
      '../image-field-adapter.js': resolve(
        __dirname,
        './admin/__test-stubs__/image-field-adapter.tsx',
      ),
    },
  },
});
