/**
 * The module's vendored brand assets, read once and handed around as data
 * URIs so a Chromium render needs no network and no public URL.
 *
 * These are the AAIF defaults the prototype was tuned on: the event key art
 * behind a thumbnail, the talk card's circuit-board art, the foundation's
 * logo, the music sting lifted from the existing uploads, and the two
 * typefaces. A brand that wants its own swaps the files in `templates/`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

export interface StudioAssets {
  thumbnailBg: string;
  cardBg: string;
  logo: string;
  fonts: { archivo: string; figtree: string };
  /** Path on disk, for ffmpeg. */
  prerollBedPath: string;
}

let cached: Promise<StudioAssets> | null = null;

function uri(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function templatesDir(): string {
  return TEMPLATES;
}

export function loadStudioAssets(): Promise<StudioAssets> {
  if (!cached) {
    cached = (async () => ({
      thumbnailBg: uri(await readFile(join(TEMPLATES, 'thumbnail-bg.jpg')), 'image/jpeg'),
      cardBg: uri(await readFile(join(TEMPLATES, 'card-bg.png')), 'image/png'),
      logo: uri(await readFile(join(TEMPLATES, 'brand-logo.svg')), 'image/svg+xml'),
      fonts: {
        archivo: uri(await readFile(join(TEMPLATES, 'fonts', 'archivo.woff2')), 'font/woff2'),
        figtree: uri(await readFile(join(TEMPLATES, 'fonts', 'figtree.woff2')), 'font/woff2'),
      },
      prerollBedPath: join(TEMPLATES, 'preroll-bed.m4a'),
    }))();
  }
  return cached;
}
