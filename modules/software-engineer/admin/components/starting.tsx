/**
 * Shared "stack is restarting" detection + banner for the SE admin views.
 *
 * When the docker stack (or a deploy) recycles the api, every request briefly
 * 502s at the proxy — raw error banners make that look broken when it's just
 * booting. Components treat gateway errors as a transient "starting up" state,
 * render <StartingBanner/>, and poll until the API answers again.
 */
import React from 'react';

/** True for the errors a stack restart produces (nginx 502/504, api warming 503, or a dropped
 *  connection). These self-heal within seconds — show "starting up" + retry, not a raw error. */
export function isGatewayError(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  return e instanceof TypeError; // fetch network failure (connection refused/reset mid-restart)
}

/** Amber "the stack is coming up" banner. */
export function StartingBanner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
      <span className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" aria-hidden />
      {label}
    </div>
  );
}
