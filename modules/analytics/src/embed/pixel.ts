/**
 * The pre-pixel served at GET /a/<property_id>.js — used by `external`
 * properties that paste the snippet into their own site.
 *
 * Per spec-analytics-module §7.1 + §7.2.
 *
 * Why a separate route (vs inlining everything like sites/portal):
 *   - External operators copy a single `<script>` tag once. If they
 *     change scripts/Segment-key/dimensions later, they shouldn't have
 *     to repaste — the bundle here is fetched fresh on every page load.
 *   - Lets us serve different bundles per property without per-property
 *     <script> URLs (the property_id is in the path).
 *
 * Cache: Cache-Control: max-age=300 by default (per
 * ANALYTICS_EMBED_CACHE_MAX_AGE_SECONDS env). Operator-level updates
 * (script_head/body) are eventual; full propagation in <5min.
 */

import { renderEmbed, type RenderEmbedInput } from './render.js';

export interface BuildPixelBundleInput {
  /** Per-property data the route resolved from the DB. */
  property: {
    propertyId: string;
    kind: RenderEmbedInput['kind'];
  };
  /** Operator's tracking-script blobs. */
  scriptHead?: string;
  scriptBody?: string;
  /** Per-property Segment write key (decrypted by the route handler). */
  segmentWriteKey?: string;
  /** Origin where the ingest endpoint lives (same as the request's host). */
  ingestOrigin: string;
}

/**
 * Compose the full JS body served at /a/<property_id>.js. Returns
 * a self-executing function string — the consumer's <script src="..."> tag
 * runs the body on load.
 *
 * Note: the renderEmbed output is HTML (head + body markup) which works
 * for sites/portal where we have control over the page render. For the
 * external pixel we inline the equivalent JS — same wire shape, but
 * pure JS instead of `<script>` tags.
 */
export function buildPixelBundle(input: BuildPixelBundleInput): string {
  const embed = renderEmbed({
    propertyId: input.property.propertyId,
    kind: input.property.kind,
    ingestOrigin: input.ingestOrigin,
    scriptHead: input.scriptHead,
    scriptBody: input.scriptBody,
    segmentWriteKey: input.segmentWriteKey,
    // External pixel resolves dimensions at runtime via document.referrer
    // + URL inspection — see runtime block below.
    dimensions: undefined,
  });

  // Strip the `<script>` wrappers — we're already a JS body, not HTML.
  // The contents that appear inside <script>...</script> tags are the
  // pure JS we want to execute.
  const stripScriptTags = (markup: string): string =>
    markup.replace(/<script[^>]*>/g, '').replace(/<\/script>/g, '');

  // Runtime dimension resolver. Operators call
  // window.gatewazeAnalytics.setDimensions({...}) and the values are merged
  // into every subsequent custom event's data.
  //
  // NOTE: Umami v3 has no persistent payload-transformer API — track(fn)
  // fires ONE immediate beacon with fn's return value (the v1 transformer
  // semantics this used to rely on). So we wrap umami.track instead; page
  // views (auto-tracked) already carry url/referrer natively.
  const runtimeDimensionInit = `
(function(){
  window.gatewazeAnalytics = window.gatewazeAnalytics || {};
  window.gatewazeAnalytics.setDimensions = function(d){
    window.gatewazeAnalytics._extra = Object.assign({}, window.gatewazeAnalytics._extra || {}, d);
  };
  function ready(){
    if(window.umami && typeof window.umami.track==='function'){
      if(window.umami.__gwWrapped) return;
      var orig = window.umami.track.bind(window.umami);
      window.umami.track = function(a, b){
        if(typeof a === 'string'){
          return orig(a, Object.assign({}, b || {}, window.gatewazeAnalytics._extra || {}));
        }
        return orig(a, b);
      };
      window.umami.__gwWrapped = true;
    } else { setTimeout(ready, 50); }
  }
  ready();
})();`;

  return [
    '/* Gatewaze analytics pixel — ' + input.property.propertyId + ' */',
    stripScriptTags(embed.head),
    runtimeDimensionInit,
    stripScriptTags(embed.body),
  ].join('\n');
}
