export {
  normalizeRoute,
  joinRoute,
  type NormalizedRoute,
  type RouteValidationError,
  type RouteValidationResult,
} from './route-validation.js';

export {
  validateCreatePage,
  validateUpdatePage,
  assertContentMatchesThemeKind,
  PAGE_CREATE_FIELDS,
  PAGE_UPDATE_FIELDS,
  PAGE_NEXTJS_CONTENT_FIELDS,
  type CreatePageInput,
  type UpdatePageInput,
  type ValidationOk,
  type ValidationFail,
  type ValidationResult,
} from './validate.js';
