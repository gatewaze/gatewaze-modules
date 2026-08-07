// @ts-nocheck
/**
 * Triage-turn job (§10.5 structural fix): executes ONE tool-less triage model turn in a WORKER
 * process instead of the API pod (whose 512Mi-class memory limits the CLI spawn OOMKilled on prod).
 * Consumed from the dedicated `se-triage` queue — NOT the agent-phase `se` queue — so a
 * triage-only runner (WORKER_QUEUES=se-triage) can serve prod without ever executing agent runs.
 * The API enqueues and awaits the return value (job result = TriageResult).
 */
import { createClient } from '@supabase/supabase-js';
import { getProject } from '../lib/credentials.js';
import { runTriageTurn } from '../lib/triage.js';

const sb = (ctx) =>
  ctx?.supabase ??
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

export default async function triageTurn(job, ctx) {
  const { projectId, messages, pageContext } = job?.data ?? {};
  const project = await getProject(sb(ctx), String(projectId ?? ''));
  if (!project?.modelCred) return { type: 'error', message: 'project has no model credential' };
  return runTriageTurn(project, messages, pageContext ?? null);
}
