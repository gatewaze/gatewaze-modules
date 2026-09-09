import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import type { EmailProviderModule } from './email-provider.ts';
// Static import of every provider this registry knows about. A dynamic
// template-literal import (`import(`./providers/${name}.ts`)`) silently fails to
// resolve inside the Supabase Edge eszip bundle even when the deploy step copies
// the file into _shared/providers/ — the CLI's import follower only sees literal
// paths, so the provider ships missing and the function 503s "Module not found:
// providers/sendgrid.ts" at first call (hit 2026-06-05, and again 2026-09-04
// after a manual CLI redeploy). Static imports unambiguously land in the bundle.
// To add a provider: add its functionFiles entry, then a static import + a
// byName line here (mirrors _shared/bot-detector-registry.ts).
import sendgridProvider from './providers/sendgrid.ts';

const PROVIDERS_BY_NAME: Record<string, EmailProviderModule> = {
  sendgrid: sendgridProvider as EmailProviderModule,
};

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

  // Prefer the statically-bundled provider (the only form that reliably lands
  // in the eszip). Fall back to a dynamic import for any provider not yet wired
  // into PROVIDERS_BY_NAME above — works in local/Docker deploys, but such a
  // provider must be added to the static map before it can ship to the cloud.
  const staticProvider = PROVIDERS_BY_NAME[providerName];
  if (staticProvider) {
    cachedProvider = staticProvider;
    return cachedProvider;
  }
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
