/**
 * Provider router.
 *
 * Given a (use_case, user_id, provider, model) tuple, this:
 *   1. Validates the model is allowed for the use-case.
 *   2. Resolves the API key per credentials.ts.
 *   3. Constructs the appropriate ProviderClient.
 *   4. (Optional) rewrites the base URL to point at Cloudflare AI
 *      Gateway when AI_GATEWAY_URL is configured.
 *
 * The result is a one-shot client + the metadata the cost ledger
 * needs to attribute the call.
 */

import { AnthropicProviderClient } from './anthropic-client.js';
import { OpenAIProviderClient } from './openai-client.js';
import { GeminiProviderClient } from './gemini-client.js';
import { resolveCredential } from '../credentials.js';
import {
  type KnownProvider,
  type ProviderClient,
} from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = { from(table: string): any };

export interface PickClientOpts {
  useCase: string;
  userId: string | null;
  provider: 'auto' | KnownProvider;
  /** Optional caller-supplied model id; falls back to use-case default. */
  model?: string;
  systemRunOnly?: boolean;
}

export interface PickedClient {
  client: ProviderClient;
  provider: KnownProvider;
  model: string;
  credentialSource: 'user' | 'use_case' | 'env';
  credentialLast4: string;
  credentialId: string | null;
}

interface UseCaseRow {
  id: string;
  default_provider: 'auto' | KnownProvider;
  default_model: string;
  allowed_models: string[];
}

export class ProviderRouter {
  constructor(private readonly supabase: SupabaseClient) {}

  async pickClient(opts: PickClientOpts): Promise<PickedClient> {
    const useCaseRow = await this.loadUseCase(opts.useCase);
    const { provider, model } = await this.resolveProviderModel(useCaseRow, opts);

    const credential = await resolveCredential(this.supabase, {
      provider,
      userId: opts.userId,
      useCase: opts.useCase,
      systemRunOnly: opts.systemRunOnly,
    });

    const baseUrl = providerBaseUrl(provider);
    const client = makeClient(provider, credential.apiKey, baseUrl);

    return {
      client,
      provider,
      model,
      credentialSource: credential.source,
      credentialLast4: credential.last4,
      credentialId: credential.credentialId,
    };
  }

  private async loadUseCase(id: string): Promise<UseCaseRow> {
    const result = await this.supabase
      .from('ai_use_cases')
      .select('id, default_provider, default_model, allowed_models')
      .eq('id', id)
      .maybeSingle();
    if (result.error) throw new Error(`use_case lookup: ${result.error.message}`);
    if (!result.data) {
      throw new Error(`use_case '${id}' not registered`);
    }
    return result.data as UseCaseRow;
  }

  /**
   * Apply the allow-list + 'auto' fallback walk.
   *
   *   provider='auto'  → walk use_case.allowed_models in order; return
   *                       the first whose provider has a resolvable key.
   *                       (Credential lookup happens lazily — we
   *                       optimistically attempt the provider name and
   *                       let resolveCredential throw if missing.)
   *   provider='openai' → use the supplied model, or use_case.default_model
   *                       if that's an openai model; else 400.
   */
  private async resolveProviderModel(
    useCase: UseCaseRow,
    opts: PickClientOpts,
  ): Promise<{ provider: KnownProvider; model: string }> {
    if (opts.provider === 'auto') {
      // Walk allowed_models in order; pick the first whose key exists.
      for (const candidate of useCase.allowed_models) {
        const candidateProvider = inferProvider(candidate);
        if (!candidateProvider) continue;
        try {
          await resolveCredential(this.supabase, {
            provider: candidateProvider,
            userId: opts.userId,
            useCase: opts.useCase,
            systemRunOnly: opts.systemRunOnly,
          });
          return { provider: candidateProvider, model: candidate };
        } catch {
          // Try next.
        }
      }
      throw new Error(
        `auto resolution failed: no resolvable credentials for any of ${useCase.allowed_models.join(', ')}`,
      );
    }

    const chosenModel = opts.model ?? useCase.default_model;
    const inferredProvider = inferProvider(chosenModel);
    if (inferredProvider && inferredProvider !== opts.provider) {
      throw new Error(
        `model '${chosenModel}' belongs to provider '${inferredProvider}', not '${opts.provider}'`,
      );
    }
    if (
      useCase.allowed_models.length > 0 &&
      !useCase.allowed_models.includes(chosenModel)
    ) {
      throw new Error(
        `model '${chosenModel}' is not in use_case '${useCase.id}' allowed_models`,
      );
    }
    return { provider: opts.provider, model: chosenModel };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Infer provider from a model id. Keeps the surface DRY — operators
 * don't have to remember to list provider+model separately.
 */
export function inferProvider(model: string): KnownProvider | null {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o') || model.startsWith('text-embedding-')) {
    return 'openai';
  }
  if (model.startsWith('gemini-')) return 'gemini';
  return null;
}

function makeClient(
  provider: KnownProvider,
  apiKey: string,
  baseUrl?: string,
): ProviderClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicProviderClient(apiKey, baseUrl);
    case 'openai':
      return new OpenAIProviderClient(apiKey, baseUrl);
    case 'gemini':
      return new GeminiProviderClient(apiKey, baseUrl);
  }
}

/**
 * Optionally rewrite the provider base URL to point at Cloudflare AI
 * Gateway. When AI_GATEWAY_URL is unset, returns undefined and providers
 * use their default endpoints.
 */
function providerBaseUrl(provider: KnownProvider): string | undefined {
  const gateway = process.env.AI_GATEWAY_URL?.replace(/\/$/, '');
  if (!gateway) return undefined;
  switch (provider) {
    case 'openai':
      return `${gateway}/openai`;
    case 'anthropic':
      return `${gateway}/anthropic`;
    case 'gemini':
      return `${gateway}/google-ai-studio`;
  }
}
