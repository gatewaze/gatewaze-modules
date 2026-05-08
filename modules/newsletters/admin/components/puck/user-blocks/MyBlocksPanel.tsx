/**
 * Two related modals folded into one component, switched on `mode`:
 *
 *   - `mode='save'` — save modal that asks for a label + description,
 *     creates a UserBlock from the pendingSave tree, closes when done.
 *
 *   - `mode='browse'` — list modal that renders all saved blocks +
 *     handles re-insertion (callback into the canvas) and deletion.
 *
 * One file because the layout/style is identical and the only thing
 * that varies is which body is rendered.
 */
import { type FC, type ReactNode, useEffect, useState } from 'react';
import type { NewsletterEdition, EditionBlock } from '../../../utils/types.js';
import type { EmailBlockRegistry } from '../email-blocks/registry-types.js';
import { useUserBlocks } from './UserBlocksContext.js';
import type { UserBlock } from './types.js';

export interface MyBlocksPanelProps {
  open: boolean;
  mode: 'browse' | 'save';
  edition: NewsletterEdition;
  registry: EmailBlockRegistry;
  onApply: (next: NewsletterEdition) => void;
  onClose: () => void;
}

export const MyBlocksPanel: FC<MyBlocksPanelProps> = ({ open, mode, edition, registry, onApply, onClose }) => {
  const userBlocks = useUserBlocks();
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset form when the modal opens with a new pendingSave tree.
  useEffect(() => {
    if (mode === 'save' && open) {
      setLabel('');
      setDescription('');
      setSaving(false);
      setSaveError(null);
    }
  }, [mode, open, userBlocks.pendingSave]);

  if (!open) return null;

  return (
    <div style={backdropStyle} onClick={onClose} role="presentation">
      <div style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{mode === 'save' ? 'Save block' : 'My blocks'}</h2>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">×</button>
        </div>

        {mode === 'save' ? (
          <SaveBody
            label={label}
            setLabel={setLabel}
            description={description}
            setDescription={setDescription}
            saving={saving}
            saveError={saveError}
            onCancel={() => {
              userBlocks.clearPendingSave();
              onClose();
            }}
            onSubmit={async () => {
              const tree = userBlocks.pendingSave;
              if (!tree || !label.trim() || saving) return;
              setSaving(true);
              setSaveError(null);
              try {
                await userBlocks.saveBlock({ label: label.trim(), description: description.trim(), tree });
                userBlocks.clearPendingSave();
                onClose();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : String(e));
              } finally {
                setSaving(false);
              }
            }}
            disabled={!userBlocks.pendingSave || !label.trim() || saving}
          />
        ) : (
          <BrowseBody
            blocks={userBlocks.blocks}
            loadState={userBlocks.loadState}
            loadError={userBlocks.loadError}
            registry={registry}
            onInsert={(block) => {
              const next = applyUserBlockToEdition(edition, block, registry);
              onApply(next);
              onClose();
            }}
            onDelete={async (id) => {
              try {
                await userBlocks.deleteBlock(id);
              } catch (e) {
                // eslint-disable-next-line no-console
                console.error('[user-blocks] delete failed:', e);
              }
            }}
          />
        )}
      </div>
    </div>
  );
};

function SaveBody({
  label,
  setLabel,
  description,
  setDescription,
  onSubmit,
  onCancel,
  disabled,
  saving,
  saveError,
}: {
  label: string;
  setLabel: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  disabled: boolean;
  saving: boolean;
  saveError: string | null;
}): ReactNode {
  return (
    <div style={{ padding: '16px 20px' }}>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
        Block name
      </label>
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Three-column highlight row"
        autoFocus
        disabled={saving}
        style={inputStyle}
      />
      <label style={{ display: 'block', fontSize: 13, fontWeight: 500, margin: '12px 0 4px' }}>
        Description (optional)
      </label>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Where should I use this?"
        rows={3}
        disabled={saving}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      {saveError && (
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#b42318' }}>{saveError}</p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" onClick={onCancel} disabled={saving} style={ghostBtnStyle}>Cancel</button>
        <button type="button" onClick={onSubmit} disabled={disabled} style={disabled ? ghostBtnStyle : primaryBtnStyle}>
          {saving ? 'Saving…' : 'Save block'}
        </button>
      </div>
    </div>
  );
}

function BrowseBody({
  blocks,
  loadState,
  loadError,
  registry,
  onInsert,
  onDelete,
}: {
  blocks: ReadonlyArray<UserBlock>;
  loadState: 'idle' | 'loading' | 'ready' | 'error';
  loadError: string | null;
  registry: EmailBlockRegistry;
  onInsert: (block: UserBlock) => void;
  onDelete: (id: string) => void;
}): ReactNode {
  if (loadState === 'loading') {
    return <div style={{ padding: '32px 20px', textAlign: 'center', color: '#666' }}>Loading saved blocks…</div>;
  }
  if (loadState === 'error') {
    return (
      <div style={{ padding: '32px 20px', textAlign: 'center', color: '#b42318' }}>
        <p style={{ margin: '0 0 8px', fontWeight: 500 }}>Couldn&apos;t load saved blocks</p>
        <p style={{ margin: 0, fontSize: 13 }}>{loadError}</p>
      </div>
    );
  }
  if (blocks.length === 0) {
    return (
      <div style={{ padding: '32px 20px', textAlign: 'center', color: '#666' }}>
        <p style={{ margin: '0 0 8px', fontWeight: 500 }}>No saved blocks yet</p>
        <p style={{ margin: 0, fontSize: 13 }}>
          Click any block in the canvas, then choose <strong>★ Save block</strong> to stash it here.
        </p>
      </div>
    );
  }
  return (
    <ul style={listStyle}>
      {blocks.map((b) => {
        const reg = registry.get(b.tree.type);
        const knownType = !!reg;
        return (
          <li key={b.id} style={itemStyle}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{b.label}</div>
              {b.description && (
                <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>{b.description}</div>
              )}
              <div style={{ fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {knownType ? `${reg!.label}` : `Unknown type: ${b.tree.type}`} ·{' '}
                {new Date(b.created_at).toLocaleDateString()}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => onInsert(b)}
                disabled={!knownType}
                style={knownType ? primaryBtnStyle : ghostBtnStyle}
                title={knownType ? 'Append to current edition' : 'This block references an unknown component type'}
              >
                Insert
              </button>
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== 'undefined' && window.confirm(`Delete "${b.label}"?`)) {
                    onDelete(b.id);
                  }
                }}
                style={ghostBtnStyle}
                aria-label={`Delete ${b.label}`}
              >
                ✕
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Apply a saved user block to the edition by appending it as a fresh
 * top-level block. Mints fresh ids recursively so multiple inserts
 * don't collide.
 */
function applyUserBlockToEdition(
  edition: NewsletterEdition,
  block: UserBlock,
  registry: EmailBlockRegistry,
): NewsletterEdition {
  const reg = registry.get(block.tree.type);
  if (!reg) return edition;
  const stamped = stampFreshIds(block.tree);
  const editionBlock: EditionBlock = {
    id: freshUuid(),
    block_template: {
      id: '',
      name: reg.label,
      block_type: reg.componentId,
      content: { html_template: '', schema: {}, has_bricks: false },
    },
    content: stripStructural(stamped.props),
    sort_order: (edition.blocks.length + 1) * 1000,
    bricks: [],
  };
  return { ...edition, blocks: [...edition.blocks, editionBlock] };
}

function stampFreshIds(node: { type: string; props: Record<string, unknown> }): { type: string; props: Record<string, unknown> } {
  const props: Record<string, unknown> = { ...node.props, id: freshUuid() };
  if (Array.isArray(props.children)) {
    props.children = (props.children as Array<{ type: string; props: Record<string, unknown> }>).map((c) =>
      stampFreshIds(c),
    );
  }
  return { type: node.type, props };
}

function stripStructural(props: Record<string, unknown>): Record<string, unknown> {
  const { id, ...rest } = props;
  void id;
  return rest;
}

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
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
  padding: '14px 20px', borderBottom: '1px solid #f3f3f3', gap: 16,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 12px', border: '1px solid #d0d5dd',
  borderRadius: 6, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box',
};
const ghostBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #d0d5dd',
  background: '#fff', cursor: 'pointer', fontSize: 14,
};
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 6, border: '1px solid #14171E',
  background: '#14171E', color: '#fff', cursor: 'pointer', fontSize: 14,
};
