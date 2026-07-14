/**
 * Structured-resource cover-image generation — bridged to
 * @gatewaze-modules/ai.
 *
 * Reads the prompt TEMPLATE from the 'resources-cover-image' use case
 * (resolveUseCasePrompt returns the bound skill's body — the visual
 * contract authored in lf-agents/skills/resources-cover-image), substitutes
 * [Title] / [Subtitle] / [Topics], and hands the rendered prompt to Gemini
 * via aiGenerateImage. Same pattern as the daily-briefing and lunch-and-learn
 * covers — the recipe is NOT executed by Goose; the module resolves its
 * auto-loaded skill body as the template and calls the image API directly.
 *
 * If the use case has no resolvable prompt (no skill/recipe/inline) the
 * generator throws `no_image_prompt` rather than producing an off-brand image.
 */

const STORAGE_BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';
const USE_CASE = 'resources-cover-image';

export interface ResourceCoverInput {
  /** 'collection' → cover_image_url; 'item' → featured_image_url. */
  kind: 'collection' | 'item';
  id: string;
  title: string;
  /** Collection description or item subtitle → [Subtitle]. */
  subtitle: string;
  /** Comma-joined categories / section headings → [Topics] (drives the metaphor). */
  topics: string;
}

export interface GeneratedCover {
  storage_path: string;
  prompt: string;
}

export interface CoverGeneratorDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /** Deterministic clock for tests. */
  now?: () => Date;
}

type AiReferenceImage = { mimeType: string; base64: string };

type AiGenerateImageFn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: { supabase: any },
  opts: {
    useCase: string;
    userId: string | null;
    prompt: string;
    model?: string;
    aspectRatio?: '16:9' | '1:1' | '4:3' | '9:16';
    destination: { bucket: string; path: string };
    referenceImages?: AiReferenceImage[];
    systemRun?: boolean;
  },
) => Promise<{ storagePath: string; mimeType: string; prompt: string; costMicroUsd: number; model: string; provider: string }>;

type ResolveUseCasePromptFn = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  useCaseId: string,
) => Promise<{
  systemPrompt: string;
  kickoffMessage: string;
  referenceImages: AiReferenceImage[];
  source: 'skill' | 'recipe' | 'inline' | 'empty';
  promptSource?: { system_prompt?: { recipe?: { recipe_id?: string; source_id?: string } } };
}>;

let cachedAiGenerateImage: AiGenerateImageFn | null = null;
async function getAiGenerateImage(): Promise<AiGenerateImageFn> {
  if (cachedAiGenerateImage) return cachedAiGenerateImage;
  const { loadAiModuleSubpath } = await import('./resolve-ai-module.js');
  const mod = await loadAiModuleSubpath<{ aiGenerateImage: AiGenerateImageFn }>('lib/runner', { label: 'lib/runner' });
  cachedAiGenerateImage = mod.aiGenerateImage;
  return cachedAiGenerateImage;
}

let cachedResolveUseCasePrompt: ResolveUseCasePromptFn | null = null;
async function getResolveUseCasePrompt(): Promise<ResolveUseCasePromptFn> {
  if (cachedResolveUseCasePrompt) return cachedResolveUseCasePrompt;
  const { loadAiModuleSubpath } = await import('./resolve-ai-module.js');
  const mod = await loadAiModuleSubpath<{ resolveUseCasePrompt: ResolveUseCasePromptFn }>('lib/use-case-prompt', { label: 'lib/use-case-prompt' });
  cachedResolveUseCasePrompt = mod.resolveUseCasePrompt;
  return cachedResolveUseCasePrompt;
}

/**
 * For a recipe-bound use case, resolveUseCasePrompt returns an empty
 * systemPrompt (recipes run in the recipe executor for the chat path).
 * The image generator needs the prompt TEXT, so pull it directly from the
 * recipe row + its auto-loaded skill body. Mirrors daily-briefing.
 */
async function resolveRecipeTemplate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  resolved: { promptSource?: { system_prompt?: { recipe?: { recipe_id?: string; source_id?: string } } } },
): Promise<{ template: string; referenceImages: AiReferenceImage[] }> {
  const recipeRef = resolved.promptSource?.system_prompt?.recipe;
  if (!recipeRef?.recipe_id) return { template: '', referenceImages: [] };
  const recipeRes = await supabase.from('ai_recipes').select('instructions').eq('id', recipeRef.recipe_id).maybeSingle();
  const instructions = (recipeRes.data as { instructions?: string } | null)?.instructions ?? '';
  const m = instructions.match(/the\s+([\w-]+)\s+skill\s*\(auto-loaded(?:\s+by\s+your\s+runtime)?\)/i);
  if (!m || !m[1]) return { template: '', referenceImages: [] };
  const skillRes = await supabase
    .from('ai_skills')
    .select('body, reference_image_bytes, reference_image_mime')
    .eq('source_id', recipeRef.source_id ?? '')
    .eq('dir_path', `skills/${m[1]}`)
    .maybeSingle();
  const row = skillRes.data as { body?: string; reference_image_bytes?: string | null; reference_image_mime?: string | null } | null;
  if (!row || typeof row.body !== 'string' || row.body.trim().length === 0) return { template: '', referenceImages: [] };
  const referenceImages: AiReferenceImage[] = [];
  if (row.reference_image_bytes && row.reference_image_mime) {
    referenceImages.push({ mimeType: row.reference_image_mime, base64: row.reference_image_bytes });
  }
  return { template: row.body, referenceImages };
}

/** Substitute [Title] / [Subtitle] / [Topics] in the operator-authored template. */
export function renderTemplate(template: string, input: ResourceCoverInput): string {
  return template
    .replace('[Title]', input.title.trim())
    .replace('[Subtitle]', (input.subtitle || '').trim())
    .replace('[Topics]', (input.topics || '').trim());
}

export function makeResourceCoverGenerator(deps: CoverGeneratorDeps) {
  const now = deps.now ?? (() => new Date());

  return async function generateResourceCover(input: ResourceCoverInput): Promise<GeneratedCover> {
    // 1. Resolve the use case → prompt TEMPLATE (+ any style reference image).
    const resolvePrompt = await getResolveUseCasePrompt();
    const resolved = await resolvePrompt(deps.supabase, USE_CASE);
    let template = resolved.systemPrompt;
    let referenceImages = resolved.referenceImages;
    if (resolved.source === 'recipe' && (!template || template.trim().length === 0)) {
      const fromRecipe = await resolveRecipeTemplate(deps.supabase, resolved);
      template = fromRecipe.template;
      referenceImages = fromRecipe.referenceImages;
    }
    if (!template || template.trim().length === 0) {
      throw new Error(
        `no_image_prompt: use case '${USE_CASE}' has no resolvable prompt template (source='${resolved.source}'). ` +
          `Bind it to the lf-agents resources-cover-image recipe/skill (see migration 020).`,
      );
    }

    // 2. Render against this resource.
    const prompt = renderTemplate(template, input);

    // 3. Generate + upload (aiGenerateImage handles storage + usage metering).
    const ts = now().toISOString().replace(/[:.]/g, '-');
    const path = `resources/${input.kind}/${input.id}/cover-${ts}.png`;

    const aiGenerateImage = await getAiGenerateImage();
    const result = await aiGenerateImage(
      { supabase: deps.supabase },
      {
        useCase: USE_CASE,
        userId: null,
        prompt,
        aspectRatio: '16:9',
        destination: { bucket: STORAGE_BUCKET, path },
        referenceImages,
        systemRun: true,
      },
    );

    return { storage_path: result.storagePath, prompt: result.prompt };
  };
}
