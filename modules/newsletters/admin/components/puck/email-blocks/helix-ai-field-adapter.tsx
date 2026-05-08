/**
 * Bridge between Puck's per-field custom-render API and AiContentField's
 * multi-key data shape.
 *
 * Puck calls custom-field renders with `{ value, onChange, name, id }` —
 * one field at a time. `AiContentField` writes to multiple sibling
 * fields on the same block (ai_body, ai_body_helix_task_id,
 * ai_body_prompt, ai_body_helix_project_id,
 * ai_body_helix_output_imported_at) because the helix-task-create edge
 * function and the helix-output-sync worker persist into those flat
 * keys server-side.
 *
 * To wire one renderer per field while still letting the field touch
 * its siblings, this adapter:
 *
 *   1. Reads the currently-selected component's full props via
 *      `usePuck().selectedItem` — the field renders in the right
 *      sidebar, which only mounts when an item is selected, so
 *      selectedItem is reliably the parent block.
 *   2. Routes `AiContentField`'s `onChange(key, value)` calls through
 *      Puck's `dispatch({ type: 'replace' })` so all the side-key
 *      writes commit atomically and trigger a single onChange roundtrip
 *      to the parent NewsletterEdition.
 *   3. Pulls collectionMetadata + onSaveEdition from the
 *      NewsletterEditingContext mounted by NewsletterPuckCanvas — the
 *      AI field needs the per-newsletter helix_project_id override and
 *      the ability to flush the edition before kicking off the agent
 *      task (the edge function looks up the block row by id).
 */

import { useCallback, useMemo } from 'react';
import { usePuck } from '@puckeditor/core';
import { AiContentField } from '../../AiContentField.js';
import { useNewsletterEditing } from '../NewsletterEditingContext.js';

interface PuckCustomFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  /** Puck-generated id; opaque to us. */
  id?: string;
  name?: string;
}

export function HelixAiFieldAdapter({ value, onChange, name }: PuckCustomFieldProps) {
  const puck = usePuck();
  const { collectionMetadata, onSaveEdition } = useNewsletterEditing();

  const fieldName = name ?? 'ai_body';

  // The adapter renders inside the right sidebar. Puck mounts the
  // sidebar against `selectedItem` — that's the block our field
  // belongs to.
  const selected = puck.selectedItem;
  const blockId = selected?.props && typeof (selected.props as { id?: unknown }).id === 'string'
    ? ((selected.props as { id: string }).id)
    : undefined;

  // Build the `content` object AiContentField expects (it reads
  // `${fieldName}`, `${fieldName}_prompt`, `${fieldName}_helix_task_id`,
  // `${fieldName}_helix_project_id`, `${fieldName}_helix_output_imported_at`).
  const content = useMemo<Record<string, unknown>>(() => {
    const props = (selected?.props ?? {}) as Record<string, unknown>;
    return {
      ...props,
      // Ensure the field's primary value reflects what Puck passed us
      // (it might be ahead of selectedItem.props during a render cycle).
      [fieldName]: typeof value === 'string' ? value : '',
    };
  }, [selected, value, fieldName]);

  // AiContentField calls onChange(key, value). We route every write
  // through Puck's `replace` action so siblings update atomically.
  const handleAiChange = useCallback(
    (key: string, nextValue: unknown) => {
      // The primary field — bypass dispatch, use Puck's onChange so the
      // standard field commit path (autosave, history) still fires.
      if (key === fieldName) {
        onChange(nextValue);
        return;
      }
      // Sibling field — locate the selected component in the current
      // app-state and dispatch a `replace` carrying the merged props.
      const sel = puck.appState.ui.itemSelector;
      if (!sel) return;
      const item = puck.getItemBySelector(sel);
      if (!item) return;
      puck.dispatch({
        type: 'replace',
        destinationIndex: sel.index,
        destinationZone: sel.zone ?? 'default-zone',
        data: {
          type: item.type,
          props: { ...(item.props as Record<string, unknown>), [key]: nextValue },
        },
      });
    },
    [fieldName, onChange, puck],
  );

  return (
    <AiContentField
      fieldName={fieldName}
      fieldSchema={{}}
      content={content}
      {...(blockId ? { blockId } : {})}
      collectionMetadata={collectionMetadata}
      onChange={handleAiChange}
      {...(onSaveEdition ? { onSaveEdition: async () => { await onSaveEdition(); } } : {})}
    />
  );
}
