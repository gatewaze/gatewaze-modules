// @ts-nocheck — supabase-js + the ai module are resolved at module-host install time.

/**
 * event-speakers:talk-edit-review-sweep — softens the talk-edit status reset.
 *
 * When a speaker edits their title or synopsis, events-speaker-update knocks an
 * approved/confirmed talk back to 'pending' and records a row in
 * speaker_talk_edit_reviews. That reset is the FAIL-SAFE default: it happens
 * whether or not AI is reachable, so a substantive rewrite can never keep a
 * confirmed slot just because a model was down.
 *
 * This sweep then asks whether the edit actually changed the substance of the
 * talk. If not — a typo, a reworded sentence, a tightened title — the previous
 * status is restored automatically and the speaker keeps their slot. If it did,
 * the talk stays pending for a human, which is exactly today's behaviour.
 *
 * Everything is one-way-safe: the ONLY action this worker takes is restoring a
 * status the speaker already held. It can never approve, confirm or promote a
 * talk beyond where it was before the edit.
 */

import { serviceClient } from '../lib/promo/service-client.js';

const CLAIM_CAP = 20;
const MAX_ATTEMPTS = 3;

// Statuses this sweep is allowed to restore. Anything else (rejected, reserve)
// is not a state a speaker edit should be able to return a talk to.
const RESTORABLE = new Set(['approved', 'confirmed']);

function log(msg: string): void {
  console.log(`[event-speakers:talk-edit-review] ${msg}`);
}

interface RunChatResult {
  structured: Record<string, unknown> | null;
}
type RunChat = (
  ctx: { supabase: unknown },
  opts: {
    useCase: string;
    userId: string | null;
    threadId: null;
    messageId: null;
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    structuredTool: { name: string; description: string; inputSchema: Record<string, unknown> };
    maxOutputTokens?: number;
    timeoutMs?: number;
  },
) => Promise<RunChatResult>;

let cachedRunChat: RunChat | null | undefined;

/**
 * Resolve the ai module's runChat. Mirrors broadcasts/api/segments-ai-build.ts —
 * the path varies between the admin bundle, the api-server clone tree and a
 * local checkout, so each candidate is tried in turn.
 */
async function loadRunChat(): Promise<RunChat> {
  if (cachedRunChat) return cachedRunChat;
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../ai/lib/runner.js',
    '../../../../gatewaze-modules/modules/ai/lib/runner.ts',
    '/tmp/module-repos/gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  const failures: string[] = [];
  for (const path of attempts) {
    try {
      const mod = (await import(path)) as { runChat?: RunChat };
      if (typeof mod.runChat === 'function') {
        cachedRunChat = mod.runChat;
        return mod.runChat;
      }
      failures.push(`${path} (runChat is ${typeof mod.runChat})`);
    } catch (e) {
      failures.push(`${path} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
  }
  throw new Error('ai runChat unavailable. Tried: ' + failures.join('; '));
}

const SYSTEM_PROMPT = `You decide whether a conference speaker's edit to their own talk changed what the talk is ABOUT.

You are given the previous title and abstract, and the new title and abstract. Decide between:

- "minor": the substance is the same talk. Typos, grammar, punctuation, formatting, capitalisation, a tightened or rephrased sentence, a clearer wording of the same idea, added or removed detail that does not change the subject, small scope clarifications, a changed speaker name or company mention.
- "material": a programme organiser would want to re-review this. The topic changed, the technology or domain changed, the audience or level changed substantially, the talk's claim or argument changed, or the abstract now describes a different session.

Bias towards "minor". The cost of a wrong "minor" is that an organiser sees a slightly different abstract than they approved. The cost of a wrong "material" is that a speaker loses their confirmed slot over a typo fix, which is the problem you exist to prevent. Only answer "material" when the change is clear.

Judge ONLY the two texts you are given. Do not speculate about intent, and do not consider anything outside them.

Give a one-sentence reason an organiser can read, naming what actually changed.`;

const MATERIALITY_TOOL = {
  name: 'record_materiality',
  description: 'Record whether the talk edit was minor or material.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'reason'],
    properties: {
      verdict: {
        type: 'string',
        enum: ['minor', 'material'],
        description: 'minor = same talk, keep the existing status; material = needs organiser re-review.',
      },
      reason: {
        type: 'string',
        description: 'One sentence, for an organiser, naming what changed.',
      },
    },
  },
};

/** Untrusted speaker-authored text goes in pseudo-XML so it can't be read as instructions. */
function buildComparison(review: Record<string, unknown>): string {
  const f = (v: unknown) => String(v ?? '').slice(0, 4000);
  return [
    '<previous_version>',
    `<title>${f(review.old_title)}</title>`,
    `<abstract>${f(review.old_synopsis)}</abstract>`,
    '</previous_version>',
    '<new_version>',
    `<title>${f(review.new_title)}</title>`,
    `<abstract>${f(review.new_synopsis)}</abstract>`,
    '</new_version>',
    '',
    'Did this edit change what the talk is about?',
  ].join('\n');
}

export default async function handleTalkEditReviewSweep(): Promise<unknown> {
  const supabase = serviceClient();

  const { data: reviews, error } = await supabase
    .from('speaker_talk_edit_reviews')
    .select('*')
    .eq('verdict', 'pending')
    .lt('attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(CLAIM_CAP);
  if (error) {
    log(`claim failed: ${error.message}`);
    return { error: error.message };
  }
  if (!reviews?.length) return { judged: 0 };

  let runChat: RunChat;
  try {
    runChat = await loadRunChat();
  } catch (e) {
    // No ai module: leave the rows pending-but-attempted so they age out to
    // 'failed' rather than being retried forever. The talks stay pending,
    // which is the behaviour that existed before this feature.
    log(`ai unavailable — leaving talks pending: ${e instanceof Error ? e.message : e}`);
    for (const r of reviews) {
      const attempts = (r.attempts ?? 0) + 1;
      await supabase
        .from('speaker_talk_edit_reviews')
        .update({
          attempts,
          ...(attempts >= MAX_ATTEMPTS
            ? { verdict: 'failed', reason: 'AI judgement unavailable; left for manual review', judged_at: new Date().toISOString() }
            : {}),
        })
        .eq('id', r.id);
    }
    return { judged: 0, aiUnavailable: true };
  }

  let restored = 0;
  let kept = 0;

  for (const review of reviews) {
    await supabase
      .from('speaker_talk_edit_reviews')
      .update({ attempts: (review.attempts ?? 0) + 1 })
      .eq('id', review.id);

    let verdict: string | null = null;
    let reason = '';
    try {
      const result = await runChat(
        { supabase },
        {
          useCase: 'talk-edit-materiality',
          userId: null,
          threadId: null,
          messageId: null,
          systemPrompt: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildComparison(review) }],
          structuredTool: MATERIALITY_TOOL,
          maxOutputTokens: 600,
          timeoutMs: 30_000,
        },
      );
      const s = result?.structured as { verdict?: string; reason?: string } | null;
      if (s?.verdict === 'minor' || s?.verdict === 'material') {
        verdict = s.verdict;
        reason = String(s.reason ?? '').slice(0, 500);
      }
    } catch (e) {
      log(`judgement failed for talk ${review.talk_id}: ${e instanceof Error ? e.message : e}`);
    }

    if (!verdict) {
      const attempts = (review.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await supabase
          .from('speaker_talk_edit_reviews')
          .update({ verdict: 'failed', reason: 'AI judgement failed; left for manual review', judged_at: new Date().toISOString() })
          .eq('id', review.id);
      }
      continue;
    }

    if (verdict === 'minor' && RESTORABLE.has(review.previous_status)) {
      // Only restore if the talk is still sitting where the reset left it. If
      // an organiser has since acted (or the speaker edited again), their
      // decision wins — we never overwrite a human.
      const { data: talk } = await supabase
        .from('events_talks')
        .select('status')
        .eq('id', review.talk_id)
        .maybeSingle();
      if (talk?.status === 'pending') {
        await supabase
          .from('events_talks')
          .update({ status: review.previous_status })
          .eq('id', review.talk_id)
          .eq('status', 'pending');
        restored++;
        log(`restored talk ${review.talk_id} to ${review.previous_status}: ${reason}`);
      } else {
        reason = `${reason} (not restored — status had already moved to ${talk?.status ?? 'unknown'})`;
      }
    } else {
      kept++;
    }

    await supabase
      .from('speaker_talk_edit_reviews')
      .update({ verdict, reason, judged_at: new Date().toISOString() })
      .eq('id', review.id);
  }

  if (restored || kept) log(`judged ${reviews.length}: ${restored} restored, ${kept} left pending`);
  return { judged: reviews.length, restored, kept };
}
