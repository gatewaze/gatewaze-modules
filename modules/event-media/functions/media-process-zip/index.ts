import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateImagePaths } from '../_shared/imageProcessor.ts'

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Parse request
    const { zipUploadId } = await req.json()

    if (!zipUploadId) {
      throw new Error('zipUploadId is required')
    }

    // Initialize Supabase client with service role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    console.log(`Processing zip upload: ${zipUploadId}`)

    // Fetch zip upload record
    const { data: zipUpload, error: fetchError } = await supabase
      .from('events_media_zip_uploads')
      .select('*')
      .eq('id', zipUploadId)
      .single()

    if (fetchError || !zipUpload) {
      throw new Error(`Failed to fetch zip upload record: ${fetchError?.message}`)
    }

    console.log(`Found zip upload: ${zipUpload.file_name}`)

    // Update status to processing
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('id', zipUploadId)

    // Download zip file from storage
    const { data: zipBlob, error: downloadError } = await supabase.storage
      .from('media')
      .download(zipUpload.storage_path)

    if (downloadError || !zipBlob) {
      throw new Error(`Failed to download zip file: ${downloadError?.message}`)
    }

    console.log(`Downloaded zip file: ${zipBlob.size} bytes`)

    // Load JSZip dynamically
    const JSZip = (await import('https://esm.sh/jszip@3.10.1')).default

    // Load zip contents
    const zipData = await zipBlob.arrayBuffer()
    const zip = await JSZip.loadAsync(zipData)

    // Get all files (excluding directories and system files)
    const files = Object.values(zip.files).filter(f =>
      !f.dir &&
      !f.name.startsWith('__MACOSX/') &&
      !f.name.includes('/.') &&
      !f.name.startsWith('.')
    )

    const totalCount = files.length
    console.log(`Found ${totalCount} files in zip`)

    await supabase
      .from('events_media_zip_uploads')
      .update({ total_count: totalCount })
      .eq('id', zipUploadId)

    // Process each file
    let processedCount = 0
    const albumMap = new Map<string, string>() // folder name -> album id
    const errors: string[] = []

    for (const file of files) {
      try {
        // Extract folder name from path
        const folderName = extractFolderName(file.name)
        console.log(`Processing file: ${file.name}, folder: ${folderName || 'root'}`)

        // Get or create album if file is in a folder
        let albumId: string | null = null
        if (folderName) {
          albumId = albumMap.get(folderName) || null
          if (!albumId) {
            albumId = await getOrCreateAlbum(supabase, zipUpload.event_id, folderName)
            if (albumId) {
              albumMap.set(folderName, albumId)
            }
          }
        }

        // Extract file content
        const content = await file.async('uint8array')
        const fileName = extractFileName(file.name)

        // Determine file type and mime type
        const mimeType = getMimeType(fileName)
        const fileType = mimeType.startsWith('image/') ? 'photo' :
                        mimeType.startsWith('video/') ? 'video' : null

        if (!fileType) {
          console.log(`Skipping unsupported file type: ${fileName}`)
          continue
        }

        // Upload to storage
        const timestamp = Date.now()
        const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_')
        const storagePath = `events/${zipUpload.event_id}/${fileType}s/original/${timestamp}-${sanitizedName}`

        const { error: uploadError } = await supabase.storage
          .from('media')
          .upload(storagePath, content, {
            contentType: mimeType,
            cacheControl: '3600'
          })

        if (uploadError) {
          throw new Error(`Upload failed: ${uploadError.message}`)
        }

        // Note: We'll use Supabase's built-in image transformation instead of pre-generating thumbnails
        // This avoids CPU timeout issues in Edge Functions and reduces storage usage
        // Images will be transformed on-the-fly when requested with transform parameters

        // Create media record
        const { data: media, error: mediaError} = await supabase
          .from('events_media')
          .insert({
            event_id: zipUpload.event_id,
            file_name: fileName,
            storage_path: storagePath,
            file_type: fileType,
            mime_type: mimeType,
            file_size: content.length,
            uploaded_by: 'admin',
            upload_source: 'zip_upload',
            is_approved: true,
            metadata: {}
          })
          .select()
          .single()

        if (mediaError) {
          throw new Error(`Database insert failed: ${mediaError.message}`)
        }

        // Add to album if one exists
        if (albumId && media) {
          await supabase
            .from('events_media_album_items')
            .insert({
              media_id: media.id,
              album_id: albumId,
              sort_order: processedCount
            })
        }

        processedCount++
        console.log(`Processed ${processedCount}/${totalCount}: ${fileName}`)

        // Update progress every 5 files
        if (processedCount % 5 === 0) {
          await supabase
            .from('events_media_zip_uploads')
            .update({ processed_count: processedCount })
            .eq('id', zipUploadId)
        }

      } catch (error) {
        const errorMsg = `Error processing ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
        console.error(errorMsg)
        errors.push(errorMsg)
        // Continue with next file
      }
    }

    // Final progress update
    await supabase
      .from('events_media_zip_uploads')
      .update({ processed_count: processedCount })
      .eq('id', zipUploadId)

    // Mark as completed
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'completed',
        processing_completed_at: new Date().toISOString(),
        error_message: errors.length > 0 ? errors.join('; ') : null
      })
      .eq('id', zipUploadId)

    console.log(`Completed processing: ${processedCount}/${totalCount} files`)

    // Delete the ZIP file from storage after successful processing
    try {
      const { error: deleteError } = await supabase.storage
        .from('media')
        .remove([zipUpload.storage_path])

      if (deleteError) {
        console.error('Failed to delete ZIP file from storage:', deleteError)
      } else {
        console.log(`Deleted ZIP file from storage: ${zipUpload.storage_path}`)
      }
    } catch (cleanupError) {
      console.error('Error during ZIP cleanup:', cleanupError)
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        total: totalCount,
        errors: errors.length > 0 ? errors : undefined
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    )

  } catch (error) {
    console.error('Error processing zip:', error)

    // Try to update status to failed
    try {
      const { zipUploadId } = await req.json()
      if (zipUploadId) {
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        )
        await supabase
          .from('events_media_zip_uploads')
          .update({
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Unknown error',
            processing_completed_at: new Date().toISOString()
          })
          .eq('id', zipUploadId)
      }
    } catch (updateError) {
      console.error('Failed to update error status:', updateError)
    }

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

// Helper functions

function extractFolderName(filePath: string): string | null {
  const parts = filePath.split('/').filter(p => p && p !== '__MACOSX')

  // If file is in root (no folders), return null
  if (parts.length <= 1) {
    return null
  }

  // Get all folder parts (exclude the filename)
  const folderParts = parts.slice(0, -1)

  // Join nested folders with separator
  // Example: "Day 1/Morning" becomes "Day 1 - Morning"
  return folderParts.join(' - ')
}

function extractFileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1]
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    // Videos
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    m4v: 'video/x-m4v',
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

async function getOrCreateAlbum(
  supabase: any,
  eventId: string,
  albumName: string
): Promise<string | null> {
  try {
    // Check if album exists
    const { data: existing } = await supabase
      .from('events_media_albums')
      .select('id')
      .eq('event_id', eventId)
      .eq('name', albumName)
      .maybeSingle()

    if (existing) {
      console.log(`Using existing album: ${albumName}`)
      return existing.id
    }

    // Create new album
    const { data: newAlbum, error } = await supabase
      .from('events_media_albums')
      .insert({
        event_id: eventId,
        name: albumName,
        description: `Auto-created from zip upload`
      })
      .select()
      .single()

    if (error) {
      console.error(`Failed to create album ${albumName}:`, error)
      return null
    }

    console.log(`Created new album: ${albumName}`)
    return newAlbum.id
  } catch (error) {
    console.error(`Error in getOrCreateAlbum:`, error)
    return null
  }
}
