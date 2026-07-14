/**
 * Concurrent-edit awareness for a newsletter edition. Joins a Supabase realtime
 * presence channel keyed by the edition id and returns the OTHER operators
 * currently in the same edition, so the editor can surface "X is also editing".
 *
 * Presence is ephemeral (in the realtime server) — no DB table or migration.
 * This is the awareness half of concurrent-edit safety; the enforcement half is
 * the optimistic version lock in newsletters_save_edition (a stale save is
 * rejected regardless of whether the banner was seen).
 */
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface PresencePeer {
  id: string;
  name: string;
  joinedAt: string;
}

export function useEditionPresence(editionId: string | null | undefined): PresencePeer[] {
  const [peers, setPeers] = useState<PresencePeer[]>([]);

  useEffect(() => {
    if (!editionId || editionId === 'new') {
      setPeers([]);
      return;
    }
    // Unique per tab, so we can exclude ourselves from the peer list.
    const selfKey =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `self-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    let cancelled = false;

    const channel = supabase.channel(`edition-presence:${editionId}`, {
      config: { presence: { key: selfKey } },
    });

    const collect = () => {
      const state = channel.presenceState() as Record<
        string,
        Array<{ id?: string; name?: string; joinedAt?: string }>
      >;
      const others: PresencePeer[] = [];
      for (const [key, metas] of Object.entries(state)) {
        if (key === selfKey) continue;
        const m = metas?.[0];
        if (m) others.push({ id: m.id ?? key, name: m.name ?? 'A teammate', joinedAt: m.joinedAt ?? '' });
      }
      if (!cancelled) setPeers(others);
    };

    channel.on('presence', { event: 'sync' }, collect);
    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      void supabase.auth.getUser().then(({ data }) => {
        void channel.track({
          id: data.user?.id ?? selfKey,
          name: data.user?.email ?? 'A teammate',
          joinedAt: new Date().toISOString(),
        });
      });
    });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [editionId]);

  return peers;
}
