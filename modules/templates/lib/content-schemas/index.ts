/**
 * Public content-schema API. Consumed by the templates worker (schema
 * ingest) and the sites runtime API (variant resolution / Vary header
 * computation).
 */

export {
  validateContentSchema,
  type ContentSchemaIssue,
  type ValidateContentSchemaResult,
} from './validate.js';

export {
  classifySchemaDrift,
  type DriftSeverity,
  type SchemaDriftItem,
  type ClassifySchemaDriftResult,
} from './classify-drift.js';

export {
  walkPersonalizationAxes,
  appliedAxesForField,
  type FieldPersonalization,
} from './walk-personalization.js';

export {
  compileTsSchema,
  pickCompileStrategy,
  DEFAULT_TS_COMPILER_OPTIONS,
  type CompileTsSchemaInput,
  type CompileTsSchemaResult,
} from './compile-ts.js';
