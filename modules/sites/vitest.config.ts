import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{lib,api,admin,workers}/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
