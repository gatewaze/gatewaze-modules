// @ts-nocheck
/**
 * Pending approvals, surfaced on the OVERVIEW dashboard — the page operators actually watch.
 * (The same review panel lives in Setup, but approvals shouldn't require a trip into settings.)
 *
 * Shows a full MemoryReviewSection for each project that has something awaiting a human:
 * a pending reflect proposal and/or pending specs from runs that never merged. Renders
 * NOTHING when there is nothing to review, so the dashboard stays clean in the common case.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import MemoryReviewSection from './MemoryReviewSection';
import { ProjectAvatar } from './ProjectAvatar';

// Absolute API base on deployed admins (nginx serves the SPA only — no /api proxy); '' locally → Vite proxy.
const API = `${(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_API_URL ?? ''}/api/modules/software-engineer/admin`;

async function api(path: string) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const r = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

export default function PendingApprovals({ projects }: { projects: Array<{ id: string; name: string; avatar_emoji?: string }> }) {
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const scan = useCallback(async () => {
    const ids: string[] = [];
    for (const p of projects ?? []) {
      try {
        const d = await api(`/projects/${p.id}/memory`);
        if (d?.hasPending || (d?.pending_specs ?? []).length > 0) ids.push(p.id);
      } catch { /* project unreadable → skip; Setup still lists it */ }
    }
    setPendingIds(ids);
  }, [projects]);

  useEffect(() => { scan(); }, [scan]);

  if (pendingIds.length === 0) return null;
  return (
    <div className="space-y-3">
      {pendingIds.map((id) => {
        const p = (projects ?? []).find((x) => x.id === id);
        return (
          <div key={id} className="space-y-1">
            {(projects ?? []).length > 1 && (
              <div className="text-xs font-medium text-[var(--gray-11)] flex items-center gap-1"><ProjectAvatar emoji={p?.avatar_emoji} className="size-3.5" /> {p?.name ?? id}</div>
            )}
            <MemoryReviewSection projectId={id} onChanged={scan} />
          </div>
        );
      })}
    </div>
  );
}
