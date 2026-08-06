/** Shared shapes for the speaker promo-kit pipeline. */

export type PromoKitStatus = 'requested' | 'generating' | 'ready' | 'failed';
export type PromoTextStatus = 'pending' | 'ready' | 'failed';

export interface PromoTextOption {
  key: 'professional' | 'energetic' | 'technical' | 'community';
  label: string;
  body: string;
}

export interface PromoText {
  options: PromoTextOption[];
  mention_note?: string;
}

export interface PromoCard {
  format: 'square' | 'story' | 'landscape';
  storage_path: string;
  width: number;
  height: number;
}

export interface PromoKitRow {
  id: string;
  talk_id: string;
  event_uuid: string | null;
  speaker_profile_id: string | null;
  status: PromoKitStatus;
  attempts: number;
  error: string | null;
  tracking_slug: string | null;
  tracking_short_url: string | null;
  tracking_destination_url: string | null;
  tracking_redirect_id: string | null;
  ai_run_id: string | null;
  promo_text: PromoText | null;
  promo_text_status: PromoTextStatus;
  promo_text_error: string | null;
  cards: PromoCard[] | null;
  zip_storage_path: string | null;
  template_version: string | null;
  generated_at: string | null;
}

/** Context resolved once per kit from the talk/speaker/event rows. */
export interface PromoKitContext {
  talk: {
    id: string;
    title: string;
    synopsis: string | null;
    status: string;
    session_type: string | null;
    duration_minutes: number | null;
    edit_token: string | null;
  };
  event: {
    id: string;
    event_id: string;
    event_slug: string | null;
    event_title: string;
    event_type?: string | null;
    event_start: string;
    event_timezone: string | null;
    event_city: string | null;
    event_link: string | null;
    enable_native_registration: boolean | null;
  };
  speaker: {
    profileId: string;
    fullName: string;
    jobTitle: string | null;
    company: string | null;
    bio: string | null;
    avatarUrl: string | null;
  };
  otherSpeakers: Array<{ name: string; talk_title: string }>;
}
