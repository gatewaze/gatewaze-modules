/**
 * Top-level schema-driven editor for theme_kind='website' pages.
 *
 * Stores its own local draft state and emits onSave({route, content,
 * schemaVersion, baseCommitSha}). The consumer wires onSave into the
 * batch endpoint (POST /admin/sites/:siteSlug/content:batch).
 *
 * The variant editor for personalizable fields is delegated to a
 * VariantEditor component the consumer passes in via `renderVariantEditor`,
 * because the admin app's RenderContext picker (locale / persona / utm) is
 * platform-specific.
 */

import * as React from 'react';
import { Field, type FieldRendererMap } from './Field.js';
import { type SchemaNode, buildDefault } from './walk-schema.js';

export interface SchemaEditorProps {
  /** The route this editor is editing. */
  route: string;
  /** templates_content_schemas.schema_json. */
  schema: SchemaNode;
  /** templates_content_schemas.version — passed back on save for drift detection. */
  schemaVersion: number;
  /** Initial content. Use null for new pages — the editor scaffolds defaults. */
  initialContent: Record<string, unknown> | null;
  /** Captured commit SHA for the loaded draft (drives drift detection on save). */
  baseCommitSha: string | null;
  /** Field renderer overrides (e.g., admin app's rich-text editor). */
  renderers?: FieldRendererMap;
  /** Triggered when the editor's Save button is pressed. Promise resolves with the new committed state. */
  onSave: (args: {
    route: string;
    content: Record<string, unknown>;
    schemaVersion: number;
    baseCommitSha: string | null;
  }) => Promise<void>;
  /** Fired when the user clicks "Personalize" on a personalizable field. */
  onPersonalize?: (pointer: string) => void;
}

export const SchemaEditor: React.FC<SchemaEditorProps> = ({
  route,
  schema,
  schemaVersion,
  initialContent,
  baseCommitSha,
  renderers,
  onSave,
  onPersonalize,
}) => {
  const [content, setContent] = React.useState<Record<string, unknown>>(
    () => (initialContent ?? (buildDefault(schema) as Record<string, unknown>)),
  );
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      await onSave({ route, content, schemaVersion, baseCommitSha });
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="gw-schema-editor">
      <header className="gw-schema-editor__header">
        <h2>{route}</h2>
        <span className="gw-schema-editor__schema-version">schema v{schemaVersion}</span>
        {dirty && <span className="gw-schema-editor__dirty">● unsaved</span>}
      </header>
      {err && <div className="gw-schema-editor__error" role="alert">{err}</div>}
      <Field
        pointer=""
        schema={schema}
        value={content}
        onChange={(next) => {
          setContent(next as Record<string, unknown>);
          setDirty(true);
        }}
        onPersonalize={onPersonalize}
        renderers={renderers}
      />
      <footer className="gw-schema-editor__footer">
        <button
          type="button"
          className="gw-schema-editor__save"
          disabled={saving || !dirty}
          onClick={() => { void handleSave(); }}
        >
          {saving ? 'Saving…' : 'Save draft'}
        </button>
      </footer>
    </div>
  );
};
