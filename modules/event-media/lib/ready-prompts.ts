/**
 * Getting ready: the morning before.
 *
 * Photographs of the day itself look after themselves -- something is
 * happening, everyone has a camera out. The morning before is different:
 * people are at home, in bits, and nobody thinks to open an app and
 * upload a picture of their own hair half done. Asked for a section of
 * its own (2026-09-22), and the thing that makes people take a photo is
 * being asked for a particular one.
 *
 * So the morning is a list of small asks. Each opens the camera at the
 * right one -- the front camera for a face, the back one for shoes -- and
 * the picture lands in the Getting ready album with the ask recorded
 * against it, so the projector can caption it later.
 *
 * The asks are deliberately easy. Nothing here requires anyone to look
 * good, be dressed, or be with other people: the point is that a guest
 * on their own with wet hair still has three they can do.
 */

export interface ReadyPrompt {
  id: string;
  /** On the button. Two or three words. */
  label: string;
  /** Under it, the actual ask. */
  blurb: string;
  /** Which camera this wants: a face, or the thing being photographed. */
  camera: 'user' | 'environment';
}

export const READY_PROMPTS: readonly ReadyPrompt[] = [
  { id: 'outfit', label: 'The outfit', blurb: 'Hanging up, before you get into it.', camera: 'environment' },
  { id: 'shoes', label: 'The shoes', blurb: 'Go on, show us the shoes.', camera: 'environment' },
  { id: 'mirror', label: 'Mirror check', blurb: 'The obligatory mirror selfie.', camera: 'user' },
  { id: 'first-drink', label: 'First drink', blurb: 'Whatever you have started on.', camera: 'environment' },
  { id: 'chaos', label: 'The chaos', blurb: 'The room, exactly as it is right now.', camera: 'environment' },
  { id: 'hair', label: 'Hair and face', blurb: 'Mid-way through. No filters.', camera: 'user' },
  { id: 'crew', label: 'Who you are with', blurb: 'Whoever is in the room with you.', camera: 'user' },
  { id: 'travel', label: 'On the way', blurb: 'The car, the train, the walk in.', camera: 'environment' },
  { id: 'view', label: 'Your view', blurb: 'Out of the window, wherever you are.', camera: 'environment' },
  { id: 'nearly', label: 'Nearly there', blurb: 'Dressed, ready, about to leave.', camera: 'user' },
];

const BY_ID = new Map(READY_PROMPTS.map((p) => [p.id, p]));

export function readyPrompt(id: unknown): ReadyPrompt | null {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null;
}

/**
 * Is the morning on? From a day before the event until it starts.
 *
 * A day, not a morning: guests travelling the night before are already
 * getting ready as far as anyone is concerned. With no start time there
 * is no morning -- the app stays as it is.
 */
export const READY_OPENS_MS = 36 * 60 * 60 * 1000;

export function readyWindow(
  eventStart: string | null | undefined,
  now: number,
  /** Hours before the event it opens; 0 turns it off. */
  hours?: number | null,
): {
  active: boolean;
  starts_at: string | null;
  /** Milliseconds until the event; null when there is no start time. */
  until: number | null;
} {
  const start = eventStart ? Date.parse(eventStart) : NaN;
  if (!Number.isFinite(start)) return { active: false, starts_at: null, until: null };
  const window = Number.isFinite(hours) && hours !== null && hours !== undefined
    ? Math.max(0, Math.min(336, hours)) * 60 * 60 * 1000
    : READY_OPENS_MS;
  const until = start - now;
  return {
    active: window > 0 && until > 0 && until <= window,
    starts_at: new Date(start).toISOString(),
    until,
  };
}
