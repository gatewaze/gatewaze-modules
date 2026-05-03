const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * Newsletter → Helix: mint a fresh embed URL for an existing task.
 *
 * GET ?task_id=spt_...
 *   → 200 { embed_url, view_url }
 *
 * Block content stores only the bare task_id. The browser calls this
 * endpoint when it needs to render the iframe — the URL (with the API
 * key as access_token) is generated fresh and only ever lives in
 * component state, never persisted.
 */

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ success: false, error: 'GET only' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
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

  const url = new URL(req.url)
  const taskId = url.searchParams.get('task_id') || ''
  if (!/^spt_[a-z0-9]+$/.test(taskId)) {
    return new Response(
      JSON.stringify({ success: false, error: 'task_id is required and must look like spt_...' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const tokenParam = `?access_token=${encodeURIComponent(helixApiKey)}`
  const embedUrl = `${helixUrl}/embed/task/${taskId}${tokenParam}`

  const orgSlug = Deno.env.get('HELIX_ORG_SLUG') || url.searchParams.get('org_slug') || '_'
  const projectId = url.searchParams.get('project_id') || Deno.env.get('HELIX_PROJECT_ID') || '_'
  const viewUrl = `${helixUrl}/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`

  return new Response(
    JSON.stringify({ success: true, embed_url: embedUrl, view_url: viewUrl }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
}

export default handler
Deno.serve(handler)
