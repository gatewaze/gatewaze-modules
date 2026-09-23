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
      'a 1960s mod fashion photograph: 1960s clothing such as shift dresses and pinafores in bold ' +
      'op-art and colour-block patterns, go-go boots, slim tailored suits and polo necks, a bright ' +
      'pop-art studio backdrop, crisp 1960s colour film with slightly faded tones. ' + DECADE_FRAMING,
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
    style: 'a painted 1960s spy thriller movie poster: dinner jackets and cocktail dresses, a glamorous ' +
      'casino and a sports car behind, dramatic painted illustration in the 1960s style, bold flat ' +
      'colour shapes, no lettering at all. ' + POSTER_FACES,
  },
  {
    id: 'sixties-beat', label: 'Beat group', blurb: 'Black-and-white 60s band publicity shot', kind: 'style',
    style: 'a black-and-white 1964 pop group publicity photograph: sharp collarless jackets, ankle ' +
      'boots, shift dresses and knee-high boots, the plain backdrop of a pop television studio, ' +
      'crisp contrast, press-print grain. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-space', label: 'Space race', blurb: 'Vintage astronauts, rocket on the pad', kind: 'style',
    style: 'a 1960s space programme portrait: vintage silver pressure suits with helmets held under the ' +
      'arm, a launch gantry and a rocket on the pad behind, bright 1960s colour film, no logos, flags, ' +
      'badges or lettering. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-summer-of-love', label: 'Summer of love', blurb: 'Kaftans, paisley and painted swirls', kind: 'style',
    style: 'a 1967 psychedelia photograph: kaftans, braided military jackets, paisley and velvet, ' +
      'tinted round glasses only where the input already has glasses, an outdoor be-in behind with ' +
      'swirling psychedelic colour washes, warm faded film. This is 1967, before the look softened ' +
      'into the 1970s: no feathered layers, no shaggy perms. ' + DECADE_FRAMING,
  },
  {
    id: 'sixties-beach', label: 'Down the coast', blurb: 'Seafront, scooters and sunshine', kind: 'style',
    style: 'a 1960s seaside photograph: a busy beach and a promenade behind, 1960s swimwear, sharp ' +
      'summer clothes and a parked scooter, saturated period colour film. ' + DECADE_FRAMING,
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

  // 1940s
  {
    id: 'decade-1940s', label: 'Victory dance', blurb: 'Big band, dance hall, victory rolls', kind: 'style',
    style: 'a 1940s dance hall photograph: 1940s fashion such as tea dresses, victory-roll hair, high-waisted ' +
      'trousers, braces and wide ties, a big band on a bunting-hung stage behind, warm tungsten light, ' +
      'faded 1940s colour film. Style the existing hair into a 1940s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'forties-noir', label: 'Film noir', blurb: 'Venetian-blind shadows, black and white', kind: 'style',
    style: 'a 1940s film noir still in black and white: trench coats, fedoras only if the input has hats, ' +
      'satin blouses, hard low-key light through venetian blinds throwing striped shadows, cigarette-free ' +
      'smoky haze, deep blacks. Style the existing hair into a 1940s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'forties-technicolor', label: 'Technicolor star', blurb: 'Studio glamour in saturated colour', kind: 'style',
    style: 'a 1940s Technicolor studio star portrait: glamorous 1940s evening wear, rich saturated three-strip ' +
      'Technicolor colour, a painted studio backdrop, soft diffused key light, glossy finish. Style the ' +
      'existing hair into a 1940s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'forties-swing', label: 'Swing time', blurb: 'Jitterbug club, brass and spotlights', kind: 'style',
    style: 'a 1940s swing club photograph: people mid-dance in a jitterbug club, 1940s dance clothes such ' +
      'as swing skirts, saddle shoes and zoot-free suits, a brass section and spotlights behind, black ' +
      'and white press-camera flash. Style the existing hair into a 1940s shape but keep its colour and ' +
      'length. ' + DECADE_FRAMING,
  },
  {
    id: 'forties-travel-poster', label: 'Travel poster', blurb: 'Painted seaside travel poster', kind: 'style',
    style: 'a painted 1940s seaside travel poster: flat gouache illustration, a sunny promenade, striped ' +
      'deckchairs and a pier behind, 1940s holiday clothes, limited poster palette, lithograph texture, no ' +
      'lettering at all. ' + POSTER_FACES,
  },
  {
    id: 'forties-cafe', label: 'Café society', blurb: 'Parisian street café, sepia tones', kind: 'style',
    style: 'a 1940s Parisian street café photograph: little round tables, bicycles and a striped awning, ' +
      '1940s coats, berets only if the input has hats, soft sepia-toned print. Style the existing hair into ' +
      'a 1940s shape but keep its colour and length. ' + DECADE_FRAMING,
  },

  // 2000s
  {
    id: 'decade-2000s', label: 'Digicam flash', blurb: 'Compact camera, harsh flash, low-rise denim', kind: 'style',
    style: 'a 2000s compact digital camera snapshot: 2000s fashion such as low-rise jeans, trucker jackets, ' +
      'layered tank tops and chunky belts, harsh built-in flash, slightly blown highlights, early digital ' +
      'noise and cool colour. Style the existing hair into a 2000s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'noughties-popstar', label: 'Pop star', blurb: 'Glossy album cover, metallic and frosted', kind: 'style',
    style: 'a 2000s pop album cover photograph: metallic and pastel outfits, butterfly clips only in long ' +
      'hair, a glossy white studio with a soft glow, heavy airbrushed retouching look, no lettering. Style ' +
      'the existing hair into a 2000s shape but keep its colour and length. ' + POSTER_FACES,
  },
  {
    id: 'noughties-teen-movie', label: 'Teen movie', blurb: 'High-school comedy poster, bright sky', kind: 'style',
    style: 'a 2000s teen comedy movie poster: bright blue sky, a high-school lawn and lockers behind, 2000s ' +
      'teen fashion such as hoodies, cargo trousers and layered tops, punchy saturated colour, no ' +
      'lettering at all. ' + POSTER_FACES,
  },
  {
    id: 'noughties-red-carpet', label: 'Red carpet', blurb: 'Paparazzi flashes, premiere night', kind: 'style',
    style: 'a 2000s red carpet premiere photograph: a step-and-repeat wall with no logos or lettering, ' +
      'paparazzi flashes going off, 2000s evening wear such as slip dresses and velvet blazers, crisp ' +
      'flash-lit digital photo. Style the existing hair into a 2000s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'noughties-club', label: 'Club night', blurb: 'Velvet rope, bling and purple haze', kind: 'style',
    style: 'a 2000s R&B club night photograph: a velvet rope and purple and blue club lights behind, 2000s ' +
      'going-out clothes such as satin shirts, halter tops and chunky jewellery, flash and haze. Style the ' +
      'existing hair into a 2000s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'noughties-webcam', label: 'Webcam era', blurb: 'Bedroom webcam, fairy lights, low-res', kind: 'style',
    style: 'a 2000s bedroom webcam photo: fairy lights and band-free posters on the wall behind, 2000s ' +
      'hoodies and graphic tees, low-resolution webcam colour with a slight blur, soft screen glow, no ' +
      'interface or text. Style the existing hair into a 2000s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },

  // 2020s
  {
    id: 'decade-2020s', label: 'Portrait mode', blurb: 'Golden hour, creamy background blur', kind: 'style',
    style: 'a 2020s smartphone portrait-mode photograph: golden-hour light, creamy background blur of a city ' +
      'park, 2020s fashion such as oversized blazers, knitwear and wide-leg trousers, clean natural colour. ' +
      'Style the existing hair into a 2020s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'twenties-neon-city', label: 'Neon city', blurb: 'Rainy night street, neon reflections', kind: 'style',
    style: 'a 2020s night-time city street photograph: rain-wet pavement reflecting neon signs with no ' +
      'readable lettering, teal and magenta colour grade, 2020s streetwear such as puffer jackets and ' +
      'technical coats, cinematic shallow focus. ' + DECADE_FRAMING,
  },
  {
    id: 'twenties-film-camera', label: '35mm revival', blurb: 'Grainy film camera, warm and soft', kind: 'style',
    style: 'a 2020s 35mm film camera photograph: warm Portra-style colour, soft grain, gentle halation around ' +
      'highlights, a sunny beach or park behind, relaxed 2020s clothes such as linen shirts and knit vests. ' +
      'Style the existing hair into a 2020s shape but keep its colour and length. ' + DECADE_FRAMING,
  },
  {
    id: 'twenties-prestige-drama', label: 'Prestige drama', blurb: 'Moody streaming-series key art', kind: 'style',
    style: 'a 2020s prestige streaming drama key art photograph: moody dark backdrop, dramatic side light, ' +
      'muted teal and amber grade, tailored dark clothing, no lettering, logos or symbols. ' + POSTER_FACES,
  },
  {
    id: 'twenties-streetwear', label: 'Streetwear', blurb: 'Lookbook shoot, pastel studio', kind: 'style',
    style: 'a 2020s streetwear lookbook photograph: a pastel colour-block studio set, 2020s streetwear such ' +
      'as oversized hoodies, cargo trousers, bucket hats only if the input has hats and chunky trainers, ' +
      'crisp even light. Style the existing hair into a 2020s shape but keep its colour and length. ' +
      DECADE_FRAMING,
  },
  {
    id: 'twenties-garden-party', label: 'Garden party', blurb: 'Fairy lights, meadow flowers, dusk', kind: 'style',
    style: 'a 2020s garden party photograph at dusk: festoon lights, meadow flowers and a long table behind, ' +
      '2020s summer wedding-guest fashion such as floral midi dresses and relaxed linen suits, soft warm ' +
      'light. Style the existing hair into a 2020s shape but keep its colour and length. ' + DECADE_FRAMING,
  },

  // ── America ────────────────────────────────────────────────────
  // The same decades as the country next door remembers them. A guest
  // picks British or American at the bottom of the decade page and the
  // whole board changes (asked 2026-09-23); lib/booth-eras.ts decides
  // which six belong to which decade and place.
  {
    id: 'us-decade-1940s', label: 'Forties America', blurb: 'Studio glamour and big-band nights', kind: 'style',
    style: 'a 1940s American glamour photograph: Hollywood studio lighting, wide-shouldered suits and satin gowns, a supper-club backdrop, warm silver-screen tones. ' + DECADE_FRAMING,
  },
  {
    id: 'us-forties-pinup', label: 'Pin-up', blurb: 'Painted nose-art pin-up', kind: 'style',
    style: 'a painted 1940s American pin-up illustration: bright flat colour, a cheerful posed figure, polka dots and high-waisted swimwear, an aircraft nose-art style background, no lettering at all. ' + DECADE_FRAMING,
  },
  {
    id: 'us-forties-silverscreen', label: 'Silver screen', blurb: 'Black-and-white star portrait', kind: 'style',
    style: 'a black-and-white 1940s Hollywood studio portrait: dramatic side lighting, a soft glow, tailored evening wear, a plain grey studio backdrop, fine silver-gelatin grain. ' + DECADE_FRAMING,
  },
  {
    id: 'us-forties-soda', label: 'Soda fountain', blurb: 'Malt shop stools and sundaes', kind: 'style',
    style: 'a 1940s American soda fountain photograph: chrome stools, a marble counter, tall sundae glasses, varsity sweaters and day dresses, warm colour film. ' + DECADE_FRAMING,
  },
  {
    id: 'us-forties-usostage', label: 'Big band', blurb: 'Brass section and a swing stage', kind: 'style',
    style: 'a 1940s American big-band stage photograph: a bandstand with brass instruments and music stands, dance-hall couples mid-swing, warm stage light, period colour film. ' + DECADE_FRAMING,
  },
  {
    id: 'us-forties-route66', label: 'Route 66', blurb: 'Desert highway and a chrome car', kind: 'style',
    style: 'a 1940s American road trip photograph: a chrome-grilled car on a desert highway, red rock country behind, travel clothes and sunglasses, saturated period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-1950s', label: 'Fifties America', blurb: 'Chrome, pastels and picket fences', kind: 'style',
    style: 'a 1950s American photograph: pastel colours, full circle skirts and letterman jackets, a chrome-trimmed setting, bright saturated Kodachrome colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-fifties-diner', label: 'Chrome diner', blurb: 'Booths, jukebox and milkshakes', kind: 'style',
    style: 'a 1950s American diner photograph: red vinyl booths, a jukebox, milkshakes and chrome trim, waitress uniforms and rolled jeans, saturated Kodachrome colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-fifties-drivein-us', label: 'Drive-in', blurb: 'Tail fins and a lit-up screen', kind: 'style',
    style: 'a 1950s American drive-in movie photograph: a finned car in the foreground, a glowing screen behind, blankets and popcorn, deep night colour with a warm glow. ' + DECADE_FRAMING,
  },
  {
    id: 'us-fifties-rocknroll-us', label: 'Rock and roll', blurb: 'Quiffs, record hop, stage lights', kind: 'style',
    style: 'a 1950s American rock and roll record-hop photograph: a stage with a microphone stand, quiffs and poodle skirts, dancers behind, high-contrast period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-fifties-suburbia', label: 'Backyard barbecue', blurb: 'Picket fence and a station wagon', kind: 'style',
    style: 'a 1950s American suburban backyard photograph: a picket fence, a barbecue and a station wagon on the drive, aprons and short-sleeved shirts, bright cheerful colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-fifties-hotrod', label: 'Hot rod', blurb: 'Flames, chrome and a drag strip', kind: 'style',
    style: 'a 1950s American hot rod photograph: a flame-painted coupe at a drag strip, oil-stained overalls and cuffed jeans, dust and heat haze, saturated period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-1960s', label: 'Sixties America', blurb: 'Shift dresses and muscle cars', kind: 'style',
    style: 'a 1960s American photograph: a shift dress or a sharp narrow suit, a muscle car and a sunlit street behind, bright optimistic colour film of the period. ' + DECADE_FRAMING,
  },
  {
    id: 'us-sixties-madison', label: 'Madison Avenue', blurb: 'Office glamour and old fashioneds', kind: 'style',
    style: 'a 1960s American advertising-office photograph: wood-panelled walls, a drinks trolley, narrow ties and sheath dresses, cigarette smoke and warm lamplight. ' + DECADE_FRAMING,
  },
  {
    id: 'us-sixties-surf', label: 'Surf party', blurb: 'Boards, sand and Kodachrome sun', kind: 'style',
    style: 'a 1960s American beach party photograph: surfboards, striped towels, period swimwear, a bright sandy beach and turquoise Pacific behind, saturated Kodachrome colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-sixties-motown', label: 'Motown revue', blurb: 'Sequins, a revue stage, brass', kind: 'style',
    style: 'a 1960s American soul revue photograph: matching sequinned stage outfits, a microphone and a brass section behind, warm stage lighting, rich period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-sixties-woodstock', label: 'Woodstock', blurb: 'Festival field and painted swirls', kind: 'style',
    style: 'a 1969 American music festival photograph: a muddy field and a distant stage, fringed suede, denim and beads, swirling psychedelic colour washes, warm faded film. ' + DECADE_FRAMING,
  },
  {
    id: 'us-sixties-cape', label: 'Cape Canaveral', blurb: 'Silver suits and a launch gantry', kind: 'style',
    style: 'a 1960s American space programme portrait: silver pressure suits with helmets under the arm, a launch gantry and a rocket behind, bright period colour, no logos, flags, badges or lettering. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-1970s', label: 'Seventies America', blurb: 'Tan, gold and wide collars', kind: 'style',
    style: 'a 1970s American photograph: wide collars, denim and halter dresses in tan, gold and brown, a sunlit street or a wood-panelled room, warm faded film. ' + DECADE_FRAMING,
  },
  {
    id: 'us-seventies-studio', label: 'Studio disco', blurb: 'Mirror ball and a velvet rope', kind: 'style',
    style: 'a 1970s American disco photograph: a mirror ball, a crowded dance floor and a velvet rope, sequins, satin and platform shoes, glittering warm light. ' + DECADE_FRAMING,
  },
  {
    id: 'us-seventies-van', label: 'Road trip', blurb: 'Painted van and a canyon road', kind: 'style',
    style: 'a 1970s American road trip photograph: a painted camper van on a canyon road, flared jeans and sunglasses, dust and golden late light, warm faded colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-seventies-copshow', label: 'Cop show', blurb: 'Moustaches and a muscle car', kind: 'style',
    style: 'a 1970s American police drama still: a brown leather jacket and aviator sunglasses, a muscle car at a city kerb, grainy warm film, dramatic low sun. ' + DECADE_FRAMING,
  },
  {
    id: 'us-seventies-rollerdisco', label: 'Roller disco', blurb: 'Tube socks and a rink', kind: 'style',
    style: 'a 1970s American roller disco photograph: a wooden rink under coloured lights, satin shorts, tube socks and quad skates, motion and glitter. ' + DECADE_FRAMING,
  },
  {
    id: 'us-seventies-rodeo', label: 'Rodeo', blurb: 'Fringe, denim and a dusty arena', kind: 'style',
    style: 'a 1970s American rodeo photograph: a dusty arena and a wooden fence, denim, fringe, a belt buckle and a felt hat, hot dusty light, warm period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-1980s', label: 'Eighties America', blurb: 'Neon, pastels and big hair', kind: 'style',
    style: 'a 1980s American photograph: pastel blazers with rolled sleeves, neon accents and a mall or a lit street behind, bright flash-lit period colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-eighties-mall', label: 'Mall rats', blurb: 'Food court, fountain, high tops', kind: 'style',
    style: 'a 1980s American shopping mall photograph: a tiled fountain and neon shop signs, acid-wash denim and high-top trainers, flash-lit bright colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-eighties-miami', label: 'Miami nights', blurb: 'Pastel suits and a neon strip', kind: 'style',
    style: 'a 1980s Miami photograph: pastel linen suits with rolled sleeves, palm trees and neon hotel signs, a convertible on a night strip, saturated neon colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-eighties-prom', label: 'Senior prom', blurb: 'Taffeta, corsages and a balloon arch', kind: 'style',
    style: 'a 1980s American high-school prom photograph: a balloon arch and a glittery backdrop, taffeta gowns, corsages and rented tuxedos, flash-lit studio colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-eighties-aerobics', label: 'Aerobics', blurb: 'Leotards, leg warmers, neon studio', kind: 'style',
    style: 'a 1980s American aerobics photograph: a mirrored studio with neon lines, leotards, headbands and leg warmers, bright flash-lit colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-eighties-arcade', label: 'Arcade', blurb: 'Cabinet glow and quarters', kind: 'style',
    style: 'a 1980s American arcade photograph: rows of glowing cabinets in a dark room, denim jackets and slogan tees, coloured screen light on faces. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-1990s', label: 'Nineties America', blurb: 'Flannel, denim and a mall photo', kind: 'style',
    style: 'a 1990s American photograph: flannel shirts, baggy jeans and cropped tops, a suburban street or mall behind, slightly soft point-and-shoot colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-nineties-sitcom-us', label: 'Sitcom', blurb: 'Studio apartment and a laugh track', kind: 'style',
    style: 'a 1990s American sitcom still: a warm studio-lit apartment set with a big sofa, casual nineties clothes, flat television lighting, period video colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-nineties-seattle', label: 'Seattle grunge', blurb: 'Flannel, rain and a club', kind: 'style',
    style: 'a 1990s American grunge photograph: a dark club or a rainy street, flannel over band tees, ripped jeans and boots, desaturated grainy film. ' + DECADE_FRAMING,
  },
  {
    id: 'us-nineties-hiphop', label: 'Hip hop video', blurb: 'Gold, tracksuits and a block party', kind: 'style',
    style: 'a 1990s American hip hop video still: a city block party, tracksuits, bucket hats and chunky chains, a wide-angle camcorder look with strong colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-nineties-yearbook-us', label: 'Yearbook', blurb: 'Laser backdrop and a stiff smile', kind: 'style',
    style: 'a 1990s American school yearbook portrait: a mottled blue studio backdrop or a laser-beam background, a polo shirt or a knitted cardigan, hard flash, slightly soft focus. ' + DECADE_FRAMING,
  },
  {
    id: 'us-nineties-camp', label: 'Summer camp', blurb: 'Lake, canoes and matching tees', kind: 'style',
    style: 'a 1990s American summer camp photograph: a lake and canoes behind, matching camp tee shirts and friendship bracelets, bright sunny point-and-shoot colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-2000s', label: 'Noughties America', blurb: 'Low-rise, velour and flash', kind: 'style',
    style: 'a 2000s American photograph: low-rise jeans, velour tracksuits and trucker caps, a mall or a parking lot behind, harsh digital flash and slight over-sharpening. ' + DECADE_FRAMING,
  },
  {
    id: 'us-noughties-mtv', label: 'Music channel', blurb: 'Mansion, bling and a camcorder', kind: 'style',
    style: 'a 2000s American music-channel still: a glossy mansion interior, designer tracksuits and sunglasses indoors, chunky jewellery, wide-angle camcorder look. ' + DECADE_FRAMING,
  },
  {
    id: 'us-noughties-teenpop', label: 'Teen pop', blurb: 'Stage pyro and a headset mic', kind: 'style',
    style: 'a 2000s American pop concert photograph: a stage with pyrotechnics and a headset microphone, low-rise trousers and crop tops, hard stage lighting, digital colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-noughties-redcarpet-us', label: 'Red carpet', blurb: 'Step and repeat, flashbulbs', kind: 'style',
    style: 'a 2000s American red carpet photograph: a step-and-repeat wall with no readable lettering, gowns and dark suits, a wall of camera flashes, hard flash-lit colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-noughties-teenmovie', label: 'Teen movie', blurb: 'Lockers, letterman, lunch trays', kind: 'style',
    style: 'a 2000s American teen movie still: a high-school corridor of lockers or a cafeteria, letterman jackets and layered tees, bright glossy film colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-noughties-webcam-us', label: 'Webcam', blurb: 'Low-res, bedroom, mirror shot', kind: 'style',
    style: 'a 2000s American webcam photograph: a bedroom with posters, a low-resolution grainy webcam look, flash in a mirror, hoodies and side-swept fringes. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-2010s', label: 'Twenty-tens America', blurb: 'Brunch, plaid and a filter', kind: 'style',
    style: 'a 2010s American photograph: plaid shirts, athleisure and a snapback, a coffee shop or a sunny street behind, a warm filtered phone-camera look. ' + DECADE_FRAMING,
  },
  {
    id: 'us-tens-coachella', label: 'Desert festival', blurb: 'Flower crowns and a ferris wheel', kind: 'style',
    style: 'a 2010s American desert festival photograph: a ferris wheel and palms behind, fringed kimonos, cut-offs and flower crowns, hazy golden light. ' + DECADE_FRAMING,
  },
  {
    id: 'us-tens-brooklyn', label: 'Loft party', blurb: 'Exposed brick and string lights', kind: 'style',
    style: 'a 2010s American loft party photograph: exposed brick, string lights and a record player, beards, denim jackets and slogan tees, warm low light. ' + DECADE_FRAMING,
  },
  {
    id: 'us-tens-superhero', label: 'Superhero', blurb: 'City skyline and a hero stance', kind: 'style',
    style: 'a 2010s American superhero film still: a city skyline at dusk, sleek textured costumes with no logos or lettering, dramatic rim lighting, cinematic teal and orange. ' + DECADE_FRAMING,
  },
  {
    id: 'us-tens-bigsur', label: 'Coast road', blurb: 'Cliffs, a convertible and fog', kind: 'style',
    style: 'a 2010s American coastal road trip photograph: cliffs, fog and a convertible on a coast road, denim and sunglasses, crisp cinematic colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-tens-brunch', label: 'Brunch', blurb: 'Pancakes, mimosas and marble', kind: 'style',
    style: 'a 2010s American brunch photograph: a marble table with pancakes and mimosas, bright airy daylight, casual smart clothes, clean crisp digital colour. ' + DECADE_FRAMING,
  },
  {
    id: 'us-decade-2020s', label: 'Twenties America', blurb: 'Clean tailoring and portrait mode', kind: 'style',
    style: 'a 2020s American photograph: oversized tailoring and trainers, a sunlit street or a bright interior, clean modern phone-portrait look with soft background blur. ' + DECADE_FRAMING,
  },
  {
    id: 'us-twenties-rooftop', label: 'Rooftop', blurb: 'City lights and a warm night', kind: 'style',
    style: 'a 2020s American rooftop photograph: string lights and a lit city skyline behind, smart casual modern clothes, warm night colour with soft bokeh. ' + DECADE_FRAMING,
  },
  {
    id: 'us-twenties-film', label: 'Film revival', blurb: '35mm grain and flash', kind: 'style',
    style: 'a 2020s photograph taken on 35mm film with an on-camera flash: slight grain, soft halation on highlights, natural skin tones, a candid party moment. ' + DECADE_FRAMING,
  },
  {
    id: 'us-twenties-prestige', label: 'Prestige drama', blurb: 'Moody light and shallow focus', kind: 'style',
    style: 'a still from a 2020s American prestige television drama: moody directional lighting, muted colour grading, shallow focus, restrained modern clothes. ' + DECADE_FRAMING,
  },
  {
    id: 'us-twenties-street', label: 'Streetwear', blurb: 'Clean lines and a concrete wall', kind: 'style',
    style: 'a 2020s American streetwear photograph: a plain concrete wall, oversized layers and box-fresh trainers, crisp daylight, no logos or lettering. ' + DECADE_FRAMING,
  },
  {
    id: 'us-twenties-desert', label: 'Desert party', blurb: 'Long shadows and warm dust', kind: 'style',
    style: 'a 2020s American desert gathering photograph: sand, long shadows and a low sun, linen and sunglasses, warm dusty colour. ' + DECADE_FRAMING,
  },
];

/**
 * Compose what actually gets sent. The people-count rule brackets the
 * style on both sides — see the note at the top of this file for why a
 * single trailing instruction is not enough.
 */
/**
 * The pose is the point.
 *
 * Without this, a model handed "restyle as a 1940s noir portrait" will
 * quietly tidy everyone into a neat row facing the lens -- which throws
 * away the one thing the guests actually did. Said twice, before and
 * after the style, because the instructions at the ends of a prompt are
 * the ones that survive.
 */
const POSE_KEEP = (pose: string) =>
  `The people are ${pose}. This pose is the subject of the picture: keep it exactly -- ` +
  'the same gestures, the same arms and hands, who is where, who is touching whom, ' +
  'the same expressions and where each person is looking. Do not straighten them up, ' +
  'do not turn them to face the camera, and do not rearrange them into a tidy group.';

export function buildPrompt(effect: BoothEffect, pose?: string | null, place?: string | null): string {
  const body = effect.caricature ? REALISTIC : `${REALISTIC} ${PROPORTIONS}`;
  const keepPose = pose ? ` ${POSE_KEEP(pose)}` : '';
  // Which country's version of this look (lib/booth-places.ts). Handed in
  // rather than looked up, so the decades and the effects stay apart.
  const where = place ? ` ${place}` : '';
  return `${SAME_PEOPLE_FIRST}${keepPose} Now restyle the photo as ${effect.style}${where} ` +
    `${KEEP} ${body} ${NO_NAMES}${keepPose} ${SAME_PEOPLE_LAST}`;
}

/**
 * The prompt for a look's EXAMPLE picture: not a guest's photo restyled,
 * but the event's key people made fresh from their reference photos, so
 * every sample in the booth shows them. Same guard rails as a guest's
 * picture, with the people counted and named from the references.
 */
export function buildSamplePrompt(
  effect: BoothEffect,
  people: ReadonlyArray<{ name: string; photos: number }>,
  /** Whose version of the decade (lib/booth-places.ts). */
  place?: string | null,
): string {
  const n = people.length;
  let first = 1;
  const who = people.map((p) => {
    const span = p.photos > 1 ? `images ${first} to ${first + p.photos - 1} show` : `image ${first} shows`;
    first += p.photos;
    return `${span} ${p.name}`;
  }).join('; ');
  const count = n === 1 ? 'exactly one person' : `exactly ${n} people`;
  const body = effect.caricature ? REALISTIC : `${REALISTIC} ${PROPORTIONS}`;
  return `These are reference photos: ${who}. CRITICAL RULE: create one new photograph showing ${count}, ` +
    `${n === 1 ? 'that person' : 'these people together'}, and no one else. ` +
    `Make it ${effect.style}${place ? ` ${place}` : ''} Frame them from about the waist up, facing the camera, close enough that ` +
    `every face is large and clear. Keep each person's exact face, features, skin tone, eyeglasses and ` +
    `identity from their reference photos. Do not beautify them. Photorealistic. ${body} ${NO_NAMES} ` +
    `Reminder: ${count} in the picture, each exactly as in their references.`;
}

export function boothEffect(id: string): BoothEffect | null {
  return BOOTH_EFFECTS.find((e) => e.id === id) ?? null;
}

/** Catalogue shape handed to the guest UI — prompts stay server-side. */
export function publicEffects(): Array<Pick<BoothEffect, 'id' | 'label' | 'blurb' | 'kind'>> {
  return BOOTH_EFFECTS.map(({ id, label, blurb, kind }) => ({ id, label, blurb, kind }));
}
