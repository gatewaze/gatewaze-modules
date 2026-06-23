/**
 * Custom toolbar for the newsletter richtext fields. Puck's default menu
 * ships heading / list / bold / italic / underline / align but deliberately
 * omits a link button (it needs a URL prompt) and has no image support. This
 * appends a Link button (prompt → setLink) and an Insert-image button (file
 * picker → upload to the Supabase `media` bucket → setImage) after Puck's
 * default `children`, and is used as both `renderMenu` (sidebar drawer) and
 * `renderInlineMenu` (in-canvas bubble).
 *
 * The Image tiptap extension is registered on the field's `tiptap.extensions`
 * in merge-into-config; without it `setImage` is a no-op.
 */

import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { CodeBracketIcon, LinkIcon, PhotoIcon, UserIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { uploadHostMedia } from '@gatewaze-modules/host-media/admin';
import { useNewsletterEditing } from '../NewsletterEditingContext.js';

interface MenuProps {
  children: ReactNode;
  editor: Editor | null;
  readOnly: boolean;
}

// Per-recipient merge fields the send path substitutes (newsletter-send edge
// fn). Inserted as `{{token}}`; an optional fallback can be typed in by hand
// as `{{first_name|there}}`. Missing values render as empty when no fallback.
const MERGE_FIELDS: Array<{ token: string; label: string }> = [
  { token: 'first_name', label: 'First name' },
  { token: 'last_name', label: 'Last name' },
  { token: 'name', label: 'Full name' },
  { token: 'company', label: 'Company' },
  { token: 'job_title', label: 'Job title' },
];

const BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  borderRadius: 4,
  padding: 0,
};

const ACTIVE_BG = 'rgba(64,134,198,0.18)';
const DIVIDER_STYLE: React.CSSProperties = {
  width: 1, alignSelf: 'stretch', background: 'currentColor', opacity: 0.18, margin: '2px 4px',
};

/** Tiny align glyph: a framed image box positioned left / centre / right. */
function AlignIcon({ dir }: { dir: 'left' | 'center' | 'right' }): ReactNode {
  const x = dir === 'left' ? 1.5 : dir === 'right' ? 7.5 : 4.5;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <line x1="1" y1="2" x2="15" y2="2" />
      <rect x={x} y="4.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
      <line x1="1" y1="14" x2="15" y2="14" />
    </svg>
  );
}

export function RichtextMenu({ children, editor, readOnly }: MenuProps): ReactNode {
  const fileRef = useRef<HTMLInputElement>(null);
  const { collectionId } = useNewsletterEditing();
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [htmlValue, setHtmlValue] = useState<string | null>(null); // non-null = source view open

  if (!editor || readOnly) return children;

  const openHtml = () => setHtmlValue(editor.getHTML());
  const applyHtml = () => {
    if (htmlValue === null) return;
    const next = htmlValue;
    setHtmlValue(null);
    // Re-parse the edited HTML into the doc. Same Puck focus/onUpdate gotcha as
    // image insert: the field's onUpdate bails when not focused, so focus first
    // then defer a tick. emitUpdate:true so Puck persists the change. Note:
    // tiptap re-parses through its schema, so tags/attrs it doesn't model are
    // normalised away on save.
    editor.commands.focus();
    const run = () =>
      (editor.chain().focus() as unknown as {
        setContent: (c: string, o: { emitUpdate: boolean }) => { run: () => void };
      })
        .setContent(next, { emitUpdate: true })
        .run();
    requestAnimationFrame(() => requestAnimationFrame(run));
  };

  const insertField = (token: string) => {
    editor.chain().focus().insertContent(`{{${token}}}`).run();
    setFieldsOpen(false);
  };

  const applyLink = () => {
    const current = (editor.getAttributes('link').href as string | undefined) ?? 'https://';
    const url = window.prompt('Link URL (leave blank to remove)', current);
    if (url === null) return; // cancelled
    const chain = editor.chain().focus().extendMarkRange('link');
    if (url.trim() === '') {
      chain.unsetLink().run();
    } else {
      chain.setLink({ href: url.trim() }).run();
    }
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!collectionId) {
      toast.error('Save the edition before uploading an image.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(`"${file.name}" isn't an image.`);
      return;
    }
    try {
      // Use the same host-media path as the block image fields so the
      // stored value is a full, persistent CDN URL (not a relative storage
      // path, which renders broken in-canvas and after reload).
      const res = await uploadHostMedia('newsletter', collectionId, [file]);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `upload failed (${res.status})`);
      }
      const body = (await res.json()) as {
        items?: Array<{ status: string; cdn_url?: string; error?: string }>;
      };
      const item = body.items?.[0];
      if (!item || item.status !== 'created' || !item.cdn_url) {
        throw new Error(item?.error ?? 'upload returned no URL');
      }
      const src = item.cdn_url;
      // The async upload blurred the editor. Puck's richtext sync only
      // persists a change while the field reads as focused (its onUpdate
      // bails with `if (!isFocused) return`), so inserting immediately after
      // an await drops the change silently — the image shows but never saves.
      // Re-focus first, then defer the insert a tick so Puck's focus state
      // (and tiptap's re-bound onUpdate) catch up before the doc changes.
      editor.commands.focus();
      const insertImage = () =>
        (editor.chain().focus() as unknown as { setImage: (a: { src: string }) => { run: () => void } })
          .setImage({ src })
          .run();
      // Two animation frames: one for React to commit the focus-driven
      // re-render, one for tiptap to re-bind onUpdate with isFocused=true.
      requestAnimationFrame(() => requestAnimationFrame(insertImage));
      toast.success('Image uploaded.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Image upload failed');
    }
  };

  // renderMenu's return is NOT wrapped in Puck's flex `_RichTextMenu_`
  // container, so without an explicit flex row the default button groups
  // (passed in as `children`) stack vertically and overlap the content.
  // Re-establish a single wrapping toolbar row here.
  return (
    <>
    <div
      // Keep focus (and the text selection) in the editor when a toolbar
      // button is pressed. Without this, mousedown moves focus out of the
      // contentEditable, the selection collapses, and B/I/U/link/image act on
      // nothing. preventDefault on mousedown stops the focus shift; the
      // buttons' onClick still fires. Covers Puck's default buttons (children)
      // and our own. mouseDownCapture so it runs before the children's own
      // handlers.
      onMouseDownCapture={(e) => e.preventDefault()}
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 2,
        width: '100%',
        // Solid background so the floating inline toolbar doesn't let
        // editor content (e.g. a full-bleed image) bleed through behind it.
        background: '#ffffff',
        // Dark icon/text colour: the inline toolbar lives inside Puck's dark
        // overlay, whose `color` is near-white. On our white panel the default
        // B/I/U buttons (color: inherit) and our own icons would be invisible
        // without overriding it here.
        color: '#1f2937',
        borderRadius: 4,
        padding: '2px 4px',
      }}
    >
      {children}
      <span
        aria-hidden
        style={{ width: 1, alignSelf: 'stretch', background: 'currentColor', opacity: 0.18, margin: '2px 4px' }}
      />
      <button
        type="button"
        onClick={applyLink}
        title="Add / edit link"
        aria-label="Add or edit link"
        style={{
          ...BTN_STYLE,
          background: editor.isActive('link') ? 'rgba(64,134,198,0.18)' : 'transparent',
        }}
      >
        <LinkIcon style={{ width: 16, height: 16 }} />
      </button>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title="Insert image"
        aria-label="Insert image"
        style={BTN_STYLE}
      >
        <PhotoIcon style={{ width: 16, height: 16 }} />
      </button>
      <button
        type="button"
        onClick={openHtml}
        title="View / edit HTML"
        aria-label="View or edit HTML source"
        style={{ ...BTN_STYLE, background: htmlValue !== null ? ACTIVE_BG : 'transparent' }}
      >
        <CodeBracketIcon style={{ width: 16, height: 16 }} />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={onPickImage}
      />
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          onClick={() => setFieldsOpen((o) => !o)}
          title="Insert personalisation field"
          aria-label="Insert personalisation field"
          style={{ ...BTN_STYLE, background: fieldsOpen ? 'rgba(64,134,198,0.18)' : 'transparent' }}
        >
          <UserIcon style={{ width: 16, height: 16 }} />
        </button>
        {fieldsOpen && (
          <div
            style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50,
              minWidth: 190, background: '#ffffff', color: '#1f2937',
              border: '1px solid #e5e7eb', borderRadius: 6,
              boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 4,
            }}
          >
            {MERGE_FIELDS.map((f) => (
              <button
                key={f.token}
                type="button"
                onClick={() => insertField(f.token)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', border: 'none',
                  background: 'transparent', cursor: 'pointer', borderRadius: 4,
                  padding: '6px 8px', fontSize: 13, color: 'inherit',
                }}
              >
                {f.label} <span style={{ color: '#9ca3af', fontSize: 11 }}>{`{{${f.token}}}`}</span>
              </button>
            ))}
            <div style={{ borderTop: '1px solid #f0f0f0', margin: '4px 0' }} />
            <div style={{ padding: '4px 8px', fontSize: 11, color: '#9ca3af', lineHeight: 1.4 }}>
              Optional fallback if blank:<br />
              <code>{'{{first_name|"there"}}'}</code>
            </div>
          </div>
        )}
      </span>
      {editor.isActive('image') && (
        <ImageControls editor={editor} />
      )}
    </div>
    {htmlValue !== null &&
      createPortal(
        <HtmlSourceModal
          value={htmlValue}
          onChange={setHtmlValue}
          onCancel={() => setHtmlValue(null)}
          onSave={applyHtml}
        />,
        document.body,
      )}
    </>
  );
}

/**
 * Full-screen modal to view / edit the field's raw HTML. Rendered via a portal
 * to document.body so it sits outside the toolbar's onMouseDownCapture
 * preventDefault (which would otherwise stop the textarea from receiving focus).
 */
function HtmlSourceModal({
  value, onChange, onCancel, onSave,
}: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: () => void;
}): ReactNode {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit HTML source"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(17,24,39,0.55)', padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(900px, 100%)', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
          background: '#ffffff', color: '#1f2937', borderRadius: 8,
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
          <strong style={{ fontSize: 14 }}>Edit HTML</strong>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>Saving re-parses the markup; unsupported tags are normalised.</span>
        </div>
        <textarea
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1, minHeight: 360, resize: 'vertical', border: 'none', outline: 'none',
            padding: '12px 16px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13, lineHeight: 1.5, color: '#1f2937', background: '#fbfbfd',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #e5e7eb' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#4086c6', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Alignment + width controls shown only while an image node is selected.
 * Buttons (not a <select>) because the toolbar's onMouseDownCapture
 * preventDefault — needed to keep the text selection — would stop a native
 * select from opening. Sets data-align / data-width on the image node; the
 * email-safe styling is derived from them in normalizeRichText at render time.
 */
function ImageControls({ editor }: { editor: Editor }): ReactNode {
  const attrs = editor.getAttributes('image');
  const align = (attrs.dataAlign as string | null) ?? null;
  const width = (attrs.dataWidth as string | null) ?? null;
  const set = (next: Record<string, unknown>) =>
    editor.chain().focus().updateAttributes('image', next).run();

  return (
    <>
      <span aria-hidden style={DIVIDER_STYLE} />
      {(['left', 'center', 'right'] as const).map((d) => (
        <button
          key={d}
          type="button"
          title={`Align image ${d}`}
          aria-label={`Align image ${d}`}
          aria-pressed={align === d}
          onClick={() => set({ dataAlign: align === d ? null : d })}
          style={{ ...BTN_STYLE, background: align === d ? ACTIVE_BG : 'transparent' }}
        >
          <AlignIcon dir={d} />
        </button>
      ))}
      <span aria-hidden style={DIVIDER_STYLE} />
      {(['25', '50', '75', '100'] as const).map((w) => (
        <button
          key={w}
          type="button"
          title={`Image width ${w}%`}
          aria-label={`Image width ${w} percent`}
          aria-pressed={width === w}
          onClick={() => set({ dataWidth: width === w ? null : w })}
          style={{
            ...BTN_STYLE,
            width: 'auto',
            minWidth: 28,
            padding: '0 4px',
            fontSize: 11,
            fontWeight: 600,
            background: width === w ? ACTIVE_BG : 'transparent',
          }}
        >
          {w}%
        </button>
      ))}
    </>
  );
}
