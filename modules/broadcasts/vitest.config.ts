import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Plain-node config for the lib/workers tests; the admin component test opts
// into jsdom itself via a `// @vitest-environment jsdom` docblock, and this
// config aliases the host admin app's `@/...` imports to local stubs since
// those only resolve when this module is bundled into gatewaze/packages/admin
// (see .claude/rules/module-registry.md).
export default defineConfig({
  test: {
    include: ['{lib,admin,workers}/**/__tests__/**/*.test.ts', 'admin/**/__tests__/**/*.test.tsx'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@/components/ui': resolve(__dirname, './admin/__test-stubs__/ui.tsx'),
      '@/components/shared/table/DataTable': resolve(__dirname, './admin/__test-stubs__/DataTable.tsx'),
      '@/lib/supabase': resolve(__dirname, './admin/__test-stubs__/supabase.ts'),
    },
  },
});
