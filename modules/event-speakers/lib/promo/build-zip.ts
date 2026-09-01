// @ts-nocheck — jszip resolved at module-host install time.

/**
 * Assemble the downloadable speaker-kit zip: the rendered card images, one
 * plain-text file per post option (LinkedIn-safe as generated), the tracking
 * link, and a short README. Built in memory — a kit is a few MB of PNGs.
 */

import JSZip from 'jszip';
import type { PromoCard, PromoText } from './types.js';

export interface ZipInputs {
  speakerName: string;
  eventTitle: string;
  trackingUrl: string | null;
  promoText: PromoText | null;
  cards: Array<PromoCard & { png: Buffer }>;
  /** Personalized PPTX presentation template (Google Slides compatible). */
  deck?: Buffer | null;
}

const FORMAT_LABELS: Record<string, string> = {
  square: 'feed-post-1200x1200',
  story: 'story-1080x1920',
  landscape: 'link-preview-1200x630',
};

function safeName(value: string): string {
  return value.replace(/[^\w. -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'speaker';
}

export async function buildPromoKitZip(inputs: ZipInputs): Promise<Buffer> {
  const zip = new JSZip();
  const speaker = safeName(inputs.speakerName);

  for (const card of inputs.cards) {
    const label = FORMAT_LABELS[card.format] ?? card.format;
    zip.file(`images/${speaker}-${label}.png`, card.png);
  }

  if (inputs.promoText) {
    for (const [i, option] of inputs.promoText.options.entries()) {
      const name = `posts/option-${i + 1}-${safeName(option.key)}.txt`;
      zip.file(name, `${option.label}\n${'='.repeat(option.label.length)}\n\n${option.body}\n`);
    }
  }

  if (inputs.trackingUrl) {
    zip.file('tracking-link.txt', `${inputs.trackingUrl}\n`);
  }

  if (inputs.deck) {
    zip.file(`${speaker}-presentation-template.pptx`, inputs.deck);
  }

  const readme = [
    `Speaker kit - ${inputs.speakerName}, ${inputs.eventTitle}`,
    '',
    'What is in here:',
    '  images/          Share images sized for LinkedIn/X feed posts, stories,',
    '                   and link previews.',
    inputs.promoText
      ? '  posts/           Ready-to-post text options. Copy one as-is. They are\n                   plain text so they paste cleanly into LinkedIn.'
      : null,
    inputs.trackingUrl
      ? '  tracking-link.txt  Your personal registration link. It is already in\n                   each post; use it anywhere else you share the event.'
      : null,
    inputs.deck
      ? '  *-presentation-template.pptx  Your talk template, pre-branded with\n                   your title slide. Opens in PowerPoint, or upload to\n                   Google Drive and open with Google Slides.'
      : null,
    '',
    inputs.promoText?.mention_note ? `Note: ${inputs.promoText.mention_note}` : null,
    inputs.trackingUrl
      ? 'Registrations arriving through your link are credited to you, so we can\nsee (and celebrate) what your promotion drives.'
      : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  zip.file('README.txt', readme);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
