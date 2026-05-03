/**
 * Schema-driven editor — public surface for the admin app.
 *
 * The admin app imports SchemaEditor and passes it the platform-specific
 * field renderers (rich text widget, media picker) via the renderers prop.
 * The editor handles the local draft state + wires save into the batch
 * endpoint via onSave.
 */

export { SchemaEditor, type SchemaEditorProps } from './SchemaEditor.js';
export {
  Field,
  asString, asNumber, asBool,
  type FieldProps,
  type FieldRenderer,
  type FieldRendererMap,
  type FieldRendererContext,
} from './Field.js';
export {
  walkFields,
  classifyEditorKind,
  buildDefault,
  getAtPointer,
  setAtPointer,
  type SchemaNode,
  type FieldDescriptor,
  type FieldEditorKind,
} from './walk-schema.js';
