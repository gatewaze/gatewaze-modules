/**
 * Starter template picker — modal that lists pre-baked block trees
 * (`starter-templates/index.ts`) and applies the chosen one to the
 * current edition. Replaces all blocks; the parent confirms the
 * destructive action when the edition isn't already empty.
 *
 * Apply path:
 *   1. Look up the starter by slug.
 *   2. For each entry, synthesise an EditionBlock with a fresh UUID,
 *      a synthetic BlockTemplate (id: '', block_type: componentId)
 *      so the canvas adapter recognises it as a registry-stamp, and
 *      sort_order spaced by 1000.
 *   3. Emit the new edition upstream via `onApply`. The parent
 *      handles persistence.
 */

import { type FC, type ReactNode, useState } from 'react';
import type { NewsletterEdition, EditionBlock } from '../../utils/types.js';
import type { EmailBlockRegistry } from './email-blocks/registry-types.js';
import { ALL_STARTERS, type StarterTemplate } from './starter-templates/index.js';

export interface StarterTemplatePickerProps {
  open: boolean;
  /** Current edition — used to detect non-empty state and warn. */
  edition: NewsletterEdition;
  /** Registry — only starters whose blocks are all in the registry are shown. */
  registry: EmailBlockRegistry;
  onApply: (next: NewsletterEdition) => void;
  onClose: () => void;
}

export const StarterTemplatePicker: FC<StarterTemplatePickerProps> = ({
  open,
  edition,
  registry,
  onApply,
  onClose,
}) => {
  const [pendingApply, setPendingApply] = useState<StarterTemplate | null>(null);
  if (!open) return null;

  const isEmpty = edition.blocks.length === 0;
  // A Barebone-derived starter may include nested registry types in
  // its tree — only check the top-level `type` of each block here;
  // the recursive apply path will surface a fallback for any deeper
  // unknown types.
  const visible = ALL_STARTERS.filter((s) => s.blocks.every((b) => registry.has(b.type)));

  const apply = (starter: StarterTemplate) => {
    const next: NewsletterEdition = {
      ...edition,
      blocks: starter.blocks.map<EditionBlock>((entry, idx) => {
        const reg = registry.get(entry.type)!;
        // Stamp fresh ids recursively into the nested children tree —
        // saved starter trees don't carry ids (stripped on generation),
        // and reusing stale ids would confuse Puck's identity tracking
        // when the same starter is applied twice.
        const stamped = stampIdsRecursively(entry);
        const { children, ...flatProps } = stamped.props as Record<string, unknown>;
        const content: Record<string, unknown> = { ...flatProps };
        if (Array.isArray(children)) content.children = children;
        return {
          id: freshUuid(),
          block_template: {
            id: '',
            name: reg.label,
            block_type: reg.componentId,
            content: { html_template: '', schema: {}, has_bricks: false },
          },
          content,
          sort_order: (idx + 1) * 1000,
          bricks: [],
        };
      }),
    };
    onApply(next);
    setPendingApply(null);
    onClose();
  };

  function stampIdsRecursively(node: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
    const props: Record<string, unknown> = { ...node.props, id: freshUuid() };
    if (Array.isArray(props.children)) {
      props.children = (props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
        stampIdsRecursively(c),
      );
    }
    return { type: node.type, props };
  }

  const onPick = (starter: StarterTemplate) => {
    if (isEmpty) {
      apply(starter);
    } else {
      setPendingApply(starter);
    }
  };

  return (
    <div style={backdropStyle} onClick={onClose} role="presentation">
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Start from a template</h2>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">×</button>
        </div>

        {pendingApply ? (
          <ConfirmReplace
            starter={pendingApply}
            onCancel={() => setPendingApply(null)}
            onConfirm={() => apply(pendingApply)}
          />
        ) : (
          <ul style={listStyle}>
            {visible.map((s) => (
              <li key={s.slug} style={itemStyle}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 13, color: '#666' }}>{s.description}</div>
                  <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 }}>
                    {s.category}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPick(s)}
                  style={applyBtnStyle}
                >
                  {isEmpty ? 'Use template' : 'Replace…'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

function ConfirmReplace({
  starter,
  onCancel,
  onConfirm,
}: {
  starter: StarterTemplate;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <div style={{ padding: '16px 20px' }}>
      <p style={{ margin: '0 0 12px', fontSize: 14 }}>
        Applying <strong>{starter.label}</strong> will replace this edition&apos;s current blocks. This can&apos;t
        be undone unless you press Cmd-Z immediately afterwards.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={ghostBtnStyle}>Cancel</button>
        <button type="button" onClick={onConfirm} style={dangerBtnStyle}>Replace blocks</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function freshUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'flex-start',
  justifyContent: 'center', paddingTop: '8vh', zIndex: 10000,
};
const panelStyle: React.CSSProperties = {
  width: 560, maxWidth: 'calc(100vw - 32px)', background: '#fff',
  borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.18)', overflow: 'hidden',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 20px', borderBottom: '1px solid #eee',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', fontSize: 24, lineHeight: 1, cursor: 'pointer', padding: 0, color: '#666',
};
const listStyle: React.CSSProperties = {
  listStyle: 'none', margin: 0, padding: 0, maxHeight: '60vh', overflowY: 'auto',
};
const itemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '14px 20px', borderBottom: '1px solid #f3f3f3', gap: 16,
};
const applyBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #d0d5dd',
  background: '#fff', cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap',
};
const ghostBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #d0d5dd',
  background: '#fff', cursor: 'pointer', fontSize: 14,
};
const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #b42318',
  background: '#b42318', color: '#fff', cursor: 'pointer', fontSize: 14,
};
