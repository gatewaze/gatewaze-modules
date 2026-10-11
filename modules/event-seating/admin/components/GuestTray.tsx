import { useMemo, useState } from 'react';
import { MagnifyingGlassIcon, UserPlusIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui';
import type { Guest } from '../utils/seatingService';

/**
 * The unseated list. Guests stay grouped by their invite party so households
 * are easy to seat together, and dragging one out starts a guest drag that the
 * canvas finishes.
 */

interface Props {
  guests: Guest[];
  seatedMemberIds: Set<string>;
  onStartDrag: (guest: Guest, clientX: number, clientY: number) => void;
  onAddCustomGuest: (label: string) => void;
  activeMemberId: string | null;
}

export function GuestTray({
  guests,
  seatedMemberIds,
  onStartDrag,
  onAddCustomGuest,
  activeMemberId,
}: Props) {
  const [search, setSearch] = useState('');
  const [showSeated, setShowSeated] = useState(false);
  const [customName, setCustomName] = useState('');

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const visible = guests.filter((g) => {
      if (!showSeated && seatedMemberIds.has(g.id)) return false;
      if (!term) return true;
      return (
        g.full_name.toLowerCase().includes(term) ||
        g.party_name.toLowerCase().includes(term)
      );
    });

    const byParty = new Map<string, { partyName: string; guests: Guest[] }>();
    for (const guest of visible) {
      if (!byParty.has(guest.party_id)) {
        byParty.set(guest.party_id, { partyName: guest.party_name, guests: [] });
      }
      byParty.get(guest.party_id)!.guests.push(guest);
    }
    return [...byParty.values()].sort((a, b) => a.partyName.localeCompare(b.partyName));
  }, [guests, search, showSeated, seatedMemberIds]);

  const unseatedCount = guests.filter((g) => !seatedMemberIds.has(g.id)).length;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Guests</h3>
        <span className="text-xs text-[var(--gray-9)]">
          {unseatedCount} to seat · {guests.length} total
        </span>
      </div>

      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--gray-9)]" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or party"
          className="w-full rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] py-1.5 pl-7 pr-2 text-sm text-[var(--gray-12)]"
        />
      </div>

      <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-[var(--gray-11)]">
        <input
          type="checkbox"
          checked={showSeated}
          onChange={(e) => setShowSeated(e.target.checked)}
          className="cursor-pointer"
        />
        Show guests already seated
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {groups.length === 0 ? (
          <p className="py-6 text-center text-xs text-[var(--gray-9)]">
            {guests.length === 0
              ? 'No guests have accepted for this event yet.'
              : 'Everyone matching is seated.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.partyName} className="mb-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--gray-9)]">
                {group.partyName}
              </div>
              <div className="space-y-1">
                {group.guests.map((guest) => {
                  const seated = seatedMemberIds.has(guest.id);
                  const isActive = activeMemberId === guest.id;
                  return (
                    <div
                      key={guest.id}
                      className={`flex items-center justify-between gap-1 rounded-md border px-2 py-1.5 text-xs ${
                        isActive
                          ? 'border-[var(--accent-8)] bg-[var(--accent-3)]'
                          : seated
                          ? 'border-[var(--gray-5)] bg-[var(--gray-2)] text-[var(--gray-9)]'
                          : 'border-[var(--gray-6)] bg-[var(--color-background)] text-[var(--gray-12)] hover:border-[var(--accent-8)]'
                      }`}
                      style={{ cursor: seated ? 'default' : 'grab', touchAction: 'none' }}
                      onPointerDown={(e) => {
                        if (seated) return;
                        e.preventDefault();
                        onStartDrag(guest, e.clientX, e.clientY);
                      }}
                    >
                      <span className="truncate">{guest.full_name}</span>
                      <span className="flex flex-shrink-0 items-center gap-1">
                        {guest.is_plus_one && (
                          <Badge color="gray" className="text-[9px]">+1</Badge>
                        )}
                        {guest.rsvp_status !== 'accepted' && (
                          <Badge color="amber" className="text-[9px]">{guest.rsvp_status}</Badge>
                        )}
                        {seated && <span className="text-[9px]">seated</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className="flex gap-1 border-t border-[var(--gray-6)] pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const name = customName.trim();
          if (!name) return;
          onAddCustomGuest(name);
          setCustomName('');
        }}
      >
        <input
          type="text"
          value={customName}
          onChange={(e) => setCustomName(e.target.value)}
          placeholder="Add someone not invited"
          maxLength={120}
          className="min-w-0 flex-1 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] px-2 py-1 text-xs text-[var(--gray-12)]"
        />
        <button
          type="submit"
          title="Pick up this name to place on a seat"
          className="flex-shrink-0 rounded-md border border-[var(--gray-6)] px-2 text-[var(--gray-11)] hover:border-[var(--accent-8)] hover:text-[var(--accent-11)]"
        >
          <UserPlusIcon className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}

export default GuestTray;
