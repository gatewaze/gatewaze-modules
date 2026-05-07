/**
 * Variant picker — toolbar dropdown shown when the selected block is part
 * of an A/B test. Switches the block's `variant_key`. Per
 * spec-sites-wysiwyg-builder §5.2 + §6.
 *
 * v1 scope: fires `block.set_variant` to permanently change the rendered
 * variant. Editor-only preview (selectedBlockVariants) is wired through the
 * render endpoint but the variant-aware rendering (one page_block per
 * variant) is a Phase 2 schema change.
 */

import { BeakerIcon } from '@heroicons/react/24/outline';
import { Select } from '@/components/ui';
import type { AbTestSummary } from './canvas-service.js';

interface VariantPickerProps {
  abTest: AbTestSummary | null;
  /** Current variant_key on the selected block. */
  currentVariant: string;
  onChange: (variantKey: string) => void;
  disabled?: boolean;
}

export function VariantPicker({ abTest, currentVariant, onChange, disabled }: VariantPickerProps) {
  if (!abTest || abTest.variants.length === 0) return null;

  const statusColor = abTest.status === 'running'
    ? 'text-[var(--success-11)]'
    : abTest.status === 'paused'
      ? 'text-[var(--warning-11)]'
      : abTest.status === 'concluded'
        ? 'text-[var(--gray-a8)]'
        : 'text-[var(--gray-a8)]';

  return (
    <div className="flex items-center gap-2">
      <BeakerIcon className={`size-4 ${statusColor}`} />
      <span className="text-xs text-[var(--gray-a8)] font-medium" title={`A/B test "${abTest.name}" — ${abTest.status}`}>
        {abTest.name}
      </span>
      <Select
        value={currentVariant || abTest.variants[0]?.key}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        disabled={disabled}
        data={abTest.variants.map((v) => ({
          value: v.key,
          label: `${v.key} (${v.weight}%)`,
        }))}
      />
    </div>
  );
}
