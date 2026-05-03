/**
 * Theme apply conflict resolver — side-by-side diff + resolution actions.
 *
 * Per spec-content-modules-git-architecture §6.2:
 *
 *   When the apply step detects schema-affecting changes:
 *   - Side-by-side diff: current `publish` vs incoming `main`
 *   - Per-conflict choice: adopt new schema with defaults | bulk-update
 *     existing pages | pin existing instances to prior schema version |
 *     abort apply
 *
 * Opens as a modal driven by the Source tab when POST /apply-theme
 * returns 409 with `details.conflicts`.
 */

import { useState } from 'react';
import { Badge, Button, Card, Modal, Select } from '@/components/ui';
import { ExclamationTriangleIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';

export type ConflictKind = 'safe' | 'breaking' | 'block_removed' | 'wrapper_removed';

export type ResolutionOption =
  | 'adopt_with_defaults'
  | 'bulk_update_pages'
  | 'pin_old_version'
  | 'replace_block'
  | 'abort';

export interface AffectedPage {
  id: string;
  slug: string;
  title: string;
}

export interface SchemaConflict {
  block: string;
  kind: ConflictKind;
  removed_required_field?: string;
  added_required_field?: string;
  type_narrowed_field?: { field: string; from: string; to: string };
  affectedPages: AffectedPage[];
  resolution_options: ResolutionOption[];
}

export interface ConflictResolverProps {
  isOpen: boolean;
  onClose: () => void;
  /** Site id passed back to the apply-resolution endpoint. */
  siteId: string;
  /** Conflicts returned from POST /apply-theme 409 response. */
  conflicts: SchemaConflict[];
  /** Optional callback after a resolution submits successfully. */
  onResolved?: () => void;
}

interface PerConflictChoice {
  resolution: ResolutionOption | '';
  /** For replace_block: the chosen replacement block name. */
  replacementBlock?: string;
  /** For bulk_update_pages: field-rename mapping (old → new). */
  fieldMap?: Record<string, string>;
}

const RESOLUTION_LABELS: Record<ResolutionOption, string> = {
  adopt_with_defaults: 'Adopt new schema with defaults',
  bulk_update_pages: 'Bulk-update existing pages',
  pin_old_version: 'Pin existing pages to old schema',
  replace_block: 'Replace with another block',
  abort: 'Abort apply',
};

const RESOLUTION_HINTS: Record<ResolutionOption, string> = {
  adopt_with_defaults: 'Only valid when fields were added optional or types were widened. Existing instances get the schema default.',
  bulk_update_pages: 'You provide a field-rename mapping; gatewaze updates all affected page_blocks rows in one transaction.',
  pin_old_version: 'Affected pages render with the prior block version (held in git history). New instances use the new schema.',
  replace_block: 'Pick a replacement block from the current library; affected pages swap to it.',
  abort: 'Cancel the apply. No changes to publish branch.',
};

export function ThemeApplyConflictResolver({
  isOpen,
  onClose,
  siteId,
  conflicts,
  onResolved,
}: ConflictResolverProps) {
  const [choices, setChoices] = useState<Record<string, PerConflictChoice>>(() =>
    Object.fromEntries(conflicts.map((c) => [c.block, { resolution: '' }])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const updateChoice = (block: string, patch: Partial<PerConflictChoice>) => {
    setChoices((prev) => ({ ...prev, [block]: { ...(prev[block] ?? { resolution: '' }), ...patch } }));
  };

  const allResolved = conflicts.every((c) => choices[c.block]?.resolution);
  const totalAffected = conflicts.reduce((sum, c) => sum + c.affectedPages.length, 0);

  const onSubmit = async () => {
    if (!allResolved) {
      toast.error('Pick a resolution for every conflict');
      return;
    }
    if (Object.values(choices).some((c) => c.resolution === 'abort')) {
      onClose();
      toast.info('Apply aborted');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(`/api/sites/${siteId}/apply-theme/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolutions: Object.entries(choices).map(([block, choice]) => ({
            block,
            resolution: choice.resolution,
            replacement_block: choice.replacementBlock,
            field_map: choice.fieldMap,
          })),
        }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        toast.error(body.message ?? 'Resolve failed');
        return;
      }
      toast.success('Theme update applied with resolutions');
      onResolved?.();
      onClose();
    } catch (err) {
      toast.error('Resolve endpoint not yet implemented');
    } finally {
      setSubmitting(false);
    }
  };

  if (conflicts.length === 0) return null;

  const active = conflicts[activeIndex];
  if (!active) return null;
  const activeChoice = choices[active.block] ?? { resolution: '' };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Resolve theme update conflicts"
      size="3"
      footer={
        <div className="flex items-center justify-between w-full">
          <p className="text-xs text-[var(--gray-a8)]">
            {Object.values(choices).filter((c) => c.resolution).length} of {conflicts.length} resolved
            {' · '}
            {totalAffected} affected page{totalAffected === 1 ? '' : 's'}
          </p>
          <div className="flex gap-2">
            <Button variant="outlined" onClick={onClose}>Cancel</Button>
            <Button onClick={onSubmit} disabled={!allResolved || submitting}>
              {submitting ? 'Applying…' : 'Apply with resolutions'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        {/* Conflict list */}
        <div className="space-y-1">
          {conflicts.map((c, i) => {
            const resolved = !!choices[c.block]?.resolution;
            return (
              <button
                key={c.block}
                onClick={() => setActiveIndex(i)}
                className={`w-full text-left px-3 py-2 rounded-md border ${
                  i === activeIndex ? 'border-[var(--accent-9)] bg-[var(--accent-3)]' : 'border-[var(--gray-a4)] hover:bg-[var(--gray-a3)]'
                }`}
              >
                <div className="flex items-center gap-2">
                  {resolved ? (
                    <Badge variant="soft" color="green" size="1">resolved</Badge>
                  ) : (
                    <ExclamationTriangleIcon className="size-4 text-yellow-500" />
                  )}
                  <span className="font-medium text-sm truncate">{c.block}</span>
                </div>
                <div className="text-xs text-[var(--gray-a8)] mt-1">
                  <Badge variant="soft" color={c.kind === 'breaking' ? 'red' : c.kind === 'safe' ? 'green' : 'orange'} size="1">
                    {c.kind}
                  </Badge>
                  <span className="ml-2">{c.affectedPages.length} affected</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Active conflict detail */}
        <Card>
          <div className="p-4 space-y-4">
            <div>
              <h3 className="font-semibold text-base">
                Block: <code>{active.block}</code>
              </h3>
              <p className="text-sm text-[var(--gray-a8)] mt-1">
                {active.removed_required_field && (
                  <>Removed required field: <code>{active.removed_required_field}</code>. </>
                )}
                {active.added_required_field && (
                  <>Added required field: <code>{active.added_required_field}</code>. </>
                )}
                {active.type_narrowed_field && (
                  <>
                    Field <code>{active.type_narrowed_field.field}</code> narrowed{' '}
                    <code>{active.type_narrowed_field.from}</code> → <code>{active.type_narrowed_field.to}</code>.
                  </>
                )}
              </p>
            </div>

            {/* Affected pages preview */}
            <div>
              <p className="text-sm font-medium mb-1">Affected pages ({active.affectedPages.length})</p>
              <div className="max-h-32 overflow-y-auto rounded-md border border-[var(--gray-a4)]">
                <ul className="text-sm">
                  {active.affectedPages.map((p) => (
                    <li key={p.id} className="px-3 py-1.5 border-b border-[var(--gray-a3)] last:border-b-0">
                      <code className="text-[var(--gray-a8)]">{p.slug}</code>
                      <span className="ml-2">{p.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Resolution picker */}
            <div>
              <p className="text-sm font-medium mb-2">Choose a resolution</p>
              <div className="space-y-2">
                {active.resolution_options.map((opt) => (
                  <label key={opt} className="flex items-start gap-2 p-3 rounded-md border border-[var(--gray-a4)] hover:bg-[var(--gray-a2)] cursor-pointer">
                    <input
                      type="radio"
                      name={`resolution-${active.block}`}
                      checked={activeChoice.resolution === opt}
                      onChange={() => updateChoice(active.block, { resolution: opt })}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-sm">{RESOLUTION_LABELS[opt]}</div>
                      <div className="text-xs text-[var(--gray-a8)] mt-0.5">{RESOLUTION_HINTS[opt]}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Replacement-block picker (when replace_block selected) */}
            {activeChoice.resolution === 'replace_block' && (
              <div>
                <Select
                  label="Replacement block"
                  value={activeChoice.replacementBlock ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateChoice(active.block, { replacementBlock: e.target.value })}
                  data={[
                    { value: '', label: '— pick a replacement —' },
                    // Replacement options come from the current library;
                    // wired via an API fetch in the production version.
                    { value: 'rich-text', label: 'rich-text (RichText)' },
                    { value: 'feature-grid', label: 'feature-grid (FeatureGrid)' },
                  ]}
                />
              </div>
            )}

            {/* Field-map editor (when bulk_update_pages selected) */}
            {activeChoice.resolution === 'bulk_update_pages' && active.removed_required_field && (
              <div>
                <p className="text-sm font-medium mb-2">Map old field → new field</p>
                <div className="flex items-center gap-2 text-sm">
                  <code className="px-2 py-1 bg-[var(--gray-a3)] rounded">{active.removed_required_field}</code>
                  <ArrowsRightLeftIcon className="size-4 text-[var(--gray-a8)]" />
                  <input
                    type="text"
                    placeholder="new field name"
                    value={activeChoice.fieldMap?.[active.removed_required_field] ?? ''}
                    onChange={(e) =>
                      updateChoice(active.block, {
                        fieldMap: { ...(activeChoice.fieldMap ?? {}), [active.removed_required_field!]: e.target.value },
                      })
                    }
                    className="flex-1 px-3 py-1.5 text-sm bg-transparent border border-[var(--gray-a5)] rounded-md"
                  />
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>
    </Modal>
  );
}
