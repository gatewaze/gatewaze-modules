import type { SupabaseClient } from '@supabase/supabase-js';
import type { BotDetectorModule } from '../types/bot-detector.ts';

let cachedDetector: BotDetectorModule | null | undefined = undefined;

/**
 * Get the active bot detector sub-module, or null if none is installed.
 * The bot detector is optional — if not installed, all interactions
 * default to human_confidence = 1.0.
 */
export async function getBotDetector(
  supabase: SupabaseClient
): Promise<BotDetectorModule | null> {
  if (cachedDetector !== undefined) return cachedDetector;

  const detectorName = Deno.env.get('EMAIL_BOT_DETECTOR') || 'signals';

  // Check if the detector sub-module is installed and active
  const { data: mod } = await supabase
    .from('module_status')
    .select('module_id, status')
    .eq('module_id', `email-bot-detector-${detectorName}`)
    .eq('status', 'active')
    .single();

  if (!mod) {
    cachedDetector = null;
    return null;
  }

  try {
    const detector = await import(
      `../../email-bot-detector-${detectorName}/detector.ts`
    );
    cachedDetector = detector.default as BotDetectorModule;
    return cachedDetector;
  } catch {
    console.warn(`[bulk-emailing] Bot detector "${detectorName}" failed to load, falling back to no detection`);
    cachedDetector = null;
    return null;
  }
}
