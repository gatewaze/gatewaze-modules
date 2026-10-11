/**
 * Poses: what the people in the booth actually do.
 *
 * The booth used to take a photograph of people sitting still and hand
 * the whole picture to a model, which redrew them in a decade. The
 * people were raw material; nothing they did survived. A pose turns that
 * round -- the booth asks for something ("back to back, arms folded"),
 * the guests do it, and the prompt then insists that exactly that pose
 * comes through into the finished picture (asked 2026-09-22).
 *
 * A pose is not a style. It rides on top of whichever decade and look a
 * guest has chosen: back to back in a 1940s noir booth is a standoff at
 * a rain-slicked door; in a 1980s booth it is a buddy-cop poster. The
 * decade supplies the world, the pose supplies the moment.
 *
 * Two ways in, both using this one list:
 *
 *   pose of the hour   every guest is asked for the same pose for a
 *                      while, so the projector fills with twenty takes
 *                      on it and the room notices
 *   pose card          the booth deals a pose at random each time
 *                      someone steps in
 *
 * `instruction` is read by a guest standing in a booth, so it is short
 * enough to take in at a glance. `prompt` is read by the model and
 * describes the same thing as a photograph, because a model told to
 * "keep the pose" does better when it is also told what the pose is.
 */

export interface BoothPose {
  id: string;
  /** Shown on the booth's own screen, as a title. */
  label: string;
  /** What the guests are asked to do. One line, plain. */
  instruction: string;
  /** The same moment, described for the model. */
  prompt: string;
  /** Needs more than one person to make sense. */
  group?: boolean;
}

export const BOOTH_POSES: readonly BoothPose[] = [
  {
    id: 'standoff',
    label: 'The standoff',
    instruction: 'Back to back, arms folded, chins up.',
    prompt: 'standing back to back with arms folded and chins raised, like rivals on a film poster',
    group: true,
  },
  {
    id: 'blame',
    label: 'It was them',
    instruction: 'Everyone point at someone else.',
    prompt: 'each person pointing accusingly at another, caught mid-argument',
    group: true,
  },
  {
    id: 'huddle',
    label: 'The huddle',
    instruction: 'Heads together, all squashed into the frame.',
    prompt: 'heads pressed together in a tight huddle, cheek to cheek, filling the frame',
    group: true,
  },
  {
    id: 'gossip',
    label: 'The secret',
    instruction: 'One of you whisper, the rest look shocked.',
    prompt: 'one person whispering behind a raised hand while the others react with wide-eyed shock',
    group: true,
  },
  {
    id: 'swoon',
    label: 'The swoon',
    instruction: 'One faints, the others catch them.',
    prompt: 'one person swooning backwards with a hand to the forehead while the others catch them, silent-film melodrama',
    group: true,
  },
  {
    id: 'laugh',
    label: 'Caught laughing',
    instruction: 'Heads back, proper belly laugh.',
    prompt: 'heads thrown back mid-laugh, eyes crinkled, entirely unposed',
  },
  {
    id: 'assemble',
    label: 'Assemble',
    instruction: 'Hands on hips. Save the world.',
    prompt: 'standing in a heroic line, hands on hips, chins up, looking off to one side',
  },
  {
    id: 'hush',
    label: 'Keep it quiet',
    instruction: 'Finger to your lips. Say nothing.',
    prompt: 'a finger held to the lips, conspiratorial, eyes straight down the lens',
  },
  {
    id: 'glance',
    label: 'The glance',
    instruction: 'Turn away, then look back over your shoulder.',
    prompt: 'turned away from the camera and looking back over one shoulder',
  },
  {
    id: 'encore',
    label: 'The encore',
    instruction: 'Sing it into an invisible microphone.',
    prompt: 'singing into an invisible microphone, eyes shut, mid-note',
  },
  {
    id: 'gasp',
    label: 'The gasp',
    instruction: 'Hands to cheeks. Absolutely scandalised.',
    prompt: 'hands to cheeks, mouths open in exaggerated shock',
  },
  {
    id: 'thinker',
    label: 'Deep thoughts',
    instruction: 'Chin on fist. Very serious. No smiling.',
    prompt: 'chin resting on a fist, brow furrowed, deadly serious, not smiling',
  },
  {
    id: 'freeze',
    label: 'Freeze frame',
    instruction: 'High five — and hold it there.',
    prompt: 'frozen mid high-five, hands about to meet, both grinning',
    group: true,
  },
  {
    id: 'accused',
    label: 'The accused',
    instruction: 'All point at one unlucky person.',
    prompt: 'everyone pointing at one person in the middle, who looks caught out',
    group: true,
  },
  {
    id: 'dancefloor',
    label: 'The move',
    instruction: 'Your best dance move. Commit to it.',
    prompt: 'mid dance move, arms up, weight on one hip, committed to it',
  },
  {
    id: 'tragedy',
    label: 'The tragedy',
    instruction: 'Back of hand to forehead. Utter despair.',
    prompt: 'the back of a hand pressed to the forehead in theatrical despair',
  },
  {
    id: 'duel',
    label: 'The duel',
    instruction: 'Mock arm wrestle. Teeth gritted.',
    prompt: 'locked in a mock arm wrestle, teeth gritted, straining',
    group: true,
  },
  {
    id: 'lean',
    label: 'Too cool',
    instruction: 'Lean back. Look bored. Sunglasses if you have them.',
    prompt: 'leaning back with studied indifference, unimpressed, impossibly cool',
  },
  {
    id: 'squeeze',
    label: 'One more in',
    instruction: 'Squash in as if one more person still has to fit.',
    prompt: 'squeezed together to one side of the frame as if making room for someone else',
    group: true,
  },
  {
    id: 'cheers',
    label: 'Cheers',
    instruction: 'Glasses up, straight at the camera.',
    prompt: 'raising glasses towards the camera in a toast',
  },
];

const BY_ID = new Map(BOOTH_POSES.map((p) => [p.id, p]));

export function boothPose(id: unknown): BoothPose | null {
  return typeof id === 'string' ? BY_ID.get(id) ?? null : null;
}

/**
 * The pose everyone is asked for at this moment.
 *
 * Deterministic: every phone and every projector works it out from the
 * clock rather than being told, so they all agree without talking to
 * each other, and the answer is stable for the whole slot. The order
 * walks the list from an offset the event decides, so two events on the
 * same evening are not in step.
 */
export function poseOfTheHour(
  now: Date | number,
  intervalMinutes: number,
  offset = 0,
  poses: readonly BoothPose[] = BOOTH_POSES,
): BoothPose {
  const minutes = Math.max(1, Math.round(intervalMinutes));
  const slot = Math.floor((typeof now === 'number' ? now : now.getTime()) / (minutes * 60_000));
  const n = poses.length;
  const i = (((slot + Math.round(offset)) % n) + n) % n;
  return poses[i]!;
}

/** When the current slot ends, so a booth can say "changes at 9:15". */
export function poseChangesAt(now: Date | number, intervalMinutes: number): Date {
  const minutes = Math.max(1, Math.round(intervalMinutes));
  const ms = minutes * 60_000;
  const t = typeof now === 'number' ? now : now.getTime();
  return new Date((Math.floor(t / ms) + 1) * ms);
}
