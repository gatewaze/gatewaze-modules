import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['{lib,api}/**/__tests__/**/*.test.ts', '__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    // The portal's alias for sibling modules (packages/portal/next.config.ts).
    alias: { '@gatewaze-modules': fileURLToPath(new URL('..', import.meta.url)) },
  },
});
