/**
 * Photo-booth effect catalogue.
 *
 * Two kinds of effect, because they need different models:
 *
 *   style — an identity-preserving edit model restyles the whole scene
 *           (80s movie poster, prom photo, and so on) while keeping the
 *           guest's own face
 *   swap  — a dedicated face-swap model puts a configured reference
 *           face (the bride, the groom) onto the guest's photo
 *
 * The prompts below are the ones that survived testing against real
 * photos on 2026-09-20. Two rules were learned the hard way and are
 * repeated on every style prompt:
 *
 *   KEEP     restyling drifts faces badly unless identity is pinned
 *            explicitly; without it you get a lovely 80s portrait of
 *            somebody else entirely
 *   NO_NAMES poster styles invent cast names and print them across the
 *            image ("JAKE & EMMA"), which on a wedding photo means a
 *            stranger's name in 60pt type
 *
 * Asking for a new hairstyle also pulls the whole head with it, so the
 * 80s portrait restyles the hair the guest already has rather than
 * replacing it.
 */

export type BoothEffectKind = 'swap' | 'style';

export interface BoothEffect {
  id: string;
  label: string;
  /** One-line description shown under the effect in the picker. */
  blurb: string;
  kind: BoothEffectKind;
  /** Restyle instruction — style effects only. */
  prompt?: string;
}

const KEEP =
  'Keep the same people with their exact same faces, facial features, skin tone, eyeglasses and ' +
  'identity, in the same positions and poses. Do not change who they are, and do not beautify them. ' +
  'Photorealistic.';

const NO_NAMES =
  'Do not add any personal names, character names or cast credits anywhere in the image.';

export const BOOTH_EFFECTS: BoothEffect[] = [
  {
    id: 'eighties-portrait',
    label: '80s glamour',
    blurb: 'Puff sleeves, pearls, studio gradient',
    kind: 'style',
    prompt:
      'Restyle this photo as a 1980s high-street glamour studio wedding portrait: white puff-sleeve ' +
      'lace wedding dress with veil and pearls, pale grey tuxedo with bow tie and white rose ' +
      'buttonhole, soft red and blue studio gradient backdrop, soft 80s studio lighting, visible ' +
      'film grain. Style the existing hair into a 1980s shape but keep its colour and length. ' +
      `${KEEP} ${NO_NAMES}`,
  },
  {
    id: 'top-gun',
    label: 'Top flight',
    blurb: 'Flight suits, aviators, jets at sunset',
    kind: 'style',
    prompt:
      'Restyle this photo as a 1986 aviation action movie poster: tan flight suits and leather ' +
      'bomber jackets, aviator sunglasses, fighter jets and golden sunset haze behind, lens flare, ' +
      `dramatic warm backlight, grainy 80s film poster look. ${KEEP} ${NO_NAMES}`,
  },
  {
    id: 'prom-1985',
    label: '1985 prom',
    blurb: 'Ruffled tux, taffeta, laser backdrop',
    kind: 'style',
    prompt:
      'Restyle this photo as a 1985 American high school prom photograph: powder blue ruffled ' +
      'tuxedo and taffeta prom dress with corsage, cheesy purple and blue laser studio backdrop, ' +
      `direct on-camera flash, heavy 80s film grain. ${KEEP} ${NO_NAMES}`,
  },
  {
    id: 'vhs-box',
    label: 'VHS cover',
    blurb: 'Airbrushed rental-box art, tracking lines',
    kind: 'style',
    prompt:
      'Restyle this photo as a worn 1980s VHS rental box cover: heavy magenta and cyan colour ' +
      'grading, chunky airbrushed poster art style, slight VHS tracking distortion and scanlines, ' +
      `glossy plastic sheen, faded edges. ${KEEP} ${NO_NAMES}`,
  },
  {
    id: 'dance-movie',
    label: 'Dance movie',
    blurb: 'Summer resort, spotlight, 80s romance',
    kind: 'style',
    prompt:
      'Restyle this photo as a 1987 romantic dance movie poster: warm summer resort evening, moody ' +
      'stage lighting with a spotlight behind, couples dancing in the background, soft romantic ' +
      `glow, 80s film poster grain and colour grading. ${KEEP} ${NO_NAMES}`,
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    blurb: 'Neon rim light, chrome sunset, laser grid',
    kind: 'style',
    prompt:
      'Restyle this photo as a cinematic 1984 synthwave album cover. Relight the people with strong ' +
      'magenta key light from one side and cyan rim light from the other so the neon falls across ' +
      'their skin and clothing. Behind them: a huge chrome sunset with horizontal scan bands, a ' +
      'glowing purple laser grid receding to the horizon, and a starfield. Add atmospheric haze and ' +
      `a subtle chromatic-aberration glow. ${KEEP} ${NO_NAMES}`,
  },
];

export function boothEffect(id: string): BoothEffect | null {
  return BOOTH_EFFECTS.find((e) => e.id === id) ?? null;
}

/** Catalogue shape handed to the guest UI — prompts stay server-side. */
export function publicEffects(): Array<Pick<BoothEffect, 'id' | 'label' | 'blurb' | 'kind'>> {
  return BOOTH_EFFECTS.map(({ id, label, blurb, kind }) => ({ id, label, blurb, kind }));
}
