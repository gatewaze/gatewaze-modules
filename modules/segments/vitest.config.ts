// Plain config object (no `vitest/config` import) so the module can be tested
// without vitest resolvable in its own node_modules — run via the workspace's
// vitest binary with `--root modules/segments`.
export default {
  test: {
    include: ['admin/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
};
