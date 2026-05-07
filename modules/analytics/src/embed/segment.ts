/**
 * Segment loader composition.
 *
 * Per spec-analytics-module §4.3 + §7. When a property has a
 * `segment_write_key` configured, the snippet automatically loads
 * Segment's analytics.js with that key and forwards Gatewaze
 * dimensions as `analytics.identify` / `analytics.page` calls.
 *
 * The loader source is lifted verbatim from Segment's official
 * analytics.js v1 snippet — paraphrasing it would diverge from
 * Segment's wire contract. The constants live here so:
 *   1. Operators can audit them (no opaque vendor blob in the bundle).
 *   2. A future Segment v2 / RudderStack swap is one file.
 */

import type { PreBakedDimensions } from './render.js';

export interface SegmentLoaderInput {
  writeKey: string;
  /** Pre-baked dimensions — passed to analytics.page() as properties. */
  dimensions?: PreBakedDimensions;
}

/** Segment analytics.js v1 snippet (write-key parameterised). */
const SEGMENT_LOADER_TEMPLATE = `(function(){
  var analytics=window.analytics=window.analytics||[];
  if(!analytics.initialize){
    if(analytics.invoked){
      window.console&&console.error&&console.error('Segment snippet included twice');
    } else {
      analytics.invoked=!0;
      analytics.methods=['trackSubmit','trackClick','trackLink','trackForm','pageview','identify','reset','group','track','ready','alias','debug','page','once','off','on','addSourceMiddleware','addIntegrationMiddleware','setAnonymousId','addDestinationMiddleware'];
      analytics.factory=function(t){return function(){var e=Array.prototype.slice.call(arguments);e.unshift(t);analytics.push(e);return analytics;};};
      for(var t=0;t<analytics.methods.length;t++){var e=analytics.methods[t];analytics[e]=analytics.factory(e);}
      analytics.load=function(t,e){
        var n=document.createElement('script');
        n.type='text/javascript';n.async=!0;n.src='https://cdn.segment.com/analytics.js/v1/'+t+'/analytics.min.js';
        var a=document.getElementsByTagName('script')[0];
        a.parentNode.insertBefore(n,a);
        analytics._loadOptions=e;
      };
      analytics.SNIPPET_VERSION='4.13.2';
      analytics.load(__WRITE_KEY__);
      analytics.page(__PAGE_PROPS__);
    }
  }
})();`;

function jsString(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/<\//g, '<\\/');
}

export function renderSegmentLoader(input: SegmentLoaderInput): string {
  const writeKeyJs = jsString(input.writeKey);
  const propsJs = jsString(input.dimensions ?? {});
  const body = SEGMENT_LOADER_TEMPLATE
    .replace('__WRITE_KEY__', writeKeyJs)
    .replace('__PAGE_PROPS__', propsJs);
  return `<script>${body}</script>`;
}
