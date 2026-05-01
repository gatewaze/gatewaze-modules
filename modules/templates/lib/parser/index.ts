/**
 * Public parser API.
 *
 * Usage:
 *   import { parse } from '@gatewaze-modules/templates/parser';
 *   const result = parse(html, { sourcePath: 'gatewaze/blocks/hero.html' });
 *
 * The returned ParseResult is documented in `../../types/index.ts`.
 */

export { parse } from './parse.js';
export type { ParseOptions } from './parse.js';
export {
  extractMustacheRefs,
  parseAttributes,
  type MustacheRef,
} from './markers.js';
export {
  lintNoSecretsInHtml,
  lintTripleStashOnlyInHtmlFields,
  lintMustacheRefsResolveAgainstSchema,
  type LintIssue,
} from './lint.js';
