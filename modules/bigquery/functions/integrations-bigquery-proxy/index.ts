import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

/**
 * BigQuery Proxy Edge Function
 *
 * Provides a secure proxy to BigQuery for:
 * - Executing queries
 * - Creating/refreshing materialized views
 * - Browsing datasets and table schemas
 *
 * Environment variables required:
 * - BIGQUERY_PROJECT_ID: GCP project ID
 * - BIGQUERY_CREDENTIALS_JSON: Service account credentials JSON
 * - BIGQUERY_LOCATION: BigQuery location (default: US)
 */

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const bigqueryProjectId = Deno.env.get('BIGQUERY_PROJECT_ID')
const bigqueryCredentialsJson = Deno.env.get('BIGQUERY_CREDENTIALS_JSON')
const bigqueryLocation = Deno.env.get('BIGQUERY_LOCATION') || 'US'

// API key for authenticating requests from the frontend
const API_BEARER_TOKEN = Deno.env.get('GW_API_BEARER') || 'YYv8gvrl55fVPmJDQAWz8JLmhtpZpWF1MlqOrv8dfs7yPfMHPLHTdAlUeJcDiIUe'

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface BigQueryCredentials {
  type: string
  project_id: string
  private_key_id: string
  private_key: string
  client_email: string
  client_id: string
  auth_uri: string
  token_uri: string
}

interface QueryResult {
  data: Record<string, unknown>[]
  metadata: {
    totalRows: number
    bytesProcessed: number
    durationMs: number
    cacheHit: boolean
  }
}

// ============================================================================
// JWT Generation for Google OAuth
// ============================================================================

async function createJWT(credentials: BigQueryCredentials): Promise<string> {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  }

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/bigquery',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const encoder = new TextEncoder()
  const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const signatureInput = `${headerB64}.${payloadB64}`

  // Import the private key
  const pemHeader = '-----BEGIN PRIVATE KEY-----'
  const pemFooter = '-----END PRIVATE KEY-----'
  const pemContents = credentials.private_key
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s/g, '')

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signatureInput)
  )

  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  return `${signatureInput}.${signatureB64}`
}

async function getAccessToken(credentials: BigQueryCredentials): Promise<string> {
  const jwt = await createJWT(credentials)

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to get access token: ${error}`)
  }

  const data = await response.json()
  return data.access_token
}

// ============================================================================
// BigQuery API Calls
// ============================================================================

async function executeQuery(
  accessToken: string,
  projectId: string,
  sql: string,
  parameters?: Record<string, unknown>
): Promise<QueryResult> {
  const startTime = Date.now()

  // Build query parameters if provided
  const queryParameters = parameters ? Object.entries(parameters).map(([name, value]) => ({
    name,
    parameterType: { type: typeof value === 'number' ? 'INT64' : 'STRING' },
    parameterValue: { value: String(value) },
  })) : undefined

  const requestBody: Record<string, unknown> = {
    query: sql,
    useLegacySql: false,
    location: bigqueryLocation,
    maxResults: 10000, // Limit results
  }

  if (queryParameters && queryParameters.length > 0) {
    requestBody.parameterMode = 'NAMED'
    requestBody.queryParameters = queryParameters
  }

  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'BigQuery query failed')
  }

  const result = await response.json()
  const durationMs = Date.now() - startTime

  // Transform rows to objects
  const fields = result.schema?.fields || []
  const rows = (result.rows || []).map((row: { f: { v: unknown }[] }) => {
    const obj: Record<string, unknown> = {}
    row.f.forEach((cell, index) => {
      const field = fields[index]
      obj[field.name] = cell.v
    })
    return obj
  })

  return {
    data: rows,
    metadata: {
      totalRows: parseInt(result.totalRows || '0'),
      bytesProcessed: parseInt(result.totalBytesProcessed || '0'),
      durationMs,
      cacheHit: result.cacheHit || false,
    },
  }
}

async function listDatasets(accessToken: string, projectId: string): Promise<{ datasets: { id: string; location: string }[] }> {
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to list datasets')
  }

  const result = await response.json()
  const datasets = (result.datasets || []).map((ds: { datasetReference: { datasetId: string }; location: string }) => ({
    id: ds.datasetReference.datasetId,
    location: ds.location,
  }))

  return { datasets }
}

async function listTables(
  accessToken: string,
  projectId: string,
  datasetId: string
): Promise<{ tables: { id: string; type: string; rowCount?: string; sizeBytes?: string }[] }> {
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}/tables`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to list tables')
  }

  const result = await response.json()
  const tables = (result.tables || []).map((table: {
    tableReference: { tableId: string }
    type: string
    numRows?: string
    numBytes?: string
  }) => ({
    id: table.tableReference.tableId,
    type: table.type,
    rowCount: table.numRows,
    sizeBytes: table.numBytes,
  }))

  return { tables }
}

async function getTableSchema(
  accessToken: string,
  projectId: string,
  datasetId: string,
  tableId: string
): Promise<{ fields: { name: string; type: string; mode: string; description?: string }[] }> {
  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/datasets/${datasetId}/tables/${tableId}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to get table schema')
  }

  const result = await response.json()
  const fields = (result.schema?.fields || []).map((field: {
    name: string
    type: string
    mode?: string
    description?: string
  }) => ({
    name: field.name,
    type: field.type,
    mode: field.mode || 'NULLABLE',
    description: field.description,
  }))

  return { fields }
}

async function materializeQuery(
  accessToken: string,
  projectId: string,
  sql: string,
  destinationTable: string
): Promise<{ rowsWritten: number; bytesProcessed: number }> {
  // Parse destination table (format: dataset.table)
  const [datasetId, tableId] = destinationTable.split('.')
  if (!datasetId || !tableId) {
    throw new Error('Invalid destination table format. Expected: dataset.table')
  }

  const response = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        location: bigqueryLocation,
        destinationTable: {
          projectId,
          datasetId,
          tableId,
        },
        writeDisposition: 'WRITE_TRUNCATE', // Overwrite existing table
        createDisposition: 'CREATE_IF_NEEDED',
      }),
    }
  )

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error?.message || 'Failed to materialize query')
  }

  const result = await response.json()
  return {
    rowsWritten: parseInt(result.numDmlAffectedRows || result.totalRows || '0'),
    bytesProcessed: parseInt(result.totalBytesProcessed || '0'),
  }
}

// ============================================================================
// SQL Validation
// ============================================================================

function validateQuery(sql: string, allowMaterialization: boolean = false): void {
  const upperSql = sql.toUpperCase().trim()

  // List of dangerous keywords to block
  const blockedKeywords = [
    'DROP',
    'DELETE',
    'TRUNCATE',
    'ALTER',
    'GRANT',
    'REVOKE',
    'CREATE USER',
    'CREATE ROLE',
  ]

  // If not materializing, also block INSERT, UPDATE, MERGE, CREATE TABLE
  if (!allowMaterialization) {
    blockedKeywords.push('INSERT', 'UPDATE', 'MERGE', 'CREATE')
  }

  for (const keyword of blockedKeywords) {
    // Use word boundary matching to avoid false positives
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    if (regex.test(sql)) {
      throw new Error(`Query contains blocked keyword: ${keyword}`)
    }
  }

  // Must start with SELECT or WITH (for CTEs)
  if (!upperSql.startsWith('SELECT') && !upperSql.startsWith('WITH')) {
    throw new Error('Query must start with SELECT or WITH')
  }
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleExecute(
  req: Request,
  credentials: BigQueryCredentials,
  userId?: string
): Promise<Response> {
  const body = await req.json()
  const { sql, parameters, save_log = true } = body

  if (!sql) {
    return new Response(
      JSON.stringify({ error: 'SQL query is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validate query
  try {
    validateQuery(sql)
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Query validation failed' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const accessToken = await getAccessToken(credentials)
  const result = await executeQuery(accessToken, credentials.project_id, sql, parameters)

  // Log query execution
  if (save_log) {
    await supabase.from('bigquery_query_logs').insert({
      sql_query: sql,
      parameters,
      status: 'success',
      rows_returned: result.data.length,
      bytes_processed: result.metadata.bytesProcessed,
      duration_ms: result.metadata.durationMs,
      executed_by: userId,
    })
  }

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

async function handleMaterialize(
  req: Request,
  credentials: BigQueryCredentials,
  userId?: string
): Promise<Response> {
  const body = await req.json()
  const { query_id, sql, destination_table } = body

  let queryToMaterialize: string
  let destinationTableName: string
  let savedQueryId: string | null = null

  if (query_id) {
    // Get saved query from database
    const { data: savedQuery, error } = await supabase
      .from('bigquery_saved_queries')
      .select('*')
      .eq('id', query_id)
      .single()

    if (error || !savedQuery) {
      return new Response(
        JSON.stringify({ error: 'Saved query not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    queryToMaterialize = savedQuery.sql_query
    destinationTableName = savedQuery.materialized_table
    savedQueryId = query_id
  } else if (sql && destination_table) {
    queryToMaterialize = sql
    destinationTableName = destination_table
  } else {
    return new Response(
      JSON.stringify({ error: 'Either query_id or (sql + destination_table) is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  if (!destinationTableName) {
    return new Response(
      JSON.stringify({ error: 'No destination table specified' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Create log entry
  const { data: logEntry } = await supabase
    .from('bigquery_materialization_logs')
    .insert({
      query_id: savedQueryId,
      status: 'running',
      triggered_by: userId,
    })
    .select()
    .single()

  try {
    const accessToken = await getAccessToken(credentials)
    const startTime = Date.now()
    const result = await materializeQuery(accessToken, credentials.project_id, queryToMaterialize, destinationTableName)
    const durationMs = Date.now() - startTime

    // Update log entry
    if (logEntry) {
      await supabase
        .from('bigquery_materialization_logs')
        .update({
          status: 'success',
          rows_written: result.rowsWritten,
          bytes_processed: result.bytesProcessed,
          duration_ms: durationMs,
        })
        .eq('id', logEntry.id)
    }

    // Update saved query last_materialized_at
    if (savedQueryId) {
      await supabase
        .from('bigquery_saved_queries')
        .update({ last_materialized_at: new Date().toISOString() })
        .eq('id', savedQueryId)
    }

    return new Response(
      JSON.stringify({
        success: true,
        rowsWritten: result.rowsWritten,
        bytesProcessed: result.bytesProcessed,
        durationMs,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    // Update log entry with error
    if (logEntry) {
      await supabase
        .from('bigquery_materialization_logs')
        .update({
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
        })
        .eq('id', logEntry.id)
    }

    throw error
  }
}

async function handleListDatasets(credentials: BigQueryCredentials): Promise<Response> {
  const accessToken = await getAccessToken(credentials)
  const result = await listDatasets(accessToken, credentials.project_id)

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

async function handleListTables(req: Request, credentials: BigQueryCredentials): Promise<Response> {
  const url = new URL(req.url)
  const datasetId = url.searchParams.get('dataset')

  if (!datasetId) {
    return new Response(
      JSON.stringify({ error: 'dataset parameter is required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const accessToken = await getAccessToken(credentials)
  const result = await listTables(accessToken, credentials.project_id, datasetId)

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

async function handleGetSchema(req: Request, credentials: BigQueryCredentials): Promise<Response> {
  const url = new URL(req.url)
  const datasetId = url.searchParams.get('dataset')
  const tableId = url.searchParams.get('table')

  if (!datasetId || !tableId) {
    return new Response(
      JSON.stringify({ error: 'dataset and table parameters are required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  const accessToken = await getAccessToken(credentials)
  const result = await getTableSchema(accessToken, credentials.project_id, datasetId, tableId)

  return new Response(
    JSON.stringify(result),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  )
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Check BigQuery configuration
  if (!bigqueryProjectId || !bigqueryCredentialsJson) {
    return new Response(
      JSON.stringify({ error: 'BigQuery is not configured for this environment' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Validate Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== API_BEARER_TOKEN) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Parse credentials
  let credentials: BigQueryCredentials
  try {
    credentials = JSON.parse(bigqueryCredentialsJson)
    // Override project_id with explicit env var if provided
    if (bigqueryProjectId) {
      credentials.project_id = bigqueryProjectId
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid BigQuery credentials configuration' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  // Extract user ID from Supabase JWT if present
  let userId: string | undefined
  const supabaseAuthHeader = req.headers.get('x-supabase-auth')
  if (supabaseAuthHeader) {
    try {
      const { data: { user } } = await supabase.auth.getUser(supabaseAuthHeader)
      userId = user?.id
    } catch {
      // Ignore auth errors, proceed without user ID
    }
  }

  // Route request based on path
  const url = new URL(req.url)
  const path = url.pathname.split('/').pop()

  try {
    switch (path) {
      case 'execute':
        if (req.method !== 'POST') {
          return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return await handleExecute(req, credentials, userId)

      case 'materialize':
        if (req.method !== 'POST') {
          return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return await handleMaterialize(req, credentials, userId)

      case 'datasets':
        if (req.method !== 'GET') {
          return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return await handleListDatasets(credentials)

      case 'tables':
        if (req.method !== 'GET') {
          return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return await handleListTables(req, credentials)

      case 'schema':
        if (req.method !== 'GET') {
          return new Response(
            JSON.stringify({ error: 'Method not allowed' }),
            { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          )
        }
        return await handleGetSchema(req, credentials)

      default:
        return new Response(
          JSON.stringify({
            error: 'Not found',
            available_endpoints: ['/execute', '/materialize', '/datasets', '/tables', '/schema']
          }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
    }
  } catch (error) {
    console.error('BigQuery proxy error:', error)

    // Log failed query if applicable
    if (path === 'execute' && req.method === 'POST') {
      try {
        const body = await req.clone().json()
        await supabase.from('bigquery_query_logs').insert({
          sql_query: body.sql || '',
          parameters: body.parameters,
          status: 'failed',
          error_message: error instanceof Error ? error.message : 'Unknown error',
          executed_by: userId,
        })
      } catch {
        // Ignore logging errors
      }
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
