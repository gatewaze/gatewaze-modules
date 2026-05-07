import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The modules workspace doesn't pnpm-link the platform's @gatewaze/shared
// package; canvas modules import a few sub-paths from it (sanitisers,
// types). Map them through to the source tree so vitest can resolve.
// Path is relative to this file; works whether the gatewaze checkout
// sits next to gatewaze-modules (the standard layout) or above it.
const sharedRoot = resolve(__dirname, '../../../gatewaze/packages/shared/src');

export default defineConfig({
  test: {
    include: ['{lib,api,admin,workers}/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@gatewaze/shared/sanitisers': resolve(sharedRoot, 'sanitisers/index.ts'),
      '@gatewaze/shared': resolve(sharedRoot, 'index.ts'),
    },
  },
});
