import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  // The module has no tsconfig.json of its own, so esbuild's JSX mode is whatever vitest/vite
  // defaults to — which flipped from automatic to classic somewhere in the floated vitest 4.1.x
  // range, breaking components that (correctly, for the platform's build) omit `import React`.
  // Pin the automatic runtime explicitly so the suite doesn't depend on that default.
  esbuild: { jsx: 'automatic' },
  test: {
    // Cover both the co-located suites ({lib,api,admin,workers}/**/__tests__) and the top-level
    // __tests__/ tree (e.g. the transcript-markdown component test from issue #10).
    include: ['__tests__/**/*.test.ts', '{lib,api,admin,workers}/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      // The platform provides @gatewaze/shared + express at module-host install time; stub the few
      // symbols the imported lib graph references so route handlers can be exercised in isolation here.
      '@gatewaze/shared/modules': resolve(__dirname, 'admin/__tests__/_stub-shared-modules.ts'),
      express: resolve(__dirname, 'admin/__tests__/_stub-express.ts'),
    },
  },
});
