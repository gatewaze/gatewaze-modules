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
 *   1. Reads the currently-selected component's id reactively via a
 *      `createUsePuck` selector — the field renders in the right
 *      sidebar, which only mounts when an item is selected. We
 *      subscribe to a thin slice (just the id) so a typing keystroke
 *      doesn't re-render the entire AI field.
 *   2. Reads the rest of the selection (props for content snapshot)
 *      and the dispatcher imperatively via `useGetPuck()` — those are
 *      only consulted at action time (write keystrokes pass through
 *      onChange; sibling-key writes use `dispatch` in handleAiChange).
 *   3. Routes `AiContentField`'s `onChange(key, value)` calls through
 *      Puck's `dispatch({ type: 'replace' })` so all the side-key
 *      writes commit atomically and trigger a single onChange roundtrip
 *      to the parent NewsletterEdition.
 *   4. Pulls collectionMetadata + onSaveEdition from the
 *      NewsletterEditingContext mounted by NewsletterPuckCanvas — the
 *      AI field needs the per-newsletter helix_project_id override and
 *      the ability to flush the edition before kicking off the agent
 *      task (the edge function looks up the block row by id).
 *
 * Performance notes:
 *   - Earlier draft used `usePuck()` (no selector). Puck v0.21 warns
 *     in dev that this subscribes to ALL state and re-renders this
 *     adapter on every keystroke in the canvas. The current shape
 *     uses `createUsePuck<Config>()` + a thin selector for the few
 *     reactive bits we need; everything else is pulled lazily.
 */

import { useCallback, useMemo } from 'react';
import { type Config, createUsePuck, useGetPuck } from '@puckeditor/core';
import { AiContentField } from '../../AiContentField.js';
import { useNewsletterEditing } from '../NewsletterEditingContext.js';

interface PuckCustomFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  /** Puck-generated id; opaque to us. */
  id?: string;
  name?: string;
}

const usePuckSelector = createUsePuck<Config>();

export function HelixAiFieldAdapter({ value, onChange, name }: PuckCustomFieldProps) {
  const { collectionMetadata, onSaveEdition } = useNewsletterEditing();
  const getPuck = useGetPuck();
  const fieldName = name ?? 'ai_body';

  // Reactive: the selected item's id. Re-renders only when the user
  // moves selection to a different block (cheap). Every other Puck
  // state change (typing in another field, drag operations, etc.) is
  // absorbed by this selector.
  const blockId = usePuckSelector((s) => {
    const sel = s.selectedItem;
    if (!sel) return undefined;
    const props = sel.props as { id?: unknown } | undefined;
    return typeof props?.id === 'string' ? props.id : undefined;
  });

  // Build the `content` object AiContentField expects (it reads
  // `${fieldName}`, `${fieldName}_prompt`, `${fieldName}_helix_task_id`,
  // `${fieldName}_helix_project_id`, `${fieldName}_helix_output_imported_at`).
  // We pull selectedItem.props at memo time only — the field's primary
  // value comes through `value` so AiContentField always sees the
  // freshest user input. The other side-keys are derived from the
  // committed Puck state, which suffices for the realtime helix sync
  // checks (those are written via dispatch and read back here once
  // selection re-resolves).
  const content = useMemo<Record<string, unknown>>(() => {
    const sel = getPuck().selectedItem;
    const props = (sel?.props ?? {}) as Record<string, unknown>;
    return {
      ...props,
      [fieldName]: typeof value === 'string' ? value : '',
    };
    // `getPuck` is stable; depending on `value` keeps the field's
    // freshly-typed body in sync. blockId is included so the
    // sibling-key snapshot refreshes on selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, fieldName, blockId]);

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
      const puck = getPuck();
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
    [fieldName, onChange, getPuck],
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
