/**
 * Events relation provider — exposes `useUserRelation('event', id)` to
 * blocks + wrappers running under the sites SSR.
 *
 * Per spec-content-modules-git-architecture §12.5: each module owns the
 * relations it produces. Events owns: registered, attended, is_speaker.
 *
 * Wired from the events module's onEnable hook:
 *
 *   import { gatewazeRelationProvider } from '@gatewaze-modules/sites/lib/auth/user-relation';
 *   import { eventsRelationProvider } from './relation-provider';
 *   gatewazeRelationProvider('event', eventsRelationProvider({ supabase }));
 */

interface UserContext {
  id: string;
  email: string;
}

export interface EventsRelationDeps {
  supabase: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from(table: string): any;
  };
}

export type EventsRelationProvider = (args: { entityId: string; user: UserContext }) => Promise<{
  hasRelation: boolean;
  attributes: Record<string, unknown>;
}>;

export function eventsRelationProvider(deps: EventsRelationDeps): EventsRelationProvider {
  return async ({ entityId: eventId, user }) => {
    // Single-pass query: registration, attendance, speaker status
    const [regResult, attResult, speakerResult] = await Promise.all([
      deps.supabase
        .from('event_registrations')
        .select('id, registered_at, status')
        .eq('event_id', eventId).eq('person_email', user.email).maybeSingle(),
      deps.supabase
        .from('event_check_ins')
        .select('id, checked_in_at')
        .eq('event_id', eventId).eq('person_email', user.email).maybeSingle(),
      deps.supabase
        .from('event_speakers')
        .select('id, speaker_role')
        .eq('event_id', eventId).eq('person_email', user.email).maybeSingle(),
    ]);

    const reg = regResult.data as { id: string; registered_at: string; status: string } | null;
    const att = attResult.data as { id: string; checked_in_at: string } | null;
    const speaker = speakerResult.data as { id: string; speaker_role: string } | null;

    return {
      hasRelation: Boolean(reg ?? att ?? speaker),
      attributes: {
        registered: Boolean(reg),
        registeredAt: reg?.registered_at ?? null,
        registrationStatus: reg?.status ?? null,
        attended: Boolean(att),
        attendedAt: att?.checked_in_at ?? null,
        is_speaker: Boolean(speaker),
        speakerRole: speaker?.speaker_role ?? null,
      },
    };
  };
}
