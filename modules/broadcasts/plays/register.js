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

export default {
  capabilities: [
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
