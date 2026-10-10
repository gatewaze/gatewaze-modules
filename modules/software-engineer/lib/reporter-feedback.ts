// @ts-nocheck
/**
 * Reporter-safe feedback surface (migration 029). Mirrors the shape of lib/decisions.ts but is
 * deliberately a separate, lower-trust path: a reporter's answer can only ever feed spec-refine.ts as
 * untrusted product input (via se_messages role='reporter'); it can never resume a run, approve
 * architecture, or touch a gate the way lib/decisions.ts's resumeRunForDecision/approveArchitecture do.
 *
 * Callers are the internal API in api/internal-routes.ts, which runs under the service role and has
 * already verified (in the calling module, e.g. health-core) that the acting person owns the report
 * before this code ever sees a request.
 */

// Supersede any pending reporter question for the run, then insert the new one at the next revision —
// same two-statement, not-a-transaction shape as createOrSupersedeDecision, for the same reason: the
// unique partial index (se_reporter_questions_one_pending_per_run) turns a lost race into a failed
// insert rather than corrupted state, and emission call sites are sequential per run.
export async function createOrSupersedeReporterQuestion(supabase, params) {
  const { runId, siteId, phase, question, kind, options = null, summary } = params;
  const { data: prior } = await supabase
    .from('se_reporter_questions')
    .select('revision')
    .eq('run_id', runId)
    .order('revision', { ascending: false })
    .limit(1)
    .maybeSingle();
  await supabase.from('se_reporter_questions').update({ status: 'superseded' }).eq('run_id', runId).eq('status', 'pending');
  const nextRevision = (prior?.revision ?? 0) + 1;
  const { data, error } = await supabase
    .from('se_reporter_questions')
    .insert({ run_id: runId, site_id: siteId, phase, question, kind, options, summary, revision: nextRevision, status: 'pending' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// CAS the question to 'answered' at the exact revision the client was shown, then drop the answer into
// se_messages as role='reporter' for spec-refine.ts to drain on its next enqueue. Idempotent: a retry
// with the same idempotency_key after a successful write is a no-op that returns the original answer
// row rather than a second message.
export async function answerReporterQuestion(supabase, params) {
  const { questionId, revision, answer, idempotencyKey } = params;

  const { data: existing } = await supabase
    .from('se_reporter_answers')
    .select('*')
    .eq('question_id', questionId)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing) return { ok: true, replayed: true, answer: existing };

  const { data: question } = await supabase.from('se_reporter_questions').select('*').eq('id', questionId).maybeSingle();
  if (!question) return { ok: false, status: 404, error: { code: 'not_found', message: 'question not found' } };
  if (question.status !== 'pending') {
    return { ok: false, status: 409, error: { code: 'already_answered', message: `question is ${question.status}` } };
  }
  if (question.revision !== revision) {
    return { ok: false, status: 409, error: { code: 'stale_question', message: 'This question has already moved on — refresh before answering.' } };
  }

  const { data: raced, error: casError } = await supabase
    .from('se_reporter_questions')
    .update({ status: 'answered' })
    .eq('id', questionId)
    .eq('status', 'pending')
    .eq('revision', revision)
    .select()
    .single();
  if (casError || !raced) {
    return { ok: false, status: 409, error: { code: 'stale_question', message: 'This question has already moved on — refresh before answering.' } };
  }

  const { data: run } = await supabase.from('se_runs').select('id, site_id').eq('id', question.run_id).maybeSingle();

  let answerRow;
  try {
    const { data, error } = await supabase
      .from('se_reporter_answers')
      .insert({ question_id: questionId, run_id: question.run_id, answer, answered_revision: revision, idempotency_key: idempotencyKey })
      .select()
      .single();
    if (error) throw error;
    answerRow = data;
  } catch (e) {
    // Insert failed after the CAS succeeded (e.g. enqueue-adjacent crash) — roll the question back to
    // pending at the same revision so the reporter's retry lands on an answerable question again rather
    // than a permanently 'answered' one with no recorded answer.
    await supabase.from('se_reporter_questions').update({ status: 'pending' }).eq('id', questionId).eq('status', 'answered');
    throw e;
  }

  if (run) {
    const content = question.kind === 'choice'
      ? (question.options ?? []).find((o) => o?.id === answer?.optionId)?.label ?? String(answer?.optionId ?? '')
      : String(answer?.text ?? '').slice(0, 4000);
    const requestChange = answer?.requestChange === true;
    const label = requestChange ? 'requested a change' : 'confirmed';
    try {
      await supabase.from('se_messages').insert({
        run_id: run.id,
        site_id: run.site_id,
        role: 'reporter',
        author: null,
        content: `The reporter ${label}: ${content}`,
      });
    } catch { /* best-effort — the answer row is already durable; a dropped message surfaces as the run staying parked, which is safe */ }
  }

  return { ok: true, replayed: false, answer: answerRow };
}

// Idempotent upsert used both by the Studio write-back (new reports → runs) and by a one-time backfill
// of already-created reports. Safe to call repeatedly with the same externalReportId.
export async function linkReporterReport(supabase, params) {
  const { runId, siteId, externalSystem, externalReportId, externalPersonId, isPrimary = true } = params;
  const { data, error } = await supabase
    .from('se_reporter_links')
    .upsert(
      { run_id: runId, site_id: siteId, external_system: externalSystem, external_report_id: externalReportId, external_person_id: externalPersonId, is_primary: isPrimary },
      { onConflict: 'external_system,external_report_id' },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function reporterQuestionsForPersons(supabase, { externalSystem, externalPersonIds, since = null }) {
  if (!externalPersonIds?.length) return [];
  const { data: links } = await supabase
    .from('se_reporter_links')
    .select('run_id, external_report_id, external_person_id')
    .eq('external_system', externalSystem)
    .in('external_person_id', externalPersonIds);
  if (!links?.length) return [];
  const runIds = [...new Set(links.map((l) => l.run_id))];
  let query = supabase.from('se_reporter_questions').select('*').in('run_id', runIds).order('created_at', { ascending: true });
  if (since) query = query.gt('created_at', since);
  const { data: questions } = await query;
  const byRun = new Map(links.map((l) => [l.run_id, l]));
  return (questions ?? []).map((q) => ({ ...q, externalReportId: byRun.get(q.run_id)?.external_report_id ?? null }));
}

// Reporter-safe run status snapshot — explicitly excludes se_messages/se_artifacts/se_gates (raw agent
// transcripts, prompts, logs) and se_decisions (admin-only). Only the fields a status-derivation layer
// needs to turn into a plain-language label.
export async function runStatusForExternalReportIds(supabase, { externalSystem, externalReportIds }) {
  if (!externalReportIds?.length) return [];
  const { data: links } = await supabase
    .from('se_reporter_links')
    .select('run_id, external_report_id, is_primary')
    .eq('external_system', externalSystem)
    .in('external_report_id', externalReportIds);
  if (!links?.length) return [];
  const runIds = [...new Set(links.map((l) => l.run_id))];
  const { data: runs } = await supabase
    .from('se_runs')
    .select('id, status, current_phase, updated_at')
    .in('id', runIds);
  const { data: pendingQuestions } = await supabase
    .from('se_reporter_questions')
    .select('run_id, id')
    .in('run_id', runIds)
    .eq('status', 'pending');
  const pendingByRun = new Set((pendingQuestions ?? []).map((q) => q.run_id));
  const runsById = new Map((runs ?? []).map((r) => [r.id, r]));
  return links.map((l) => {
    const run = runsById.get(l.run_id);
    return {
      externalReportId: l.external_report_id,
      isPrimary: l.is_primary,
      runId: l.run_id,
      runStatus: run?.status ?? null,
      currentPhase: run?.current_phase ?? null,
      hasPendingReporterQuestion: pendingByRun.has(l.run_id),
      // Deliberately NOT including issue_number/repo_owner/repo_name/issueUrl here — this payload
      // crosses into a lower-trust, external-facing module (health-core → the reporter's own device),
      // and the org's internal repo naming/issue tracker is not reporter-safe information (same reason
      // workers/review.ts withholds the skeptic's objections from the reporter). If a tester-facing
      // issue link is ever wanted, it should be a product decision made explicitly by the caller that
      // already knows the repo is public — e.g. Studio's own POST /feedback-links write-back in
      // health-core, which sets hc_feedback_links.issue_url directly — not implied by this sync.
      updatedAt: run?.updated_at ?? null,
    };
  });
}
