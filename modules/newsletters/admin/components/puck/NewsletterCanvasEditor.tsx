/**
 * NewsletterCanvasEditor — thin wrapper around NewsletterPuckCanvas.
 *
 * Previously this dispatched between the legacy EditionCanvas and the
 * Puck-based wrapper via the VITE_NEWSLETTERS_CANVAS_ENGINE_DEFAULT env
 * var. The legacy editor has been removed; this is now a pure pass-through
 * kept only so the call site in pages/editions/[id].tsx doesn't churn.
 */

import type { FC, ReactNode } from 'react';
import { NewsletterPuckCanvas } from './NewsletterPuckCanvas';
import type {
  NewsletterEdition,
  BlockTemplate,
  BrickTemplate,
} from '../../utils/types.js';
import type { BlockTemplate as PaletteBlockTemplate } from '../BlockPalette';

interface NewsletterCanvasEditorProps {
  edition: NewsletterEdition;
  blockTemplates: (PaletteBlockTemplate & BlockTemplate)[];
  brickTemplates: BrickTemplate[];
  collectionMetadata?: Record<string, unknown>;
  collectionId?: string;
  /** Declarative wrapper template HTML for this newsletter (templates_wrappers
   *  row, key='default'). Threaded into the puck canvas so the live preview +
   *  every exportEditionHtml call wrap the body in the same chrome. */
  wrapperTemplate?: string | null;
  /** Resolved "View Online" URL for this edition. Threaded through to
   *  EditionEmail so the wrapper's `{{edition.view_online_link}}` renders the
   *  actual portal/external URL in the editor preview AND every send. See
   *  utils/view-online-url.ts. */
  viewOnlineUrl?: string | null;
  onChange: (edition: NewsletterEdition) => void;
  onSave: (options?: { silent?: boolean }) => Promise<void> | void;
  onStatusChange?: (status: string) => void;
  isSaving?: boolean;
  /** react-email component_ids registered against this library. Per
   *  spec-builder-evaluation §3.6 (extended). The PuckCanvas layer
   *  uses these to merge registry components into its Config. */
  enabledRegistryComponentIds?: ReadonlyArray<string>;
  /** Hide the newsletter-specific action cluster (HTML/Substack/Beehiiv/Test
   *  Send/Save Draft/Publish) — for non-newsletter hosts like broadcasts. */
  hideDefaultActions?: boolean;
  /** Custom toolbar actions (e.g. a broadcast's Save / Send buttons). */
  toolbarActions?: ReactNode;
}

export const NewsletterCanvasEditor: FC<NewsletterCanvasEditorProps> = (props) => (
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
    {...(props.viewOnlineUrl !== undefined ? { viewOnlineUrl: props.viewOnlineUrl } : {})}
    {...(props.hideDefaultActions !== undefined ? { hideDefaultActions: props.hideDefaultActions } : {})}
    {...(props.toolbarActions !== undefined ? { toolbarActions: props.toolbarActions } : {})}
  />
);

export default NewsletterCanvasEditor;
