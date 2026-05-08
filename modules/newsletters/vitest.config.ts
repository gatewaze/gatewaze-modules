import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{lib,admin}/**/__tests__/**/*.test.ts', 'admin/**/__tests__/**/*.test.tsx'],
    environment: 'node',
    globals: false,
  },
});
