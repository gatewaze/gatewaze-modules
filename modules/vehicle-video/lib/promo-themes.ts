/**
 * Promo theme registry — the ORCHESTRATION of each self-aware, high-energy social
 * promo: which Kling shots to generate (seed angle + duration), the fast-cut edit
 * structure (which shot, in/out, which caption slot), and the cinematic grade.
 *
 * IMPORTANT: this file holds NO prompt text and NO caption copy. All model-facing
 * wording (Kling shot prompts, captions, title-card) lives in git — one skill per
 * theme (`vehicle-video-promo-<id>`) in danthebaker/agents — resolved at runtime
 * by lib/promo-content.ts so it can be edited without a redeploy. The FALLBACK_
 * CONTENT below is a thin emergency net only (git is always authoritative), used
 * if the theme skill can't be resolved. Prompt placeholders: {CAR} {PLATE}.
 */

import type { PromoContent } from './promo-content.js';

export type ShotSeconds = 5 | 10 | 15;
export type SourceAngle = 'front' | 'side' | 'rear';

export interface PromoShot {
  key: string;
  duration: ShotSeconds;
  sourceAngle: SourceAngle;
  negativeExtra?: string;
}
export interface EditSegment {
  shotKey: string;
  in: number;
  duration: number;
  captionKey?: string;
}
export interface PromoTheme {
  id: string;
  title: string;
  description: string;
  bestFor?: string;
  shots: PromoShot[];
  edit: EditSegment[];
  grade: string;
}

const RITCHIE_GRADE =
  'eq=contrast=1.22:saturation=1.42:gamma=0.93,colorbalance=rs=-0.06:bs=0.06:rm=0.05:bm=-0.03:rh=0.06:bh=-0.06';
const CLEAN_GRADE = 'eq=contrast=1.08:saturation=1.15:gamma=0.98';

// ── Structure (orchestration only — no prompt/caption text) ───────────────────
const GETAWAY_POLICE: PromoTheme = {
  id: 'getaway-police',
  title: 'The Getaway (police chase)',
  description: 'A young driver does a wheelspin getaway; a 1980s Rover police car runs them down and cuts in. Punchline: the deal is a steal.',
  bestFor: 'Broad, cheeky social reach; performance/character cars.',
  shots: [
    { key: 'getaway', sourceAngle: 'front', duration: 10, negativeExtra: 'modern police car, SUV police car, empty driver seat, no driver' },
    { key: 'drive', sourceAngle: 'front', duration: 10 },
    { key: 'passby', sourceAngle: 'front', duration: 15 },
  ],
  edit: [
    { shotKey: 'getaway', in: 1.4, duration: 1.3, captionKey: 'getaway' },
    { shotKey: 'drive', in: 5.8, duration: 0.8 },
    { shotKey: 'passby', in: 7.4, duration: 1.0, captionKey: 'onrun' },
    { shotKey: 'getaway', in: 4.6, duration: 1.1, captionKey: 'law' },
    { shotKey: 'drive', in: 8.6, duration: 0.7 },
    { shotKey: 'getaway', in: 7.6, duration: 1.4, captionKey: 'nicked' },
  ],
  grade: RITCHIE_GRADE,
};

const F1_SHOWDOWN: PromoTheme = {
  id: 'f1-showdown',
  title: 'F1 Showdown',
  description: 'The car powers onto a race circuit and goes wheel-to-wheel with Formula One cars. The star of the show.',
  bestFor: 'Any car — leans fully into the spectacle.',
  shots: [
    { key: 'race', sourceAngle: 'front', duration: 10 },
    { key: 'drive', sourceAngle: 'front', duration: 10 },
  ],
  edit: [
    { shotKey: 'drive', in: 5.8, duration: 0.9, captionKey: 'star' },
    { shotKey: 'race', in: 3.0, duration: 1.2, captionKey: 'lights' },
    { shotKey: 'race', in: 6.0, duration: 1.4, captionKey: 'wheel' },
    { shotKey: 'race', in: 8.6, duration: 1.4 },
  ],
  grade: RITCHIE_GRADE,
};

const TOP_GEAR: PromoTheme = {
  id: 'top-gear-drive',
  title: 'Top-Gear Drive',
  description: 'The car pulls off the forecourt and onto a beautiful country road — a clean, aspirational hero drive.',
  bestFor: 'Premium / lifestyle cars where restraint suits.',
  shots: [
    { key: 'drive', sourceAngle: 'front', duration: 10 },
    { key: 'passby', sourceAngle: 'front', duration: 15 },
  ],
  edit: [
    { shotKey: 'drive', in: 1.0, duration: 2.5 },
    { shotKey: 'drive', in: 6.0, duration: 2.5 },
    { shotKey: 'passby', in: 8.0, duration: 3.0 },
  ],
  grade: CLEAN_GRADE,
};

export const PROMO_THEMES: PromoTheme[] = [GETAWAY_POLICE, F1_SHOWDOWN, TOP_GEAR];

export function getTheme(id: string): PromoTheme | undefined {
  return PROMO_THEMES.find((t) => t.id === id);
}

/** Fill {CAR}/{PLATE} placeholders. */
export function fillPrompt(prompt: string, car: string, plate: string): string {
  return (prompt ?? '').replaceAll('{CAR}', car || 'car').replaceAll('{PLATE}', plate || '');
}

// ── Emergency-net content ONLY (authoritative copy lives in the git theme skills;
//    edit these there, not here). Keyed by theme id. ──────────────────────────────
export const FALLBACK_CONTENT: Record<string, PromoContent> = {
  'getaway-police': {
    shots: {
      getaway:
        'This exact {CAR}, driven by an attractive young woman clearly visible through the windscreen, pulls away hard and fast with rear wheels spinning and clouds of tyre smoke as if making a getaway down a narrow British country lane. A small white Rover Metro police car in classic Metropolitan Police livery (white with orange-red and blue jam-sandwich stripes, blue light flashing, POLICE markings), driven by a British policeman in a 1980s police uniform and cap, races after it, overtakes and cuts sharply IN FRONT to force it to brake hard and stop. Fast, urgent, high-energy police chase, screeching tyres and tyre smoke. The {CAR} stays exactly as shown, number plate {PLATE}.',
      drive:
        'This exact {CAR} drives forwards along an open scenic country road at pace, front three-quarter tracking shot, a young woman driving, wheels turning forwards, hedgerows rushing past with motion blur, bright day, cinematic. The {CAR} stays exactly as shown, number plate {PLATE}.',
      passby:
        'Roadside tracking shot: this exact {CAR} drives forwards and passes the camera; as it passes, the camera pans to follow along the side from front to back, then follows the rear as it drives away down the country road. Smooth steady camera, no shake. The {CAR} stays exactly as shown, number plate {PLATE}.',
    },
    captions: { getaway: 'The getaway', onrun: 'On the run', law: 'The law', nicked: 'Nicked.' },
    titleCard: { headline: 'This deal is a steal!', cta: 'See it on Auto Trader' },
  },
  'f1-showdown': {
    shots: {
      race:
        'Epic cinematic shot: this exact {CAR} powers FORWARDS as the road transitions into a Formula One race circuit. Two Formula One cars fade in and race head-to-head alongside it, wheel to wheel, motion blur, grandstands and barriers flashing past, high-octane race atmosphere, dynamic front three-quarter tracking. The {CAR} stays exactly as shown, number plate {PLATE}.',
      drive:
        'This exact {CAR} drives forwards at speed, front three-quarter tracking shot, wheels turning, motion blur, cinematic. The {CAR} stays exactly as shown, number plate {PLATE}.',
    },
    captions: { star: 'Meet the star', lights: 'Lights out', wheel: 'Wheel to wheel' },
    titleCard: { headline: 'A winner every time', cta: 'See it on Auto Trader' },
  },
  'top-gear-drive': {
    shots: {
      drive:
        'This exact {CAR} starts parked in front of the building, then drives FORWARDS out onto an open scenic country road where it gathers pace. Front three-quarter tracking shot, an attractive young driver, wheels turning forwards, hedgerows rushing past, bright sunny day, cinematic Top Gear style. The {CAR} stays exactly as shown, number plate {PLATE}.',
      passby:
        'Roadside tracking shot: this exact {CAR} drives forwards and passes the camera; the camera pans to follow along the side then the rear as it drives away down the country road. Smooth steady camera, no shake. The {CAR} stays exactly as shown, number plate {PLATE}.',
    },
    captions: {},
    titleCard: { headline: 'Your next chapter', cta: 'See it on Auto Trader' },
  },
};
