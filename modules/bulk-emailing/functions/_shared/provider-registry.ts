import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import type { EmailProviderModule } from './email-provider.ts';

let cachedProvider: EmailProviderModule | null = null;

/**
 * Get the active email provider sub-module.
 * Looks up the installed provider module based on EMAIL_PROVIDER env var.
 * Caches the provider instance for the lifetime of the edge function invocation.
 */
export async function getEmailProvider(
  supabase: SupabaseClient
): Promise<EmailProviderModule> {
  if (cachedProvider) return cachedProvider;

  const providerName = Deno.env.get('EMAIL_PROVIDER') || 'sendgrid';

  // Check the provider sub-module is installed and enabled. The
  // host's module registry table is `installed_modules` (id, status,
  // features, portal_nav). Status `'enabled'` is the active state —
  // earlier drafts of this file referenced a `module_status` table
  // with a `'active'` status that doesn't exist on the host.
  const { data: mod } = await supabase
    .from('installed_modules')
    .select('id, status')
    .eq('id', `email-provider-${providerName}`)
    .eq('status', 'enabled')
    .maybeSingle();

  if (!mod) {
    throw new Error(
      `Email provider "${providerName}" is not installed or not active. ` +
      `Install the email-provider-${providerName} module.`
    );
  }

  // Dynamic import of the provider module. The deploy step (see
  // packages/shared/src/modules/deploy-edge-functions.ts) copies the
  // module's `provider.ts` into `_shared/providers/<name>.ts` per
  // the module's `functionFiles: ['provider.ts:<name>.ts']` entry —
  // each Supabase edge function only bundles its own directory plus
  // `_shared/`, so sibling function directories (which the previous
  // `../../email-provider-<name>/provider.ts` path assumed) are
  // never visible at runtime.
  const provider = await import(`./providers/${providerName}.ts`);
  cachedProvider = provider.default as EmailProviderModule;
  return cachedProvider;
}

/**
 * Get the provider name from environment config.
 */
export function getProviderName(): string {
  return Deno.env.get('EMAIL_PROVIDER') || 'sendgrid';
}
