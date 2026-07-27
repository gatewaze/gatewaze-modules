/**
 * Play capabilities contributed by the signals module (spec §4.6).
 *
 * `signals:evaluate` is an analysis capability: evaluate a signals rule over the
 * audience and record fires. Not reversible (evaluation is read-only) — its
 * output feeds downstream plays (e.g. an engagement follow-up). The forward
 * worker (`signals:evaluate`) already exists; locate() reports success once the
 * evaluation has recorded a fire row for this run.
 */

export default {
  capabilities: [
    {
      key: 'signals:evaluate',
      kind: 'analysis',
      worker: 'signals:evaluate',
      reversible: false,
      backend: 'worker',
      async locate({ supabase, runRef }) {
        // run_ref may carry the fire id (preferred) or the rule id.
        const fireId = runRef && runRef.id;
        const ruleId = runRef && runRef.rule_id;
        try {
          if (fireId) {
            const r = await supabase.from('signals_fires').select('id,rule_id').eq('id', fireId).maybeSingle();
            if (r.data) return { run_status: 'succeeded', artifact_ref: { module: 'signals', type: 'signals_fire', id: r.data.id, relation: 'analyzes' } };
          }
          if (ruleId) {
            const r = await supabase.from('signals_fires').select('id').eq('rule_id', ruleId).order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (r.data) return { run_status: 'succeeded', artifact_ref: { module: 'signals', type: 'signals_fire', id: r.data.id, relation: 'analyzes' } };
          }
        } catch {
          return { run_status: 'running', artifact_ref: null };
        }
        return { run_status: 'running', artifact_ref: null };
      },
    },
  ],
};
