/**
 * Starts the Google Sheets OAuth flow.
 *
 * The edge function builds the Google consent URL, because only the server
 * can sign the OAuth state, and it does so only after checking that the
 * signed-in admin can manage this event. So this is an authenticated POST
 * that returns the URL, and the caller then navigates to it.
 *
 * Like the other edge-function calls in this module it goes to
 * VITE_SUPABASE_URL, which in host-session mode is the admin origin that
 * forwards the session. The redirect URI inside the returned URL is built on
 * the server from its own public Supabase URL.
 *
 * This lives in its own file and the tab imports it by relative path. The tab
 * reaches googleSheetsService through the `@/utils/googleSheetsService` alias,
 * and an admin that ships its own copy of that file takes precedence, so a
 * function added there would not reach the tab on those installs.
 */

import { supabase } from '@/lib/supabase';

const GOOGLE_CONSENT_PREFIX = 'https://accounts.google.com/';

export type GoogleSheetsOAuthNotificationType = 'registration' | 'speaker_submission';

/**
 * returnUrl should be a path on the admin, such as the current pathname plus
 * search. The server sends anything else back to "/".
 */
export async function startGoogleSheetsOAuth(
  eventId: string,
  notificationType: GoogleSheetsOAuthNotificationType,
  returnUrl: string,
): Promise<{ url?: string; error?: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/integrations-google-sheets-oauth/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
      },
      body: JSON.stringify({ eventId, notificationType, returnUrl }),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || typeof result.authorize_url !== 'string') {
      return { error: result.error || 'Failed to start Google authorization' };
    }

    // The browser is about to navigate there, so accept only Google's
    // consent screen, whatever the response says.
    if (!result.authorize_url.startsWith(GOOGLE_CONSENT_PREFIX)) {
      return { error: 'Unexpected authorization URL' };
    }

    return { url: result.authorize_url };
  } catch (error) {
    console.error('Error starting Google authorization:', error);
    return { error: 'Network error starting Google authorization' };
  }
}
