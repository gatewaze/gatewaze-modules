/**
 * Where a decade happened.
 *
 * The looks are genres -- a spy thriller, a beat group, a beach -- and a
 * genre belongs to a country. Left alone the model draws the American
 * version of every one of them, which is how a wedding in Somerset ended
 * up with Jackie Kennedy bouffants and a Californian surf beach (guest
 * feedback, 2026-09-23). Rather than pick a side, the booth asks: Britain
 * or America, chosen on the decade page and remembered.
 *
 * A place is a rail appended to the look's own prompt. The look says what
 * kind of picture it is; the place says whose version of it, in the
 * detail that actually reads at a glance -- the hair, the street, the
 * car, the light. Both halves are written for the same decade, so
 * whichever a guest picks the picture is specific rather than generic.
 */

export interface BoothPlace {
  id: 'uk' | 'us';
  /** On the selector. */
  label: string;
  /** Under it. */
  blurb: string;
}

export const BOOTH_PLACES: readonly BoothPlace[] = [
  { id: 'uk', label: 'British', blurb: 'London, Brighton, the seaside' },
  { id: 'us', label: 'American', blurb: 'Hollywood, the coast, the diner' },
];

export const DEFAULT_PLACE: BoothPlace['id'] = 'uk';

export function boothPlace(id: unknown): BoothPlace['id'] {
  return id === 'us' ? 'us' : id === 'uk' ? 'uk' : DEFAULT_PLACE;
}

/**
 * The country rail, per decade. Hair leads every one of them: it is what
 * gives a decade and a country away first, and it is what guests noticed
 * was wrong.
 */
const RAILS: Record<string, { uk: string; us: string }> = {
  '1940s': {
    uk: 'Set this in wartime Britain: utility clothing, a make-do-and-mend suit, a tea dress, ' +
      'a British street or a village hall. Hair is rolled and pinned in the British wartime way -- ' +
      'victory rolls set close to the head, a headscarf turban, a neat side-parted set -- with ' +
      'natural brows and a dark matte lip.',
    us: 'Set this in 1940s America: a Hollywood studio look, a diner or a drugstore, American ' +
      'tailoring with wide shoulders. Hair is the American 1940s -- long glossy waves off the ' +
      'face, a peekaboo wave, a high pompadour roll -- with arched brows and a bright red lip.',
  },
  '1950s': {
    uk: 'Set this in 1950s Britain: a coffee bar, a dance hall, a seaside promenade; British ' +
      'tailoring, a belted day dress, a Teddy boy drape jacket. Hair is the British fifties -- ' +
      'a short curled poodle set, a neat pin-curl bob, a Tony Curtis quiff for men -- and ' +
      'make-up is restrained with a soft red lip.',
    us: 'Set this in 1950s America: chrome diners, a drive-in, a pastel American car, full ' +
      'circle skirts and letterman jackets. Hair is the American fifties -- a big bouffant ' +
      'poodle cut, a high ponytail with a scarf, a greaser pompadour -- with winged liner and ' +
      'a bright red lip.',
  },
  '1960s': {
    uk: 'Set this in Swinging London: Carnaby Street and the King\'s Road, Mary Quant shift ' +
      'dresses and pinafores, white go-go boots, slim British tailoring, a Brighton promenade ' +
      'or a London pop television studio rather than anywhere American. Hair is 1960s London -- ' +
      'a sharp geometric Vidal Sassoon bob with a blunt heavy fringe, a five-point cut, a gamine ' +
      'crop, or hair backcombed high into a beehive with a hairband; men have a mop-top. Heavy ' +
      'black eyeliner with a drawn socket crease and pale lips. Never the American sixties: no ' +
      'soft flipped-out Jackie bouffant, no beachy waves, no big soft curls.',
    us: 'Set this in 1960s America: Palm Springs and the California coast, a muscle car, a ' +
      'sorority sweater or a shift dress from an American department store. Hair is the American ' +
      'sixties -- a flipped-out bouffant, a teased half-up bow, long sun-bleached surf hair -- ' +
      'with winged liner and frosted pink lips.',
  },
  '1970s': {
    uk: 'Set this in 1970s Britain: a brown-and-orange front room, a pub, a British nightclub, ' +
      'wide-lapel suits and maxi dresses in brown, mustard and burnt orange. Hair is the British ' +
      'seventies -- a shaggy feather cut, a centre-parted flick, sideburns and a moustache on ' +
      'the men -- with brown and bronze make-up.',
    us: 'Set this in 1970s America: a Californian disco or a sunlit canyon, denim, halter ' +
      'dresses and wide collars in tan and gold. Hair is the American seventies -- big feathered ' +
      'wings off the face, long centre-parted glossy hair, a blow-dried bouffant on the men -- ' +
      'with bronzer and glossy lips.',
  },
  '1980s': {
    uk: 'Set this in 1980s Britain: a New Romantic club, a high street, a British sitcom living ' +
      'room; shoulder pads, pussy-bow blouses, shell suits and pixie boots. Hair is the British ' +
      'eighties -- a crimped bob, a spiky New Romantic cut, a short back and sides with a long ' +
      'fringe -- with blue eyeshadow and a bold blusher stripe.',
    us: 'Set this in 1980s America: a mall, a Miami balcony, a neon aerobics studio; pastel ' +
      'blazers with rolled sleeves, leg warmers, varsity jackets. Hair is the American ' +
      'eighties -- enormous permed volume, a teased side ponytail, a feathered mullet -- with ' +
      'bright eyeshadow and heavy blusher.',
  },
  '1990s': {
    uk: 'Set this in 1990s Britain: a Britpop indie club, a terraced street, a rainy high ' +
      'street; parkas, football shirts, slip dresses and Kickers. Hair is the British ' +
      'nineties -- a curtains cut on the men, a choppy bob or crimped waves with butterfly ' +
      'clips -- with brown lipstick and thin brows.',
    us: 'Set this in 1990s America: a mall food court, a high-school corridor, a sunny suburb; ' +
      'flannel shirts, baggy jeans, cropped tops and windbreakers. Hair is the American ' +
      'nineties -- layered Rachel-style flicks, frosted tips, a high scrunchie ponytail -- ' +
      'with lip liner and thin brows.',
  },
  '2000s': {
    uk: 'Set this in 2000s Britain: a British nightclub or a shopping centre, bootcut jeans, ' +
      'going-out tops, tracksuits and pointed boots. Hair is the British noughties -- poker-' +
      'straight GHD hair with a side fringe, chunky highlights, spiked gelled hair on the men -- ' +
      'with lip gloss and pencil-thin brows.',
    us: 'Set this in 2000s America: a red carpet or a Californian mall, low-rise jeans, velour ' +
      'tracksuits, trucker caps. Hair is the American noughties -- long layered blonde ' +
      'highlights, a side-swept fringe, frosted spikes on the men -- with heavy gloss and ' +
      'bronzer.',
  },
  '2010s': {
    uk: 'Set this in 2010s Britain: an East London bar, a festival field, a Sunday pub; ' +
      'skinny jeans, a Breton top, a beanie, a tote bag. Hair is the British twenty-tens -- an ' +
      'undercut or a quiff on the men, a topknot or an ombre lob on the women -- with strong ' +
      'brows and a matte nude lip.',
    us: 'Set this in 2010s America: a rooftop bar or a Californian coffee shop, athleisure, ' +
      'plaid shirts, a snapback. Hair is the American twenty-tens -- beach waves and balayage, ' +
      'a high messy bun, a fade with a hard part on the men -- with contoured cheeks and a ' +
      'matte lip.',
  },
  '2020s': {
    uk: 'Set this in 2020s Britain: a British city street or a garden gathering, tailored ' +
      'trousers, a knitted vest, chunky trainers. Hair is current British styling -- a curtain ' +
      'fringe, a wolf cut, a low bun, a textured crop on the men -- with fluffy brows and a ' +
      'glossy lip.',
    us: 'Set this in 2020s America: a sunlit American street or a loft party, oversized ' +
      'tailoring, sneakers, a slick minimal look. Hair is current American styling -- a glossy ' +
      'blowout, a slicked-back bun, long layers, a taper fade on the men -- with sculpted brows ' +
      'and a glossy lip.',
  },
};

/**
 * The rail for a decade in a place, or an empty string where a look sits
 * outside the decades entirely (the reference-face effects) or the
 * decade has no rail written for it.
 */
export function placeRail(decade: string | null | undefined, place: BoothPlace['id']): string {
  if (!decade) return '';
  const r = RAILS[decade];
  return r ? r[place] : '';
}
