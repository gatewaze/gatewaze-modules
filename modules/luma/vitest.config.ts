// Plain config object (no `vitest/config` import) so the module can be tested
// without vitest resolvable in its own node_modules — run via the workspace's
// vitest binary with `--root modules/luma`. Only the pure helpers under
// functions/_shared are covered; the edge functions themselves import Deno
// URLs and are not loadable here.
export default {
  test: {
    include: ['functions/_shared/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
};
