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
  /** Exaggerated on purpose: drops the natural-proportions rule. */
  caricature?: boolean;
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

/** Posters and covers: see the note above the era looks. */
const POSTER_FACES =
  'Frame the people close, from about the chest up, so their faces are large and clear and facing ' +
  'the camera -- by moving the camera closer, never by enlarging the heads. ' +
  'Restyle their clothes, and any hoods or hats, to suit the look rather than keeping what they wear in the input.';

/** Keep a selfie a selfie: see the note above the decade effects. */
// Framing, not face size: "keep each face as large as in the input" was
// read as "make the heads bigger" once the body was redrawn, and gave
// guests oversized heads (seen 2026-09-22).
const DECADE_FRAMING =
  'Keep the original framing, crop and camera distance. No hats or sunglasses that were not in the input.';

/**
 * Physically believable, with bodies in proportion. Posters put people in
 * cars and on stages, and the model would seat a guest where no body
 * could fit, or grow a head to fill the frame (both seen 2026-09-22).
 */
const REALISTIC =
  'The scene must be physically possible: people are the right size for everything around them and ' +
  'sit, stand and lean in positions a real body can take, never too big for a car, chair or doorway, ' +
  'and never overlapping objects impossibly.';
const PROPORTIONS =
  'Keep every body in natural proportion: heads the correct size for their bodies, no enlarged heads, ' +
  'no stretched or shrunken limbs.';

// Widened 2026-09-22 from names alone: poster looks also printed
// invented titles and taglines ("TOP GUNS", "SUMMER SWING").
const NO_NAMES =
  'Do not add any titles, taglines, personal names, character names or cast credits anywhere in the image.';

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
      'backlight, grainy 80s film poster look. ' + POSTER_FACES,
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
      'edges. ' + POSTER_FACES,
  },
  {
    id: 'dance-movie',
    label: 'Dance movie',
    blurb: 'Summer resort, spotlight, 80s romance',
    kind: 'style',
    style:
      'a 1987 romantic dance movie poster: warm summer resort evening, moody stage lighting with a ' +
      'spotlight behind, soft romantic glow, 80s film poster grain and colour grading. ' + POSTER_FACES,
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
      'chromatic-aberration glow. ' + POSTER_FACES,
  },
  // The decades. These are what the booth's outside board offers, one
  // tile each, so their ids are what a booth theme's hotspots name.
  // Wardrobes are lists of the decade's clothes, never one garment per
  // person, for the reason at the top of this file. Each ends in
  // DECADE_FRAMING because without it the first round re-posed selfies as
  // full-length shots, and a face a tenth of the frame high is where
  // likeness goes first (tested 2026-09-21).
  {
    id: 'decade-1950s',
    label: 'Diner date',
    blurb: 'Chrome, neon and Kodachrome colour',
    kind: 'style',
    style:
      'a 1950s colour portrait photograph on Kodachrome film: 1950s fashion such as full-skirted ' +
      'tea dresses, pearls, cardigans, sharp suits with narrow ties and letterman jackets, a ' +
      'chrome-and-neon diner softly out of focus behind, warm saturated Kodachrome colour, soft flash, fine film ' +
      'grain. Style the existing hair into a 1950s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'decade-1960s',
    label: 'Swinging London',
    blurb: 'Mod colour and pop-art backdrops',
    kind: 'style',
    style:
      'a 1960s Swinging London fashion photograph: mod 1960s clothing such as shift dresses, bold ' +
      'op-art and colour-block patterns, slim tailored suits and polo necks, a bright pop-art ' +
      'studio backdrop, crisp 1960s colour film with slightly faded tones. Style the existing ' +
      'hair into a 1960s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'decade-1970s',
    label: 'Seventies lounge',
    blurb: 'Wood panelling, warm faded film',
    kind: 'style',
    style:
      'a 1970s photograph: 1970s fashion such as wide collars, flares, suede, velvet and ' +
      'patterned shirts, a wood-panelled room with warm lamplight and a disco ball glinting ' +
      'behind, warm faded orange-brown 1970s film colour, soft focus glow, heavy grain. Style ' +
      'the existing hair into a 1970s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'decade-1990s',
    label: 'Disposable camera',
    blurb: 'Harsh flash, denim and a date stamp',
    kind: 'style',
    style:
      'a 1990s disposable-camera snapshot: 1990s fashion such as plaid shirts, denim, slip ' +
      'dresses, chokers and oversized jackets, harsh direct on-camera flash with dark ' +
      'surroundings, slightly overexposed skin, 1990s drugstore film colour and grain, a faint ' +
      'orange date stamp in one corner. Style the existing hair into a 1990s shape but keep its ' +
      'colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'decade-2010s',
    label: 'Golden hour',
    blurb: 'Filtered festival season',
    kind: 'style',
    style:
      // Not "as posted on a photo app": that drew like buttons and
      // captions into the picture.
      'a 2010s filtered photograph: 2010s fashion such as skinny jeans, floral prints, denim ' +
      'jackets and plaid shirts, golden-hour festival backdrop with bunting and fairy lights, a ' +
      'warm faded vintage filter with lifted blacks and a soft vignette. No app interface, icons, ' +
      'captions or any other text. Style the existing hair into a 2010s shape but keep its ' +
      'colour and length. ' + DECADE_FRAMING,
  },

  // ── Era looks ─────────────────────────────────────────────────────
  // Six looks per era (lib/booth-eras.ts lists which), so a projector
  // full of guests who all chose the same decade is not six hundred of
  // the same picture. The 1980s use the six 80s looks above. Poster and
  // cover looks end in POSTER_FACES: a poster composition otherwise
  // shrinks the people to make room, and small faces lose likeness.

  // 1950s
  {
    id: 'fifties-sockhop', label: 'Sock hop', blurb: 'High-school gym dance, jukebox and streamers', kind: 'style',
    style: 'a 1950s high-school sock hop photograph: 1950s fashion such as poodle skirts, saddle shoes, ' +
      'cardigans, letterman jackets and rolled-up jeans, a decorated school gym with paper streamers and ' +
      'a glowing jukebox, bright on-camera flash, 1950s colour film. Style the existing hair into a 1950s ' +
      'shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'fifties-hollywood', label: 'Silver screen', blurb: 'Black-and-white studio glamour portrait', kind: 'style',
    style: 'a 1950s Hollywood studio publicity portrait in black and white: 1950s evening wear such as ' +
      'satin gowns, fur stoles, pearls and dinner jackets, dramatic butterfly lighting, soft focus, ' +
      'glossy silver gelatin print. Style the existing hair into a 1950s shape but keep its colour and ' +
      'length. ' + DECADE_FRAMING,
  },
  {
    id: 'fifties-drivein', label: 'Drive-in feature', blurb: 'Painted B-movie poster, big title-free sky', kind: 'style',
    style: 'a painted 1950s drive-in movie poster: lurid gouache illustration style, dramatic sunset sky, ' +
      'a classic 1950s convertible and a drive-in screen behind, bold saturated colours, halftone print ' +
      'texture, no lettering at all. ' + POSTER_FACES,
  },
  {
    id: 'fifties-rocknroll', label: 'Rock and roll', blurb: 'Record-sleeve stage shot, quiffs and chrome mics', kind: 'style',
    style: 'a 1950s rock and roll record sleeve photograph: a small club stage with a chrome microphone, ' +
      'an upright bass and spotlights, 1950s fashion such as quiffs, leather jackets, polka dots and ' +
      'swing dresses, punchy colour and slight print grain, no lettering. Style the existing hair into ' +
      'a 1950s shape but keep its colour and length. ' + POSTER_FACES,
  },
  {
    id: 'fifties-atomic', label: 'Atomic age', blurb: 'Flying saucers and ray guns, sci-fi poster', kind: 'style',
    style: 'a painted 1950s atomic-age science fiction movie poster: flying saucers, a ringed planet and ' +
      'a retro-futuristic city behind, silver space suits with bubble collars, vivid pulp colours and ' +
      'halftone texture, no lettering at all. ' + POSTER_FACES,
  },

  // 1960s
  {
    id: 'sixties-spy', label: 'Spy thriller', blurb: 'Casino, tuxedos, painted 60s spy poster', kind: 'style',
    style: 'a painted 1960s spy thriller movie poster: tuxedos and cocktail dresses, a glamorous casino ' +
      'and a sports car behind, dramatic painted illustration in the 1960s style, bold flat colour ' +
      'shapes, no lettering at all. ' + POSTER_FACES,
  },
  {
    id: 'sixties-beat', label: 'Beat group', blurb: 'Black-and-white 60s band publicity shot', kind: 'style',
    style: 'a black-and-white 1960s pop group publicity photograph: sharp collarless suits, shift ' +
      'dresses and knee boots, a plain studio backdrop, crisp contrast, press-print grain. Style the ' +
      'existing hair into a 1960s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-space', label: 'Space race', blurb: 'Vintage astronauts, rocket on the pad', kind: 'style',
    style: 'a 1960s space programme portrait: vintage silver pressure suits with helmets held under the ' +
      'arm, a launch gantry and a rocket on the pad behind, bright 1960s colour film, no logos, flags, ' +
      'badges or lettering. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-summer-of-love', label: 'Summer of love', blurb: 'Flower crowns and psychedelic colour', kind: 'style',
    style: 'a 1967 summer of love festival photograph: flower crowns, fringe, kaftans, tinted round ' +
      'glasses only where the input already has glasses, a sunny festival field with swirling ' +
      'psychedelic colour washes, warm faded film. Style the existing hair into a 1960s shape but keep ' +
      'its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-beach', label: 'Beach party', blurb: 'Surfboards and Kodachrome sunshine', kind: 'style',
    style: 'a 1960s beach party movie still: surfboards, striped beach towels, 1960s swimwear and ' +
      'beach shirts, a bright sandy beach and turquoise sea, saturated Kodachrome colour. Style the ' +
      'existing hair into a 1960s shape but keep its colour and length. ' + DECADE_FRAMING,
  },

  // 1970s
  {
    id: 'seventies-disco', label: 'Disco night', blurb: 'Light-up floor, glitter and a mirror ball', kind: 'style',
    style: 'a 1978 disco night photograph: a light-up dance floor, a mirror ball throwing sparkles, ' +
      'sequins, halter necks, wide lapels and flares, coloured gel lighting and haze, warm 1970s film. ' +
      'Style the existing hair into a 1970s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'seventies-glam', label: 'Glam rock', blurb: 'Glitter, platforms and an album-cover glow', kind: 'style',
    style: 'a 1970s glam rock album cover photograph: glitter makeup, metallic jumpsuits, feather boas ' +
      'and platform boots, a starry backdrop with a soft glow, saturated colour, no lettering. Style the ' +
      'existing hair into a 1970s shape but keep its colour and length. ' + POSTER_FACES,
  },
  {
    id: 'seventies-cop', label: 'Cop show', blurb: 'TV title-card freeze frame, city streets', kind: 'style',
    style: 'a 1970s television cop show freeze frame: leather jackets, wide collars and aviator-free ' +
      'sunglasses only if the input has them, a gritty city street with a muscle car behind, grainy ' +
      'warm 1970s TV colour, no lettering. ' + DECADE_FRAMING,
  },
  {
    id: 'seventies-roller', label: 'Roller rink', blurb: 'Rainbow stripes and roller skates', kind: 'style',
    style: 'a 1970s roller rink photograph: rainbow stripes, knee socks, satin jackets and short shorts, ' +
      'a polished rink with coloured lights behind, warm faded 1970s film. Style the existing hair into ' +
      'a 1970s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'seventies-studio', label: 'Studio portrait', blurb: 'Soft focus, brown velvet, mottled backdrop', kind: 'style',
    style: 'a 1970s department-store studio portrait: brown and burnt-orange velvet, turtlenecks and ' +
      'wide ties, a mottled blue studio backdrop, soft-focus vignette, warm faded print. Style the ' +
      'existing hair into a 1970s shape but keep its colour and length. ' + DECADE_FRAMING,
  },

  // 1990s
  {
    id: 'nineties-sitcom', label: 'Sitcom cast', blurb: 'Bright coffee-shop set, promo photo', kind: 'style',
    style: 'a 1990s television sitcom promotional photo: a bright coffee shop set with a big sofa, ' +
      '1990s fashion such as oversized knits, denim, waistcoats and slip dresses, even studio lighting, ' +
      'glossy 1990s print, no lettering. Style the existing hair into a 1990s shape but keep its colour ' +
      'and length. ' + DECADE_FRAMING,
  },
  {
    id: 'nineties-grunge', label: 'Grunge cover', blurb: 'Flannel, moody light, album-cover grain', kind: 'style',
    style: 'a 1990s grunge album cover photograph: flannel shirts, band-free T-shirts, ripped denim and ' +
      'beanies only if the input has hats, a moody rehearsal room, muted colours, heavy grain, no ' +
      'lettering. Style the existing hair into a 1990s shape but keep its colour and length. ' + POSTER_FACES,
  },
  {
    id: 'nineties-popvideo', label: 'Pop video', blurb: 'White outfits, wind machine, fisheye', kind: 'style',
    style: 'a 1990s pop music video still: matching white and silver outfits, a white infinity studio ' +
      'with a wind machine blowing, a slight fisheye lens, glossy saturated video colour. Style the ' +
      'existing hair into a 1990s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'nineties-rave', label: 'Rave', blurb: 'UV neon, lasers and a warehouse', kind: 'style',
    style: 'a 1990s warehouse rave photograph: UV neon light, lasers cutting through haze, bucket hats ' +
      'only if the input has hats, glow sticks and bright sportswear, flash-lit film grain. Style the ' +
      'existing hair into a 1990s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'nineties-yearbook', label: 'Yearbook', blurb: 'Laser backdrop school portrait', kind: 'style',
    style: 'a 1990s school yearbook portrait: a blue laser-pattern studio backdrop, 1990s school-picture ' +
      'clothes such as polo shirts, chokers and patterned knits, soft even studio light, slightly faded ' +
      'print. Style the existing hair into a 1990s shape but keep its colour and length. ' + DECADE_FRAMING,
  },

  // 2010s
  {
    id: 'tens-hipster', label: 'Hipster café', blurb: 'Edison bulbs, mason jars, beards optional', kind: 'style',
    style: 'a 2010s hipster coffee shop photograph: Edison bulbs, exposed brick, mason jars and ' +
      'reclaimed wood, 2010s fashion such as chunky knits, braces, plaid and statement collars, a warm ' +
      'faded filter. Style the existing hair into a 2010s shape but keep its colour and length. ' +
      'Do not add beards or glasses that are not in the input. ' + DECADE_FRAMING,
  },
  {
    id: 'tens-blockbuster', label: 'Blockbuster', blurb: 'Teal-and-orange superhero poster', kind: 'style',
    style: 'a 2010s superhero blockbuster poster: sleek armoured suits with no logos or emblems, a ' +
      'city skyline and dramatic clouds behind, heavy teal-and-orange grading, lens flares, no ' +
      'lettering. ' + POSTER_FACES,
  },
  {
    id: 'tens-festival', label: 'Main stage', blurb: 'Lasers, confetti and a festival crowd', kind: 'style',
    style: 'a 2010s electronic music festival photograph: a huge main stage with lasers and confetti ' +
      'behind, a crowd with raised hands, neon paint and festival wristbands, vivid colour. Style the ' +
      'existing hair into a 2010s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'tens-rustic', label: 'Rustic wedding', blurb: 'Barn, fairy lights and bunting', kind: 'style',
    style: 'a 2010s rustic barn wedding photograph: fairy lights, hay bales, mason jars of wild flowers ' +
      'and hessian bunting, 2010s wedding-guest fashion such as floral dresses, braces and bow ties, a ' +
      'soft warm filter. Style the existing hair into a 2010s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'tens-dystopia', label: 'Dystopian epic', blurb: 'Smoky ruins, young-adult movie poster', kind: 'style',
    style: 'a 2010s dystopian young-adult movie poster: utilitarian jackets and combat boots, a smoky ' +
      'ruined city and a low sun behind, desaturated cool grading with warm highlights, no symbols, ' +
      'emblems or lettering. ' + POSTER_FACES,
  },
];

/**
 * Compose what actually gets sent. The people-count rule brackets the
 * style on both sides — see the note at the top of this file for why a
 * single trailing instruction is not enough.
 */
export function buildPrompt(effect: BoothEffect): string {
  const body = effect.caricature ? REALISTIC : `${REALISTIC} ${PROPORTIONS}`;
  return `${SAME_PEOPLE_FIRST} Now restyle the photo as ${effect.style} ` +
    `${KEEP} ${body} ${NO_NAMES} ${SAME_PEOPLE_LAST}`;
}

export function boothEffect(id: string): BoothEffect | null {
  return BOOTH_EFFECTS.find((e) => e.id === id) ?? null;
}

/** Catalogue shape handed to the guest UI — prompts stay server-side. */
export function publicEffects(): Array<Pick<BoothEffect, 'id' | 'label' | 'blurb' | 'kind'>> {
  return BOOTH_EFFECTS.map(({ id, label, blurb, kind }) => ({ id, label, blurb, kind }));
}
