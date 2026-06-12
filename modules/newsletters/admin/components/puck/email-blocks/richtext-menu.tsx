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

import { useRef, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { LinkIcon, PhotoIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { uploadHostMedia } from '@gatewaze-modules/host-media/admin';
import { useNewsletterEditing } from '../NewsletterEditingContext.js';

interface MenuProps {
  children: ReactNode;
  editor: Editor | null;
  readOnly: boolean;
}

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

export function RichtextMenu({ children, editor, readOnly }: MenuProps): ReactNode {
  const fileRef = useRef<HTMLInputElement>(null);
  const { collectionId } = useNewsletterEditing();

  if (!editor || readOnly) return children;

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
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={onPickImage}
      />
    </div>
  );
}
