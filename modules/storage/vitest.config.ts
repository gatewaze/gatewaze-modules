import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['lib/**/__tests__/**/*.test.ts', 'browser/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      // The admin's client; browser/ tests replace it with vi.mock.
      '@/lib/supabase': fileURLToPath(new URL('./browser/__tests__/supabase-stub.ts', import.meta.url)),
    },
  },
});
