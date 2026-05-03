import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter → Helix: create a research task.
 *
 * POST { prompt, block_id?, field_name? }
 *   → 201 { task_id, embed_url, view_url, persisted }
 *
 * The browser never sees the Helix API key. Module config supplies
 * HELIX_URL / HELIX_API_KEY / HELIX_PROJECT_ID via env vars.
 *
 * The embed_url contains ?access_token=<api_key> so the iframe
 * authenticates via Bearer; that URL is generated fresh per request and
 * never persisted in block content (which only stores task_id).
 *
 * The augmented prompt instructs the agent to write its findings as
 * output.html in the task's helix-specs design folder, which the sync
 * function (newsletter-helix-output-sync) then pulls back into the
 * editor.
 *
 * When block_id + field_name are supplied, the function persists the
 * task_id directly to the block's content JSONB using the service_role
 * key (bypassing RLS). This avoids relying on the client-side autosave
 * which is fragile (closure/timing bugs, RLS edge cases, navigation
 * after save on new editions).
 */

function buildAgentPrompt(userPrompt: string, outputPath?: string): string {
  const deliveryPath = outputPath
    ? `Write your final findings as well-formatted HTML to \`~/work/helix-specs/${outputPath}\`. After writing, \`cd ~/work/helix-specs && git add ${outputPath} && git commit -m "output.html" && git push origin helix-specs\`.`
    : `Write your final findings as well-formatted HTML to a file called \`output.html\` at the root of this task's design folder in \`~/work/helix-specs/\`, then commit and push to the \`helix-specs\` branch.`
  return `Research task for a newsletter draft.

User's prompt:
${userPrompt}

---

How to research:
- Use Chrome MCP to browse the web. DuckDuckGo (\`https://duckduckgo.com/?q=...\`) is a good starting point — it doesn't require login and tolerates automated access.
- Cite real sources by URL. Visit each page and verify the claim before quoting; don't invent facts or links.
- Aim for a small number of high-quality sources rather than many shallow ones.

How to deliver:
- ${deliveryPath}
- Use semantic newsletter-style HTML — \`<h2>\` and \`<h3>\` for sections, \`<p>\` for paragraphs, \`<ul>\` / \`<li>\` for lists, \`<a href="...">\` for source links, \`<strong>\` / \`<em>\` for emphasis. Do not include a \`<html>\` or \`<body>\` wrapper, and no \`<script>\` or \`<style>\` tags — just the body content.
- The newsletter editor renders this directly in the draft, so optimise for human readability, not for valid full HTML documents.`
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'POST only' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const helixUrl = Deno.env.get('HELIX_URL')
  const helixApiKey = Deno.env.get('HELIX_API_KEY')
  const defaultProjectId = Deno.env.get('HELIX_PROJECT_ID') || ''
  const helixOrgSlug = Deno.env.get('HELIX_ORG_SLUG') || '_'
  if (!helixUrl || !helixApiKey) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'HELIX_URL and HELIX_API_KEY must be set in module config',
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let userPrompt = ''
  let projectIdOverride = ''
  let blockId = ''
  let fieldName = ''
  try {
    const body = await req.json()
    userPrompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
    if (typeof body?.project_id === 'string') {
      projectIdOverride = body.project_id.trim()
    }
    if (typeof body?.block_id === 'string') {
      blockId = body.block_id.trim()
    }
    if (typeof body?.field_name === 'string') {
      fieldName = body.field_name.trim()
    }
  } catch {
    /* fall through to validation */
  }
  if (!userPrompt) {
    return new Response(
      JSON.stringify({ success: false, error: 'prompt is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Per-newsletter override (collectionMetadata.helix_project_id) wins
  // over the module-level HELIX_PROJECT_ID default. This lets different
  // newsletters target different Helix projects without re-installing
  // the module.
  const projectId = projectIdOverride || defaultProjectId
  if (!projectId) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'project_id is required (set HELIX_PROJECT_ID in module config or helix_project_id on the newsletter metadata)',
      }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Initialise the service_role client upfront so the persistence step
  // after task creation can reuse it.
  let sb: ReturnType<typeof createClient> | null = null
  if (blockId) {
    sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
  }

  const helixRes = await fetch(`${helixUrl}/api/v1/spec-tasks/from-prompt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${helixApiKey}`,
    },
    body: JSON.stringify({
      project_id: projectId,
      prompt: buildAgentPrompt(userPrompt),
      just_do_it_mode: true,
    }),
  })
  if (!helixRes.ok) {
    const text = await helixRes.text()
    console.error(`helix from-prompt failed: ${helixRes.status} ${text}`)
    return new Response(
      JSON.stringify({ success: false, error: `Helix API ${helixRes.status}: ${text}` }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }
  const task = await helixRes.json() as { id: string; design_doc_path?: string }

  // Fetch the task to get design_doc_path (set server-side after creation),
  // then update the description with the concrete output.html path so the
  // agent knows exactly where to write.
  let designDocPath = task.design_doc_path
  if (!designDocPath) {
    try {
      const taskRes = await fetch(`${helixUrl}/api/v1/spec-tasks/${task.id}`, {
        headers: { Authorization: `Bearer ${helixApiKey}` },
      })
      if (taskRes.ok) {
        const full = await taskRes.json() as { design_doc_path?: string }
        designDocPath = full.design_doc_path
      }
    } catch (err) {
      console.warn(`failed to fetch task ${task.id} for design_doc_path:`, err)
    }
  }
  if (designDocPath) {
    const outputPath = `design/tasks/${designDocPath}/output.html`
    try {
      await fetch(`${helixUrl}/api/v1/spec-tasks/${task.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${helixApiKey}`,
        },
        body: JSON.stringify({
          description: buildAgentPrompt(userPrompt, outputPath),
        }),
      })
    } catch (err) {
      console.warn(`failed to update task description with output path:`, err)
    }
  }

  // Newly created tasks land in 'backlog' even with just_do_it_mode=true;
  // they need an explicit start-planning kick to begin work. Fire and
  // forget — if it fails, the task still exists and the user can kick it
  // manually from the embedded view.
  fetch(`${helixUrl}/api/v1/spec-tasks/${task.id}/start-planning`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${helixApiKey}` },
  }).catch((err) => console.warn(`start-planning kick failed for ${task.id}:`, err))

  const tokenParam = `?access_token=${encodeURIComponent(helixApiKey)}`
  const viewUrl = `${helixUrl}/orgs/${encodeURIComponent(helixOrgSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.id)}`

  // Persist the task_id directly to the block using service_role (bypasses
  // RLS). The client-side autosave was fragile — closure bugs clobbering
  // state, PGRST116 on draft editions, navigation blowing away the
  // component. This is the authoritative persistence path.
  let persisted = false
  if (blockId && fieldName && sb) {
    try {
      const taskIdKey = `${fieldName}_helix_task_id`
      const promptKey = `${fieldName}_prompt`
      const projectKey = `${fieldName}_helix_project_id`
      const { data: existing } = await sb
        .from('newsletters_edition_blocks')
        .select('content')
        .eq('id', blockId)
        .maybeSingle()
      if (existing) {
        const merged = {
          ...(existing.content || {}),
          [taskIdKey]: task.id,
          [promptKey]: userPrompt,
          [projectKey]: projectId,
        }
        const { error: updateErr } = await sb
          .from('newsletters_edition_blocks')
          .update({ content: merged })
          .eq('id', blockId)
        if (updateErr) {
          console.error(`service_role block update failed for ${blockId}:`, updateErr)
        } else {
          persisted = true
          console.log(`persisted task_id ${task.id} to block ${blockId} field ${fieldName}`)
        }
      }
    } catch (err) {
      console.error('service_role persist failed:', err)
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      task_id: task.id,
      project_id: projectId,
      embed_url: `${helixUrl}/embed/task/${task.id}${tokenParam}`,
      view_url: viewUrl,
      persisted,
    }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
}

export default handler
Deno.serve(handler)
