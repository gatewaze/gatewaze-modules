/**
 * Embed snippet generator. Composes the `<script>` tag(s) the operator
 * pastes into an external site, OR that the sites renderer injects
 * automatically into Gatewaze-rendered pages.
 *
 * Per spec-analytics-module §7.
 *
 * Output is a single string of HTML — caller decides how to inject:
 *   - sites renderer: into `<head>` at render time (with pre-baked dimensions)
 *   - external snippet: shown in admin UI for operator to copy-paste
 *
 * Per-property variants (per spec §7.4):
 *   - `gatewaze_site` / `gatewaze_host`: pre-baked dimensions, same-origin
 *      ingest URL, full Segment loader if configured.
 *   - `portal`: same as above, but origin = portal host.
 *   - `external`: dimensions resolved at runtime via the `/a/<id>.js`
 *      pixel; cross-origin ingest with CORS.
 */

import { renderSegmentLoader } from './segment.js';

export type PropertyKind = 'gatewaze_site' | 'gatewaze_host' | 'portal' | 'external';

export interface PreBakedDimensions {
  /** ID of the underlying entity (site_id / host_id). */
  host_id?: string;
  /** ID of the page being viewed (sites pages mode). */
  page_id?: string;
  /** Path of the page (sites pages mode). */
  page_path?: string;
  /** A/B test id + variant id when the page is variant-served. */
  ab_test_id?: string;
  variant_id?: string;
  /** Brand id (for cross-property analysis later). */
  brand_id?: string;
}

export interface RenderEmbedInput {
  /** The property's stable property_id. */
  propertyId: string;
  /** Property kind — drives dimension pre-bake + same-vs-cross-origin choice. */
  kind: PropertyKind;
  /** Origin where the ingest endpoint is reachable. For sites + portal,
   *  this is the same-origin host the page is served from; for external
   *  it's the operator's `analytics.brand.com` host. Trailing slash optional. */
  ingestOrigin: string;
  /** Pre-baked dimension values, attached to every event from this snippet.
   *  Pass undefined for `external` properties — values come from the pixel
   *  at runtime instead. */
  dimensions?: PreBakedDimensions;
  /** Per-property tracking-script blobs (HEAD + BODY). Both passed through
   *  unchanged per spec §14.2. */
  scriptHead?: string;
  scriptBody?: string;
  /** Segment write key. When set, the snippet loads analytics.js + emits
   *  page() / identify() with the dimensions. */
  segmentWriteKey?: string;
}

export interface RenderEmbedOutput {
  /** Markup to inject inside `<head>`. */
  head: string;
  /** Markup to inject just before `</body>`. */
  body: string;
}

/**
 * Escape a value for safe inclusion in a JS string literal. Mirrors
 * (and is more conservative than) JSON.stringify because output is
 * embedded inside a `<script>` tag — `</script>` in user input would
 * break out of the script context.
 */
function jsString(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/<\//g, '<\\/');
}

/**
 * The Umami pixel JS, parameterised. Same shape Umami's official
 * `/script.js` returns; we include it inline so all dimension wiring
 * happens in one fetch (rather than pixel-then-config round trip).
 *
 * For `external` properties we serve a runtime variant from
 * /a/<property_id>.js — see ./pixel.ts.
 */
function inlinePixel(input: RenderEmbedInput): string {
  const origin = input.ingestOrigin.replace(/\/+$/, '');
  const dataAttrs: Record<string, string | undefined> = {
    'data-website-id': input.propertyId,
    'data-host-url': origin,
  };
  if (input.dimensions?.brand_id) dataAttrs['data-domain'] = input.dimensions.brand_id;

  const attrs = Object.entries(dataAttrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${(v as string).replace(/"/g, '&quot;')}"`)
    .join(' ');

  return `<script async defer src="${origin}/a/script.js" ${attrs}></script>`;
}

/**
 * Bake dimensions into a small init script. Runs after the Umami pixel
 * loads; uses umami.track() to attach dimensions to every subsequent
 * event. For `external` properties we skip this — the pixel from
 * /a/<id>.js handles dimension resolution itself.
 */
function dimensionInitScript(input: RenderEmbedInput): string {
  if (input.kind === 'external') return '';
  if (!input.dimensions || Object.keys(input.dimensions).every((k) => input.dimensions![k as keyof PreBakedDimensions] === undefined)) {
    return '';
  }
  const dims = jsString(input.dimensions);
  // Wrap in a tiny readiness check — umami may not be loaded yet
  // (the pixel script is async/defer). Use a queue so calls before
  // umami is ready get replayed.
  return `<script>
(function(){
  var d=${dims};
  function ready(){
    if(window.umami&&typeof window.umami.track==='function'){
      window.umami.track(function(props){
        return Object.assign({},props||{},d);
      });
    } else { setTimeout(ready,50); }
  }
  ready();
})();
</script>`;
}

export function renderEmbed(input: RenderEmbedInput): RenderEmbedOutput {
  const headParts: string[] = [];
  const bodyParts: string[] = [];

  // 1. Operator's custom head blob (Segment via analytics.js, GTM,
  //    LinkedIn Insight, etc.). NOT sanitised per spec §14.2 — admin
  //    role IS the security contract.
  if (input.scriptHead) headParts.push(input.scriptHead);

  // 2. Segment loader (when write key set). Goes in head so events
  //    fire before any other body content.
  if (input.segmentWriteKey) {
    headParts.push(renderSegmentLoader({
      writeKey: input.segmentWriteKey,
      dimensions: input.dimensions,
    }));
  }

  // 3. Umami pixel + dimension init script
  headParts.push(inlinePixel(input));
  headParts.push(dimensionInitScript(input));

  // 4. Operator's custom body blob (GTM noscript fallback typically)
  if (input.scriptBody) bodyParts.push(input.scriptBody);

  return {
    head: headParts.filter(Boolean).join('\n'),
    body: bodyParts.filter(Boolean).join('\n'),
  };
}
