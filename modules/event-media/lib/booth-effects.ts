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
 * A style effect stores only its *look*. `buildPrompt` wraps that in the
 * guard rails, which are the part that took the testing (2026-09-20,
 * against real photos):
 *
 *   KEEP         restyling drifts faces badly unless identity is pinned
 *                explicitly; without it you get a lovely 80s portrait
 *                of somebody else entirely
 *   NO_NAMES     poster styles invent cast names and print them across
 *                the image ("JAKE & EMMA"), which on a wedding photo
 *                means a stranger's name in 60pt type
 *   SAME_PEOPLE  the important one. Styles like "prom photograph" and
 *                "wedding portrait" mean *a couple* in the training
 *                data, so a guest photographed alone came back standing
 *                beside an invented partner. A trailing instruction did
 *                not fix it; stating the rule BEFORE the style and
 *                repeating it after does. Hence the sandwich in
 *                `buildPrompt` — and hence no wardrobe below names one
 *                garment per person, because a cast list invites a cast.
 *
 * Asking for a new hairstyle also pulls the whole head with it, so the
 * 80s portrait restyles the hair the guest already has.
 */

export type BoothEffectKind = 'swap' | 'style';

export interface BoothEffect {
  id: string;
  label: string;
  /** One-line description shown under the effect in the picker. */
  blurb: string;
  kind: BoothEffectKind;
  /** The look, without guard rails — style effects only. */
  style?: string;
}

const SAME_PEOPLE_FIRST =
  'CRITICAL RULE: reproduce exactly the same number of people as the input photo, and no others. ' +
  'Never add, invent or duplicate a person, partner or companion who is not in the input. If the ' +
  'input shows one person, the output shows that one person alone.';

const SAME_PEOPLE_LAST =
  'Reminder: do not add, invent or duplicate any person. The output must contain exactly the same ' +
  'number of people as the input, in the same positions.';

const KEEP =
  'Keep the same people with their exact same faces, facial features, skin tone, eyeglasses and ' +
  'identity. Do not beautify them. Photorealistic.';

const NO_NAMES =
  'Do not add any personal names, character names or cast credits anywhere in the image.';

export const BOOTH_EFFECTS: BoothEffect[] = [
  {
    id: 'eighties-portrait',
    label: '80s glamour',
    blurb: 'Puff sleeves, pearls, studio gradient',
    kind: 'style',
    style:
      'a 1980s high-street glamour studio wedding portrait: 1980s bridal and formal wedding attire ' +
      'such as white puff-sleeve lace, veils, pearls, pale grey tailoring and white rose ' +
      'buttonholes, soft red and blue studio gradient backdrop, soft 80s studio lighting, visible ' +
      'film grain. Style the existing hair into a 1980s shape but keep its colour and length.',
  },
  {
    id: 'top-gun',
    label: 'Top flight',
    blurb: 'Flight suits, aviators, jets at sunset',
    kind: 'style',
    style:
      'a 1986 aviation action movie poster: tan flight suits and leather bomber jackets, aviator ' +
      'sunglasses, fighter jets and golden sunset haze behind, lens flare, dramatic warm ' +
      'backlight, grainy 80s film poster look.',
  },
  {
    id: 'prom-1985',
    label: '1985 prom',
    blurb: 'Ruffles, corsages, laser backdrop',
    kind: 'style',
    style:
      'a 1985 American high school prom photograph: pastel 1980s prom formalwear in powder blue ' +
      'and lilac with ruffles, corsages and taffeta, cheesy purple and blue laser studio backdrop, ' +
      'direct on-camera flash, heavy 80s film grain.',
  },
  {
    id: 'vhs-box',
    label: 'VHS cover',
    blurb: 'Airbrushed rental-box art, tracking lines',
    kind: 'style',
    style:
      'a worn 1980s VHS rental box cover: heavy magenta and cyan colour grading, chunky airbrushed ' +
      'poster art style, slight VHS tracking distortion and scanlines, glossy plastic sheen, faded ' +
      'edges.',
  },
  {
    id: 'dance-movie',
    label: 'Dance movie',
    blurb: 'Summer resort, spotlight, 80s romance',
    kind: 'style',
    style:
      'a 1987 romantic dance movie poster: warm summer resort evening, moody stage lighting with a ' +
      'spotlight behind, soft romantic glow, 80s film poster grain and colour grading.',
  },
  {
    id: 'synthwave',
    label: 'Synthwave',
    blurb: 'Neon rim light, chrome sunset, laser grid',
    kind: 'style',
    style:
      'a cinematic 1984 synthwave album cover. Relight the people with strong magenta key light ' +
      'from one side and cyan rim light from the other so the neon falls across their skin and ' +
      'clothing. Behind them: a huge chrome sunset with horizontal scan bands, a glowing purple ' +
      'laser grid receding to the horizon, and a starfield. Add atmospheric haze and a subtle ' +
      'chromatic-aberration glow.',
  },
];

/**
 * Compose what actually gets sent. The people-count rule brackets the
 * style on both sides — see the note at the top of this file for why a
 * single trailing instruction is not enough.
 */
export function buildPrompt(effect: BoothEffect): string {
  return `${SAME_PEOPLE_FIRST} Now restyle the photo as ${effect.style} ` +
    `${KEEP} ${NO_NAMES} ${SAME_PEOPLE_LAST}`;
}

export function boothEffect(id: string): BoothEffect | null {
  return BOOTH_EFFECTS.find((e) => e.id === id) ?? null;
}

/** Catalogue shape handed to the guest UI — prompts stay server-side. */
export function publicEffects(): Array<Pick<BoothEffect, 'id' | 'label' | 'blurb' | 'kind'>> {
  return BOOTH_EFFECTS.map(({ id, label, blurb, kind }) => ({ id, label, blurb, kind }));
}
