import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// host_media is the only table this function processes. The legacy
// events_media branch (and its 'events_media' default for the `table`
// param) was deleted when those tables were retired — migration 027.
// `table` is still accepted so existing callers that pass
// { table: 'host_media' } keep working; anything else is refused rather
// than silently processed as something the caller did not mean.
Deno.serve(async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { mediaId, table } = await req.json()

    if (!mediaId) {
      throw new Error('mediaId is required')
    }
    if (table !== undefined && table !== 'host_media') {
      return new Response(
        JSON.stringify({ success: false, error: `Unknown table: ${table}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    console.log(`Processing host_media image: ${mediaId}`)

    // Same Sharp/ImageMagick variants as always, written into the row's
    // `variants` jsonb ({ thumb, medium } storage paths).
    // Honour the same bucket override the API layer uses.
    const hostBucket = Deno.env.get('HOST_MEDIA_BUCKET') ?? 'media'
    const { data: hostMedia, error: hostFetchError } = await supabase
      .from('host_media')
      .select('id, storage_path, mime_type, variants')
      .eq('id', mediaId)
      .single()

    if (hostFetchError || !hostMedia) {
      throw new Error(`Failed to fetch host_media record: ${hostFetchError?.message}`)
    }
    if (!String(hostMedia.mime_type ?? '').startsWith('image/')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Not a photo' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }
    // Idempotency guard: variants already exist → nothing to do. Also
    // bounds abuse by anon-key callers re-triggering arbitrary rows —
    // an existing row can't be endlessly reprocessed/overwritten.
    if (hostMedia.variants?.thumb && hostMedia.variants?.medium) {
      return new Response(
        JSON.stringify({ success: true, thumbnailPath: hostMedia.variants.thumb, mediumPath: hostMedia.variants.medium, skipped: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    const { data: blob, error: dlError } = await supabase.storage
      .from(hostBucket)
      .download(hostMedia.storage_path)
    if (dlError || !blob) {
      throw new Error(`Failed to download image: ${dlError?.message}`)
    }

    const buffer = new Uint8Array(await blob.arrayBuffer())
    const { processImage } = await import('../_shared/imageProcessor.ts')
    const processed = await processImage(buffer)

    // Variants live next to the original: <dir>/variants/{thumb,medium}.jpg
    const dir = hostMedia.storage_path.replace(/\/[^/]+$/, '')
    const thumbPath = `${dir}/variants/thumb.jpg`
    const mediumPath = `${dir}/variants/medium.jpg`

    for (const [path, bytes] of [[thumbPath, processed.thumbnail], [mediumPath, processed.medium]] as const) {
      const { error: upError } = await supabase.storage
        .from(hostBucket)
        .upload(path, bytes, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: true })
      if (upError) {
        throw new Error(`Failed to upload variant ${path}: ${upError.message}`)
      }
    }

    const { error: updError } = await supabase
      .from('host_media')
      .update({
        variants: { ...(hostMedia.variants ?? {}), thumb: thumbPath, medium: mediumPath },
      })
      .eq('id', mediaId)
    if (updError) {
      throw new Error(`Failed to update host_media record: ${updError.message}`)
    }

    console.log(`Successfully processed host_media image: ${mediaId}`)
    return new Response(
      JSON.stringify({ success: true, thumbnailPath: thumbPath, mediumPath }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    console.error('Error processing image:', error)

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      }
    )
  }
})
