import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter Helix Output Sync
 *
 * Pulls the agent's `output.html` back into the newsletter block content.
 *
 * Trigger:
 *  - POST { task_id? } from the admin UI ('Sync now' button) — targeted
 *    sync of one task, also re-imports already-imported tasks.
 *  - POST { } — full-table scan, only imports tasks not yet imported.
 *
 * For each newsletters_edition_blocks row with content.<field>_helix_task_id
 * set:
 *   1. Get the task's project + design_doc_path from Helix
 *   2. Pull output.html straight from the Helix git server via
 *      /api/v1/git/repositories/{repoId}/contents
 *   3. Write content (HTML, no conversion) into content[fieldName]
 *   4. Mark imported by setting content.<field>_helix_output_imported_at
 *
 * Deliberately bypasses /api/v1/spec-tasks/{id}/design-docs — that
 * endpoint reads from a stale local worktree and was missing pushed
 * files. The git/contents endpoint goes directly to the Helix git
 * server's tip and is always fresh.
 *
 * HTML (not markdown) round-trips losslessly between the agent and the
 * rich text editor — no marked / turndown drift.
 */

interface SpecTaskShape {
  id: string
  project_id: string
  design_doc_path: string
}

interface ProjectShape {
  id: string
  default_repo_id: string
}

interface SyncResult {
  block_id: string
  field: string
  task_id: string
  imported: boolean
  reason?: string
  /** Imported HTML content. Only populated on success — lets the admin
   *  UI apply the new content immediately without a separate fetch. */
  content_html?: string
}

async function fetchOutputHtml(
  helixUrl: string,
  helixApiKey: string,
  taskId: string,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${helixApiKey}` }

  // 1. Resolve task → project → repo
  const taskRes = await fetch(`${helixUrl}/api/v1/spec-tasks/${taskId}`, { headers })
  if (!taskRes.ok) {
    console.error(`helix get-task failed for ${taskId}: ${taskRes.status}`)
    return null
  }
  const task = (await taskRes.json()) as SpecTaskShape
  if (!task.design_doc_path || !task.project_id) {
    console.warn(`task ${taskId} has no design_doc_path or project_id`)
    return null
  }

  const projRes = await fetch(`${helixUrl}/api/v1/projects/${task.project_id}`, { headers })
  if (!projRes.ok) {
    console.error(`helix get-project failed for ${task.project_id}: ${projRes.status}`)
    return null
  }
  const project = (await projRes.json()) as ProjectShape
  if (!project.default_repo_id) {
    console.warn(`project ${task.project_id} has no default_repo_id`)
    return null
  }

  // 2. Pull output.html directly from the helix-specs branch
  const path = `design/tasks/${task.design_doc_path}/output.html`
  const url = `${helixUrl}/api/v1/git/repositories/${project.default_repo_id}/contents?path=${encodeURIComponent(path)}&branch=helix-specs`
  const fileRes = await fetch(url, { headers })
  if (fileRes.status === 404) return null // not yet written
  if (!fileRes.ok) {
    console.error(`helix git/contents failed for ${path}: ${fileRes.status}`)
    return null
  }
  const fileData = (await fileRes.json()) as { content?: string }
  return typeof fileData.content === 'string' ? fileData.content : null
}

function findHelixFields(content: Record<string, unknown>): Array<{
  field: string
  taskId: string
  alreadyImported: boolean
}> {
  const fields: Array<{ field: string; taskId: string; alreadyImported: boolean }> = []
  const SUFFIX = '_helix_task_id'
  for (const key of Object.keys(content)) {
    if (!key.endsWith(SUFFIX)) continue
    const taskId = content[key]
    if (typeof taskId !== 'string' || !taskId) continue
    const field = key.slice(0, -SUFFIX.length)
    const importedAt = content[`${field}_helix_output_imported_at`]
    fields.push({ field, taskId, alreadyImported: typeof importedAt === 'string' && !!importedAt })
  }
  return fields
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Optional targeted sync: POST { task_id } from the admin UI to sync
  // a single task immediately instead of waiting for the cron tick.
  let onlyTaskId: string | undefined
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}))
      if (typeof body?.task_id === 'string' && body.task_id) {
        onlyTaskId = body.task_id
      }
    } catch {
      // ignore — empty body is fine for full-scan mode
    }
  }

  const helixUrl = Deno.env.get('HELIX_URL')
  const helixApiKey = Deno.env.get('HELIX_API_KEY')
  if (!helixUrl || !helixApiKey) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'HELIX_URL and HELIX_API_KEY must be set in module config',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Fetch every block. We filter in JS because the field name is dynamic
  // (`<field>_helix_task_id` lives at unknown keys in the JSONB column).
  const { data: blocks, error: queryError } = await supabase
    .from('newsletters_edition_blocks')
    .select('id, content')

  if (queryError) {
    console.error('failed to fetch blocks:', queryError)
    return new Response(
      JSON.stringify({ success: false, error: queryError.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const results: SyncResult[] = []

  for (const block of blocks || []) {
    const content = (block.content || {}) as Record<string, unknown>
    const fields = findHelixFields(content)
    for (const { field, taskId, alreadyImported } of fields) {
      if (onlyTaskId && taskId !== onlyTaskId) continue
      // Cron skips already-imported tasks; manual sync re-imports so
      // the user can pull a refreshed output.html on demand.
      if (!onlyTaskId && alreadyImported) continue

      const html = await fetchOutputHtml(helixUrl, helixApiKey, taskId)
      if (!html) {
        results.push({
          block_id: block.id,
          field,
          task_id: taskId,
          imported: false,
          reason: 'output.html not yet available',
        })
        continue
      }

      const newContent = {
        ...content,
        [field]: html,
        [`${field}_helix_output_imported_at`]: new Date().toISOString(),
      }

      const { error: updateError } = await supabase
        .from('newsletters_edition_blocks')
        .update({ content: newContent })
        .eq('id', block.id)

      if (updateError) {
        console.error(`failed to update block ${block.id}:`, updateError)
        results.push({
          block_id: block.id,
          field,
          task_id: taskId,
          imported: false,
          reason: updateError.message,
        })
      } else {
        console.log(`imported output.md for block ${block.id} field ${field} from task ${taskId}`)
        results.push({
          block_id: block.id,
          field,
          task_id: taskId,
          imported: true,
          content_html: html,
        })
      }
    }
  }

  return new Response(
    JSON.stringify({ success: true, results }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
}

export default handler
Deno.serve(handler)
