/**
 * embed block kind — iframe wrapper for third-party providers.
 *
 * Per spec-content-modules-git-architecture §9.2:
 *   build-time bake; no runtime fetch needed (iframe loads at user's
 *   browser).
 *
 * Theme author declares blocks like:
 *
 *   /* @gatewaze:block kind="embed" name="Video" provider="youtube" *​/
 *   export function Video(props: VideoProps) { ... }
 *
 * Per-instance config (page_blocks.kind_config) supplies the content ID
 * + display options. The block component renders an iframe with the
 * resolved URL for the provider.
 *
 * Each provider has a different URL scheme + parameter format; this
 * module declares the catalog of supported providers and the URL-builder
 * for each.
 */

export type EmbedProvider =
  | 'youtube'
  | 'vimeo'
  | 'calendly'
  | 'spotify'
  | 'codepen'
  | 'tally'
  | 'typeform'
  | 'loom'
  | 'figma';

export interface EmbedProviderDef {
  slug: EmbedProvider;
  displayName: string;
  /** Pattern shown in the editor for the content_id field. */
  contentIdLabel: string;
  contentIdPlaceholder: string;
  /** JSON Schema for additional per-instance options. */
  optionsSchema?: Record<string, unknown>;
  /** Build the iframe src URL given a content_id + options. */
  buildSrc(contentId: string, options?: Record<string, unknown>): string;
  /** Default aspect ratio for the iframe (width:height). */
  defaultAspectRatio: { w: number; h: number };
  /** Whether the iframe needs allowfullscreen. */
  allowFullscreen?: boolean;
  /** Optional sandbox attributes. */
  sandbox?: string;
  /** Permissions policy / allow attribute (autoplay, encrypted-media, etc). */
  allow?: string;
}

export const EMBED_PROVIDERS: Record<EmbedProvider, EmbedProviderDef> = {
  youtube: {
    slug: 'youtube',
    displayName: 'YouTube',
    contentIdLabel: 'Video ID',
    contentIdPlaceholder: 'dQw4w9WgXcQ',
    optionsSchema: {
      type: 'object',
      properties: {
        autoplay: { type: 'boolean', default: false },
        controls: { type: 'boolean', default: true },
        mute: { type: 'boolean', default: false },
        start: { type: 'integer', minimum: 0, description: 'Start time in seconds' },
      },
    },
    buildSrc(contentId, options) {
      const params = new URLSearchParams();
      const opts = options ?? {};
      if (opts.autoplay) params.set('autoplay', '1');
      if (opts.controls === false) params.set('controls', '0');
      if (opts.mute) params.set('mute', '1');
      if (typeof opts.start === 'number') params.set('start', String(opts.start));
      const qs = params.toString();
      return `https://www.youtube.com/embed/${encodeURIComponent(contentId)}${qs ? `?${qs}` : ''}`;
    },
    defaultAspectRatio: { w: 16, h: 9 },
    allowFullscreen: true,
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
  },
  vimeo: {
    slug: 'vimeo',
    displayName: 'Vimeo',
    contentIdLabel: 'Video ID',
    contentIdPlaceholder: '76979871',
    optionsSchema: {
      type: 'object',
      properties: {
        autoplay: { type: 'boolean', default: false },
        muted: { type: 'boolean', default: false },
        loop: { type: 'boolean', default: false },
      },
    },
    buildSrc(contentId, options) {
      const params = new URLSearchParams();
      const opts = options ?? {};
      if (opts.autoplay) params.set('autoplay', '1');
      if (opts.muted) params.set('muted', '1');
      if (opts.loop) params.set('loop', '1');
      const qs = params.toString();
      return `https://player.vimeo.com/video/${encodeURIComponent(contentId)}${qs ? `?${qs}` : ''}`;
    },
    defaultAspectRatio: { w: 16, h: 9 },
    allowFullscreen: true,
    allow: 'autoplay; fullscreen; picture-in-picture',
  },
  calendly: {
    slug: 'calendly',
    displayName: 'Calendly',
    contentIdLabel: 'Event link slug',
    contentIdPlaceholder: 'dan/30min',
    optionsSchema: {
      type: 'object',
      properties: {
        hideEventTypeDetails: { type: 'boolean', default: false },
        hideGdprBanner: { type: 'boolean', default: false },
      },
    },
    buildSrc(contentId, options) {
      const params = new URLSearchParams();
      const opts = options ?? {};
      if (opts.hideEventTypeDetails) params.set('hide_event_type_details', '1');
      if (opts.hideGdprBanner) params.set('hide_gdpr_banner', '1');
      const qs = params.toString();
      return `https://calendly.com/${contentId}${qs ? `?${qs}` : ''}`;
    },
    defaultAspectRatio: { w: 4, h: 5 },
  },
  spotify: {
    slug: 'spotify',
    displayName: 'Spotify',
    contentIdLabel: 'URI (track/playlist/episode)',
    contentIdPlaceholder: 'spotify:track:6rqhFgbbKwnb9MLmUQDhG6',
    buildSrc(contentId) {
      // Convert URI to embed URL: spotify:track:ID → /embed/track/ID
      const m = contentId.match(/^spotify:(track|album|playlist|episode|show):(.+)$/);
      if (!m) return `https://open.spotify.com/embed/track/${encodeURIComponent(contentId)}`;
      return `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
    },
    defaultAspectRatio: { w: 1, h: 1 },
    allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
  },
  codepen: {
    slug: 'codepen',
    displayName: 'CodePen',
    contentIdLabel: 'username/pen-id',
    contentIdPlaceholder: 'chriscoyier/PNaGbb',
    optionsSchema: {
      type: 'object',
      properties: {
        defaultTab: { type: 'string', enum: ['html', 'css', 'js', 'result'], default: 'result' },
      },
    },
    buildSrc(contentId, options) {
      const opts = options ?? {};
      const defaultTab = (opts.defaultTab as string | undefined) ?? 'result';
      return `https://codepen.io/${contentId.replace('/', '/embed/')}?default-tab=${defaultTab}`;
    },
    defaultAspectRatio: { w: 16, h: 9 },
  },
  tally: {
    slug: 'tally',
    displayName: 'Tally Form',
    contentIdLabel: 'Form ID',
    contentIdPlaceholder: 'mO0XW1',
    buildSrc(contentId) {
      return `https://tally.so/embed/${encodeURIComponent(contentId)}?alignLeft=1&hideTitle=1&transparentBackground=1`;
    },
    defaultAspectRatio: { w: 4, h: 5 },
  },
  typeform: {
    slug: 'typeform',
    displayName: 'Typeform',
    contentIdLabel: 'Form ID',
    contentIdPlaceholder: 'AbCdEf12',
    buildSrc(contentId) {
      return `https://form.typeform.com/to/${encodeURIComponent(contentId)}`;
    },
    defaultAspectRatio: { w: 4, h: 5 },
  },
  loom: {
    slug: 'loom',
    displayName: 'Loom',
    contentIdLabel: 'Video ID',
    contentIdPlaceholder: 'a1b2c3d4e5f6',
    buildSrc(contentId) {
      return `https://www.loom.com/embed/${encodeURIComponent(contentId)}`;
    },
    defaultAspectRatio: { w: 16, h: 9 },
    allowFullscreen: true,
  },
  figma: {
    slug: 'figma',
    displayName: 'Figma',
    contentIdLabel: 'Figma file URL',
    contentIdPlaceholder: 'https://www.figma.com/file/...',
    buildSrc(contentId) {
      return `https://www.figma.com/embed?embed_host=gatewaze&url=${encodeURIComponent(contentId)}`;
    },
    defaultAspectRatio: { w: 16, h: 9 },
    allowFullscreen: true,
  },
};

/**
 * Build the rendered HTML for an embed block instance.
 * Used at publish time (build-time bake) by the build pipeline so that
 * the published HTML contains a stable iframe element ready to render.
 */
export function buildEmbedHtml(args: {
  provider: EmbedProvider;
  contentId: string;
  options?: Record<string, unknown>;
  width?: string;
  height?: string;
  title?: string;
}): string {
  const def = EMBED_PROVIDERS[args.provider];
  if (!def) {
    return `<!-- gatewaze: unknown embed provider '${args.provider}' -->`;
  }
  const src = def.buildSrc(args.contentId, args.options);
  const ratio = def.defaultAspectRatio;
  const widthStyle = args.width ?? '100%';
  const heightStyle = args.height ?? `${(ratio.h / ratio.w) * 100}%`;
  const isPercentHeight = heightStyle.endsWith('%');

  const attrs: string[] = [
    `src="${escapeHtml(src)}"`,
    `loading="lazy"`,
    `frameborder="0"`,
  ];
  if (def.allowFullscreen) attrs.push('allowfullscreen');
  if (def.allow) attrs.push(`allow="${escapeHtml(def.allow)}"`);
  if (def.sandbox) attrs.push(`sandbox="${escapeHtml(def.sandbox)}"`);
  if (args.title) attrs.push(`title="${escapeHtml(args.title)}"`);

  if (isPercentHeight) {
    // Aspect-ratio wrapper for responsive sizing
    return `<div class="gatewaze-embed-wrapper" style="position:relative;width:${escapeHtml(widthStyle)};padding-top:${escapeHtml(heightStyle)};">
  <iframe ${attrs.join(' ')} style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;"></iframe>
</div>`;
  }
  return `<iframe ${attrs.join(' ')} style="width:${escapeHtml(widthStyle)};height:${escapeHtml(heightStyle)};border:0;"></iframe>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function listEmbedProviders(): EmbedProviderDef[] {
  return Object.values(EMBED_PROVIDERS);
}
