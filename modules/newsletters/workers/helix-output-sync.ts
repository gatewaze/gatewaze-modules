import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface HelixSyncJobData {
  kind: string;
  task_id?: string;
}

interface SpecTaskShape {
  id: string;
  project_id: string;
  design_doc_path: string;
}

interface ProjectShape {
  id: string;
  default_repo_id: string;
}

async function fetchOutputHtml(
  helixUrl: string,
  helixApiKey: string,
  taskId: string,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${helixApiKey}` };

  const taskRes = await fetch(`${helixUrl}/api/v1/spec-tasks/${taskId}`, { headers });
  if (!taskRes.ok) {
    console.error(`[helix-sync] get-task failed for ${taskId}: ${taskRes.status}`);
    return null;
  }
  const task = (await taskRes.json()) as SpecTaskShape;
  if (!task.design_doc_path || !task.project_id) return null;

  const projRes = await fetch(`${helixUrl}/api/v1/projects/${task.project_id}`, { headers });
  if (!projRes.ok) {
    console.error(`[helix-sync] get-project failed for ${task.project_id}: ${projRes.status}`);
    return null;
  }
  const project = (await projRes.json()) as ProjectShape;
  if (!project.default_repo_id) return null;

  const path = `design/tasks/${task.design_doc_path}/output.html`;
  const url = `${helixUrl}/api/v1/git/repositories/${project.default_repo_id}/contents?path=${encodeURIComponent(path)}&branch=helix-specs`;
  const fileRes = await fetch(url, { headers });
  if (fileRes.status === 404) return null;
  if (!fileRes.ok) {
    console.error(`[helix-sync] git/contents failed for ${path}: ${fileRes.status}`);
    return null;
  }
  const fileData = (await fileRes.json()) as { content?: string };
  return typeof fileData.content === 'string' ? fileData.content : null;
}

function findHelixFields(content: Record<string, unknown>): Array<{
  field: string;
  taskId: string;
  alreadyImported: boolean;
}> {
  const fields: Array<{ field: string; taskId: string; alreadyImported: boolean }> = [];
  const SUFFIX = '_helix_task_id';
  for (const key of Object.keys(content)) {
    if (!key.endsWith(SUFFIX)) continue;
    const taskId = content[key];
    if (typeof taskId !== 'string' || !taskId) continue;
    const field = key.slice(0, -SUFFIX.length);
    const importedAt = content[`${field}_helix_output_imported_at`];
    fields.push({ field, taskId, alreadyImported: typeof importedAt === 'string' && !!importedAt });
  }
  return fields;
}

export default async function handleHelixOutputSync(job: Job<HelixSyncJobData>) {
  const helixUrl = process.env.HELIX_URL;
  const helixApiKey = process.env.HELIX_API_KEY;
  if (!helixUrl || !helixApiKey) {
    throw new Error('HELIX_URL and HELIX_API_KEY must be set');
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const onlyTaskId = job.data.task_id;

  const { data: blocks, error: queryError } = await supabase
    .from('newsletters_edition_blocks')
    .select('id, content');

  if (queryError) throw new Error(`failed to fetch blocks: ${queryError.message}`);

  let imported = 0;
  let skipped = 0;

  for (const block of blocks || []) {
    const content = (block.content || {}) as Record<string, unknown>;
    const fields = findHelixFields(content);
    for (const { field, taskId, alreadyImported } of fields) {
      if (onlyTaskId && taskId !== onlyTaskId) continue;
      if (!onlyTaskId && alreadyImported) {
        skipped++;
        continue;
      }

      const html = await fetchOutputHtml(helixUrl, helixApiKey, taskId);
      if (!html) {
        skipped++;
        continue;
      }

      const newContent = {
        ...content,
        [field]: html,
        [`${field}_helix_output_imported_at`]: new Date().toISOString(),
      };

      const { error: updateError } = await supabase
        .from('newsletters_edition_blocks')
        .update({ content: newContent })
        .eq('id', block.id);

      if (updateError) {
        console.error(`[helix-sync] failed to update block ${block.id}:`, updateError);
      } else {
        console.log(`[helix-sync] imported output.html for block ${block.id} field ${field} from task ${taskId}`);
        imported++;
      }
    }
  }

  return { imported, skipped };
}
