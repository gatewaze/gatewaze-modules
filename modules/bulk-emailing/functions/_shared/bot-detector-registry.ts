import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import type { BotDetectorModule } from './bot-detector.ts';
// Static import of every detector this registry knows about. Dynamic-template
// imports (`import(\`./detectors/${name}.ts\`)`) silently fail to resolve
// inside the Supabase Edge eszip even when the file is bundled — the
// runtime returns a rejected promise that the registry's catch swallowed,
// leaving every send unscored on AAIF prod 2026-06-23 (27,985 email_
// interactions, 0 scored). Static imports unambiguously land in the bundle
// and are evaluated at module load. To add a new detector module:
//   1. Add `functionFiles: ['detector.ts:detectors/<name>.ts']` to its
//      index.ts (so `pnpm modules:deploy-functions` copies it into the
//      bundle).
//   2. Add a `import signalsDetector from './detectors/<name>.ts';` line here.
//   3. Wire it into the `byName` map below.
// Three lines per detector is cheaper than chasing silent runtime failures.
import signalsDetector from './detectors/signals.ts';

const byName: Record<string, BotDetectorModule> = {
  signals: signalsDetector as BotDetectorModule,
};

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

  // 2026-06-23 isolation: bypass the installed_modules gate. The detector is
  // statically imported below so always available; the gate adds zero security
  // (service-role bypasses RLS) and was the suspected silent-fail point on
  // AAIF prod (0/27,985 scored). Re-add the gate later if we need brand-level
  // multi-tenancy on detection.
  console.log(`[bulk-emailing] getBotDetector resolving "${detectorName}"`);

  const detector = byName[detectorName];
  if (!detector) {
    console.warn(`[bulk-emailing] Bot detector "${detectorName}" enabled in installed_modules but no static import in bot-detector-registry — add it. Skipping scoring.`);
    cachedDetector = null;
    return null;
  }
  cachedDetector = detector;
  return cachedDetector;
}
