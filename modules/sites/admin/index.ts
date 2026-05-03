/**
 * Sites admin UI — public exports for the admin app.
 *
 * The admin app's PageEditorRoute mounts <PageEditor site={...} page={...}
 * contentSchema={...} HtmlBlockListEditor={AdminBlockListEditor} />, and
 * the dispatch component routes to the right editor for the site's
 * theme_kind.
 */

export { PageEditor, type PageEditorProps, type PageEditorContentSchema } from './page-editor/index.js';
export {
  SchemaEditor, type SchemaEditorProps,
  Field, type FieldProps, type FieldRenderer, type FieldRendererMap,
  walkFields, classifyEditorKind, buildDefault, getAtPointer, setAtPointer,
  type SchemaNode, type FieldDescriptor, type FieldEditorKind,
} from './schema-editor/index.js';
