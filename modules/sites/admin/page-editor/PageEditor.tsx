/**
 * Top-level Page Editor dispatch.
 *
 * Sites are uniformly theme_kind='website' and render via <SchemaEditor />
 * with a save handler that hits the batch endpoint. The dispatcher form is
 * retained so future theme kinds can add a branch without touching the
 * admin app.
 */

import * as React from 'react';
import type { PageRow, SiteRow } from '../../types/index.js';
import { SchemaEditor, type SchemaEditorProps } from '../schema-editor/SchemaEditor.js';
import type { FieldRendererMap, SchemaNode } from '../schema-editor/index.js';

export interface PageEditorContentSchema {
  /** templates_content_schemas.schema_json — the JSON Schema for `pages.content`. */
  schema_json: SchemaNode;
  version: number;
}

export interface PageEditorProps {
  site: Pick<SiteRow, 'id' | 'slug' | 'theme_kind'>;
  page: Pick<PageRow, 'id' | 'full_path' | 'content' | 'content_schema_version'>;
  /** Pre-loaded by the admin app from templates_content_schemas. */
  contentSchema: PageEditorContentSchema | null;
  /** Captured at draft load (used for drift detection on save). */
  baseCommitSha: string | null;
  /** Renderer overrides (rich text, media picker). */
  renderers?: FieldRendererMap;
  /** Optional override for the save callback (tests). Defaults to fetch /admin/sites/:siteSlug/content:batch. */
  onSave?: SchemaEditorProps['onSave'];
  /** Optional callback when user clicks "Personalize" on a field. The admin app opens its variant editor. */
  onPersonalize?: (pointer: string) => void;
}

export const PageEditor: React.FC<PageEditorProps> = ({
  site,
  page,
  contentSchema,
  baseCommitSha,
  renderers,
  onSave,
  onPersonalize,
}) => {
  if (site.theme_kind === 'website') {
    if (!contentSchema) {
      return (
        <div className="gw-page-editor__placeholder">
          Loading content schema…
        </div>
      );
    }
    const handleSave: SchemaEditorProps['onSave'] = onSave ?? defaultBatchSaver(site.slug);
    return (
      <SchemaEditor
        route={page.full_path}
        schema={contentSchema.schema_json}
        schemaVersion={contentSchema.version}
        initialContent={page.content}
        baseCommitSha={baseCommitSha}
        onSave={handleSave}
        onPersonalize={onPersonalize}
        {...(renderers ? { renderers } : {})}
      />
    );
  }

  return (
    <div className="gw-page-editor__placeholder">
      Unsupported theme_kind: <code>{site.theme_kind}</code>
    </div>
  );
};

/**
 * Default save adapter: POSTs the single-draft batch to the sites admin
 * endpoint. The admin app can override via `onSave` prop for cases like
 * the multi-tab "Save All" workflow.
 */
function defaultBatchSaver(siteSlug: string): SchemaEditorProps['onSave'] {
  return async ({ route, content, schemaVersion, baseCommitSha }) => {
    const url = `/api/modules/sites/admin/sites/${encodeURIComponent(siteSlug)}/content:batch`;
    const body = { drafts: [{ route, content, schemaVersion, baseCommitSha }] };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`save failed (${res.status}): ${detail}`);
    }
  };
}
