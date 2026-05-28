import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmailProviderModule } from '../types/email-provider.ts';

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

  // Check the provider sub-module is installed and active
  const { data: mod } = await supabase
    .from('module_status')
    .select('module_id, status')
    .eq('module_id', `email-provider-${providerName}`)
    .eq('status', 'active')
    .single();

  if (!mod) {
    throw new Error(
      `Email provider "${providerName}" is not installed or not active. ` +
      `Install the email-provider-${providerName} module.`
    );
  }

  // Dynamic import of the provider module
  const provider = await import(
    `../../email-provider-${providerName}/provider.ts`
  );
  cachedProvider = provider.default as EmailProviderModule;
  return cachedProvider;
}

/**
 * Get the provider name from environment config.
 */
export function getProviderName(): string {
  return Deno.env.get('EMAIL_PROVIDER') || 'sendgrid';
}
