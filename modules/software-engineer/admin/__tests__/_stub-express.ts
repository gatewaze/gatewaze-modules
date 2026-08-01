// Test stub for `express` (not vendored into this workspace). admin-routes.ts only touches
// `express.json()` at mount time, which the recorder router discards, so a no-op body parser is
// enough to import the route module in isolation.
const json = () => (_req: unknown, _res: unknown, next?: () => void) => { next?.(); };
export default { json };
export { json };
