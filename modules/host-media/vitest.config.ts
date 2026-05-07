import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
