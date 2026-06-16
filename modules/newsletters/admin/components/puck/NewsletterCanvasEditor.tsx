/**
 * NewsletterCanvasEditor — engine-dispatching wrapper.
 *
 * Mirrors the sites-module CanvasEditor pattern: read a flag, mount
 * either the legacy EditionCanvas or the new Puck-based wrapper.
 *
 * The flag is a build-time env var
 * (`VITE_NEWSLETTERS_CANVAS_ENGINE_DEFAULT`) for now, with a
 * per-edition override hook for future use. Default is `'legacy'`
 * — opt in explicitly per environment.
 */

import type { FC } from 'react';
import { EditionCanvas } from '../EditionCanvas';
import { NewsletterPuckCanvas } from './NewsletterPuckCanvas';
import type {
  NewsletterEdition,
  BlockTemplate,
  BrickTemplate,
} from '../../utils/types.js';
import type { BlockTemplate as PaletteBlockTemplate } from '../BlockPalette';

type NewsletterCanvasEngine = 'legacy' | 'puck';

interface NewsletterCanvasEditorProps {
  edition: NewsletterEdition;
  blockTemplates: (PaletteBlockTemplate & BlockTemplate)[];
  brickTemplates: BrickTemplate[];
  collectionMetadata?: Record<string, unknown>;
  collectionId?: string;
  /** Declarative wrapper template HTML for this newsletter (templates_wrappers
   *  row, key='default'). Threaded into the puck canvas so the live preview +
   *  every exportEditionHtml call wrap the body in the same chrome. The legacy
   *  EditionCanvas engine forwards it to HtmlPreview's production-HTML render. */
  wrapperTemplate?: string | null;
  onChange: (edition: NewsletterEdition) => void;
  onSave: (options?: { silent?: boolean }) => Promise<void> | void;
  onStatusChange?: (status: string) => void;
  isSaving?: boolean;
  /** Per-edition override; falls back to platform default when absent. */
  engine?: NewsletterCanvasEngine;
  /** react-email component_ids registered against this library. Per
   *  spec-builder-evaluation §3.6 (extended). The PuckCanvas layer
   *  uses these to merge registry components into its Config. */
  enabledRegistryComponentIds?: ReadonlyArray<string>;
}

function resolveEngine(override: NewsletterCanvasEngine | undefined): NewsletterCanvasEngine {
  if (override === 'legacy' || override === 'puck') return override;
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const fromEnv = env.VITE_NEWSLETTERS_CANVAS_ENGINE_DEFAULT;
  if (fromEnv === 'legacy' || fromEnv === 'puck') return fromEnv;
  return 'legacy';
}

export const NewsletterCanvasEditor: FC<NewsletterCanvasEditorProps> = (props) => {
  const engine = resolveEngine(props.engine);
  if (engine === 'puck') {
    return (
      <NewsletterPuckCanvas
        edition={props.edition}
        blockTemplates={props.blockTemplates}
        brickTemplates={props.brickTemplates}
        onChange={props.onChange}
        {...(props.onSave ? { onSave: props.onSave } : {})}
        {...(props.isSaving !== undefined ? { isSaving: props.isSaving } : {})}
        {...(props.enabledRegistryComponentIds ? { enabledRegistryComponentIds: props.enabledRegistryComponentIds } : {})}
        {...(props.collectionMetadata ? { collectionMetadata: props.collectionMetadata } : {})}
        {...(props.collectionId ? { collectionId: props.collectionId } : {})}
        {...(props.wrapperTemplate !== undefined ? { wrapperTemplate: props.wrapperTemplate } : {})}
      />
    );
  }
  return <EditionCanvas {...props} />;
};

export default NewsletterCanvasEditor;
