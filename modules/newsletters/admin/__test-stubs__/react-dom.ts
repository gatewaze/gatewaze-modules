/**
 * Test-time stub for `react-dom`. The newsletters module's
 * AiContentField uses `import { flushSync } from 'react-dom'`, which
 * in turn pulls `react-dom`'s full DOM bindings into the import
 * graph. The vitest run for this module uses `environment: 'node'`
 * and only ever imports the registry shape (not the DOM-mounted
 * component), so the real react-dom isn't needed.
 *
 * This stub exports the shape AiContentField touches — `flushSync`
 * with synchronous-call passthrough — so module-load succeeds. Any
 * test that genuinely needs DOM behaviour should switch its file's
 * environment to 'jsdom' instead of using this stub.
 */
export function flushSync<T>(fn: () => T): T {
  return fn();
}

export default { flushSync };
