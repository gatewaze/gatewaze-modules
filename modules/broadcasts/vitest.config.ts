// Plain config object (no `vitest/config` import) so the module can be tested
// without vitest resolvable in its own node_modules — run via the workspace's
// vitest binary with `--root modules/broadcasts`.
export default {
  test: {
    include: ['{lib,admin,workers}/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
};
