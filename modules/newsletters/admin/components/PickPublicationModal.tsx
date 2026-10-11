import { useState } from 'react';
import { ArrowRightIcon } from '@heroicons/react/24/outline';
import { Modal, Button, Badge } from '@/components/ui';

export interface PickablePublication {
  id: string;
  name: string;
  slug: string;
  content_category: string | null;
  accent_color: string | null;
  edition_count: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  publications: PickablePublication[];
  onPick: (pub: PickablePublication) => void;
}

/**
 * "Create edition" needs to know which publication the edition belongs to.
 * Lists the publications; picking one hands it back to the caller, which
 * navigates to that publication's new-edition editor.
 */
export function PickPublicationModal({ isOpen, onClose, publications, onPick }: Props) {
  const [selected, setSelected] = useState<string | null>(publications[0]?.id ?? null);
  const chosen = publications.find((p) => p.id === selected) ?? null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create edition"
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outlined" onClick={onClose}>Cancel</Button>
          <Button variant="solid" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>
            Continue <ArrowRightIcon className="size-4 ml-1" />
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-[var(--gray-11)]">Which publication is this edition for?</p>
      <ul className="flex flex-col gap-1">
        {publications.map((p) => {
          const active = p.id === selected;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setSelected(p.id)}
                onDoubleClick={() => onPick(p)}
                className={`relative w-full overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-[var(--accent-8)] bg-[var(--accent-a2)]'
                    : 'border-[var(--gray-a4)] hover:bg-[var(--gray-a3)]'
                }`}
              >
                <span className="absolute inset-y-0 left-0 w-1" style={{ background: p.accent_color || 'var(--accent-9)' }} aria-hidden="true" />
                <div className="pl-2 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--gray-12)]">{p.name}</span>
                    {p.content_category && <Badge variant="soft" color="blue" size="1">{p.content_category}</Badge>}
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-[var(--gray-10)]">{p.edition_count} edition{p.edition_count === 1 ? '' : 's'}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

export default PickPublicationModal;
