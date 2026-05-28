import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import type { BotDetectorModule } from './bot-detector.ts';

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

  // Check if the detector sub-module is installed and enabled. The
  // host's registry table is `installed_modules` (id, status, features,
  // portal_nav). See note in provider-registry.ts — `module_status` /
  // `'active'` were never correct.
  const { data: mod } = await supabase
    .from('installed_modules')
    .select('id, status')
    .eq('id', `email-bot-detector-${detectorName}`)
    .eq('status', 'enabled')
    .maybeSingle();

  if (!mod) {
    cachedDetector = null;
    return null;
  }

  try {
    // The deploy step copies `detector.ts` from the module into
    // `_shared/detectors/<name>.ts` per the module's `functionFiles`
    // entry (see provider-registry.ts for the same convention).
    // NOTE (2026-05-10): email-bot-detector-signals does not yet
    // declare a `functionFiles` mapping, so this import will fail
    // until that module is updated — caught below, detector
    // returns null, and we fall back to no detection.
    const detector = await import(`./detectors/${detectorName}.ts`);
    cachedDetector = detector.default as BotDetectorModule;
    return cachedDetector;
  } catch {
    console.warn(`[bulk-emailing] Bot detector "${detectorName}" failed to load, falling back to no detection`);
    cachedDetector = null;
    return null;
  }
}
