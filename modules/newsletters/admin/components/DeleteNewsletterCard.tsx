/**
 * Danger Zone — newsletter delete with confirmation. Per
 * spec-builder-evaluation §3.6 (extended). Mounted at the bottom of
 * the Details tab on the newsletter detail page.
 *
 * Two-step UX: a clearly-styled red "Delete newsletter" button opens
 * a modal that requires the operator to type the newsletter's name
 * exactly to enable the final confirm. The server endpoint also
 * verifies the typed name matches before performing the cascade
 * delete — UI confirmation is convenience; the server check is the
 * trust boundary.
 */

import { useState, type FC } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { useNavigate } from 'react-router';
import { Card, Button, Modal } from '@/components/ui';
import { supabase } from '@/lib/supabase';

export interface DeleteNewsletterCardProps {
  newsletterId: string;
  newsletterName: string;
}

export const DeleteNewsletterCard: FC<DeleteNewsletterCardProps> = ({ newsletterId, newsletterName }) => {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      // VITE_API_URL is required in production: admin nginx doesn't proxy
      // /api requests (it serves a static SPA), so a bare relative fetch
      // hits nginx and gets a 405 for DELETE/POST. The api lives at
      // VITE_API_URL (e.g. https://api.aaif.live) which has full CORS
      // + method support.
      const apiUrl = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${apiUrl}/api/admin/newsletters/collections/${newsletterId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ confirm_name: confirmName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        toast.error(body?.error?.message ?? `Delete failed (${res.status})`);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { kind: 'deleted'; editionsRemoved: number; librariesRemoved: number }
        | null;
      const detail = body?.kind === 'deleted'
        ? `Removed ${body.editionsRemoved} edition${body.editionsRemoved === 1 ? '' : 's'}.`
        : '';
      toast.success(`Deleted "${newsletterName}". ${detail}`.trim());
      setOpen(false);
      navigate('/newsletters');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  const matches = confirmName.trim() === newsletterName;

  return (
    <>
      <Card>
        <div className="p-5 space-y-3">
          <div className="flex items-start gap-3">
            <ExclamationTriangleIcon className="w-5 h-5 text-[var(--red-9)] flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">Danger zone</h3>
              <p className="text-sm text-[var(--gray-9)] mt-1">
                Permanently deletes this newsletter, all its editions, the per-newsletter
                templates library, and soft-deletes the internal git repo (7-day grace period
                before purge). This cannot be undone from the UI.
              </p>
            </div>
          </div>
          <div>
            <Button
              variant="solid"
              color="red"
              onClick={() => {
                setConfirmName('');
                setOpen(true);
              }}
            >
              Delete newsletter
            </Button>
          </div>
        </div>
      </Card>

      <Modal
        isOpen={open}
        onClose={() => (deleting ? null : setOpen(false))}
        title={`Delete "${newsletterName}"?`}
        width="md"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 rounded-md bg-[var(--red-a3)] border border-[var(--red-a6)]">
            <ExclamationTriangleIcon className="w-5 h-5 text-[var(--red-11)] flex-shrink-0 mt-0.5" />
            <div className="text-sm text-[var(--red-12)]">
              This will permanently remove every edition, every block, the templates library,
              and the channel itself. The internal git repo is soft-deleted with a 7-day grace.
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
              Type <code className="font-mono px-1 py-0.5 rounded bg-[var(--gray-a3)]">{newsletterName}</code> to confirm:
            </label>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={newsletterName}
              autoFocus
              disabled={deleting}
              className="w-full px-3 py-2 rounded-md border border-[var(--gray-a5)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-a8)] text-sm"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="red"
              disabled={!matches || deleting}
              onClick={handleDelete}
            >
              {deleting ? 'Deleting…' : 'Delete permanently'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
};

export default DeleteNewsletterCard;
