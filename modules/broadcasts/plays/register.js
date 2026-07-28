/**
 * Play capabilities contributed by the broadcasts module (spec §4.6).
 *
 * `broadcasts:send` is a communication capability: it reaches people, so plays
 * built on it are approval-gated (the blueprint sets approval_required) and it
 * is NOT reversible — a sent email cannot be unsent.
 *
 * NOTE (integration seam): the forward worker below (`broadcasts:dispatch-scheduled`)
 * is the module's existing dispatcher. A plays-aware adapter that turns a Play's
 * {audienceRule, inputs} into a broadcast + triggers the send is the broadcasts
 * module's follow-on integration; until then locate() still derives status from
 * the real broadcast_sends row once run_ref is linked.
 */

const STATUS_MAP = {
  sent: 'succeeded',
  complete: 'succeeded',
  completed: 'succeeded',
  delivered: 'succeeded',
  failed: 'failed',
  error: 'failed',
  cancelled: 'failed',
};

const DRAFT_ARTIFACT = (id) => ({ module: 'broadcasts', type: 'broadcast', id, relation: 'produces', url: `/broadcasts/${id}` });

export default {
  capabilities: [
    {
      // Turn a conference recap into a DRAFT broadcast (never sends). Dispatched
      // when a recap-follow-up communication Play runs; the forward worker reads
      // the recap the sibling post_recap play attached to, pulls a few talk
      // highlights, and creates a draft broadcast for a human to review + send.
      key: 'broadcasts:draft-from-recap',
      kind: 'communication',
      worker: 'broadcasts:draft-from-recap',
      dispatchable: true, // the forward worker understands the plays dispatch envelope
      reversible: false,  // a draft is deleted in the editor, not via a reverse worker
      backend: 'worker',
      inputSchema: {},
      // authoring knobs rendered by the Play Workflow Editor (workflow-editor §4.2);
      // the worker reads these off play.config (falling back to the defaults).
      configSchema: {
        type: 'object',
        properties: {
          highlight_count: { type: 'integer', default: 4, minimum: 1, maximum: 12, title: 'Talk highlights', description: 'How many talks to feature in the draft.' },
          ordering: { type: 'string', enum: ['sort_order', 'recency', 'affinity'], default: 'sort_order', title: 'Ordering', description: 'How to pick which talks (affinity personalises per recipient).' },
          personalize: { type: 'boolean', default: false, title: 'Personalise per recipient', description: 'Rank talks by each recipient\'s interests (audience-intelligence).' },
        },
      },
      // drafting is safe (never sends), so auto mode may complete it without approval.
      alwaysRequiresApproval: false,
      async locate({ supabase, runRef }) {
        const id = runRef && runRef.id;
        if (!id) return { run_status: 'queued', artifact_ref: null };
        let row = null;
        try {
          const r = await supabase.from('broadcasts').select('id,subject').eq('id', id).maybeSingle();
          row = r.data;
        } catch {
          return { run_status: 'running', artifact_ref: null };
        }
        if (!row) return { run_status: 'queued', artifact_ref: null };
        // the draft exists → the play's forward work is done (a human sends it later)
        return { run_status: 'succeeded', artifact_ref: DRAFT_ARTIFACT(row.id), detail: { current_step: 'draft' } };
      },
    },
    {
      key: 'broadcasts:send',
      kind: 'communication',
      worker: 'broadcasts:dispatch-scheduled',
      reversible: false,
      backend: 'worker',
      async locate({ supabase, runRef }) {
        const id = runRef && runRef.id;
        if (!id) return { run_status: 'queued', artifact_ref: null };
        let row = null;
        try {
          const r = await supabase.from('broadcast_sends').select('id,status').eq('id', id).maybeSingle();
          row = r.data;
        } catch {
          return { run_status: 'running', artifact_ref: null };
        }
        if (!row) return { run_status: 'queued', artifact_ref: null };
        const run_status = STATUS_MAP[String(row.status || '').toLowerCase()] || 'running';
        const artifact_ref =
          run_status === 'succeeded'
            ? { module: 'broadcasts', type: 'broadcast_send', id: row.id, relation: 'sends' }
            : null;
        return { run_status, artifact_ref, detail: { current_step: row.status } };
      },
    },
  ],
};
