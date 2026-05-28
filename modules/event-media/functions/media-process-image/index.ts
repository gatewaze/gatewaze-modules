import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateImagePaths } from '../_shared/imageProcessor.ts'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export default async function(req: Request) {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { mediaId } = await req.json()

    if (!mediaId) {
      throw new Error('mediaId is required')
    }

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    console.log(`Processing image: ${mediaId}`)

    // Fetch media record
    const { data: media, error: fetchError } = await supabase
      .from('events_media')
      .select('*')
      .eq('id', mediaId)
      .single()

    if (fetchError || !media) {
      throw new Error(`Failed to fetch media record: ${fetchError?.message}`)
    }

    // Only process photos
    if (media.file_type !== 'photo') {
      return new Response(
        JSON.stringify({ success: false, error: 'Not a photo' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    console.log(`Downloading original: ${media.storage_path}`)

    // Download original image
    const { data: imageBlob, error: downloadError } = await supabase.storage
      .from('media')
      .download(media.storage_path)

    if (downloadError || !imageBlob) {
      throw new Error(`Failed to download image: ${downloadError?.message}`)
    }

    // Convert blob to Uint8Array
    const imageBuffer = new Uint8Array(await imageBlob.arrayBuffer())

    console.log(`Processing image variants for: ${media.file_name}`)
    const { processImage } = await import('../_shared/imageProcessor.ts')
    const processed = await processImage(imageBuffer)
    const paths = generateImagePaths(media.storage_path)

    // Upload thumbnail
    const { error: thumbError } = await supabase.storage
      .from('media')
      .upload(paths.thumbnailPath, processed.thumbnail, {
        contentType: 'image/jpeg',
        cacheControl: '31536000', // 1 year
        upsert: true
      })

    if (thumbError) {
      console.error(`Failed to upload thumbnail: ${thumbError.message}`)
      throw new Error(`Failed to upload thumbnail: ${thumbError.message}`)
    }

    console.log(`Created thumbnail: ${paths.thumbnailPath}`)

    // Upload medium
    const { error: mediumError } = await supabase.storage
      .from('media')
      .upload(paths.mediumPath, processed.medium, {
        contentType: 'image/jpeg',
        cacheControl: '31536000', // 1 year
        upsert: true
      })

    if (mediumError) {
      console.error(`Failed to upload medium: ${mediumError.message}`)
      throw new Error(`Failed to upload medium: ${mediumError.message}`)
    }

    console.log(`Created medium: ${paths.mediumPath}`)

    // Update media record with paths
    const { error: updateError } = await supabase
      .from('events_media')
      .update({
        thumbnail_path: paths.thumbnailPath,
        metadata: {
          ...media.metadata,
          medium_path: paths.mediumPath,
          processed: true
        }
      })
      .eq('id', mediaId)

    if (updateError) {
      throw new Error(`Failed to update media record: ${updateError.message}`)
    }

    console.log(`Successfully processed image: ${mediaId}`)

    return new Response(
      JSON.stringify({
        success: true,
        thumbnailPath: paths.thumbnailPath,
        mediumPath: paths.mediumPath
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
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
}
