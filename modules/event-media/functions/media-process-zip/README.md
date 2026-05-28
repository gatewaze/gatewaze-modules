# Process Media ZIP Edge Function

This Edge Function processes zip files containing event photos and videos, automatically extracting them and creating albums based on folder structure.

## Status

🔄 **Not Yet Implemented** - This is a placeholder for future development.

## Purpose

When event organizers receive photos from photographers (typically delivered as zip files with organized folders), this function:

1. Extracts files from uploaded zip
2. Creates albums based on folder structure
3. Uploads individual media files to storage
4. Creates database records with metadata
5. Tracks processing progress

## Trigger

This function should be triggered when:
- A new record is inserted into `event_media_zip_uploads` table
- Status is set to 'pending'

## Implementation Plan

### 1. Setup

```bash
# Create the function
npx supabase functions new process-media-zip

# Add dependencies
# Create supabase/functions/process-media-zip/deno.json with:
{
  "imports": {
    "jszip": "https://esm.sh/jszip@3.10.1",
    "mime": "https://esm.sh/mime@3.0.0"
  }
}
```

### 2. Function Flow

```typescript
// supabase/functions/process-media-zip/index.ts

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import JSZip from 'https://esm.sh/jszip@3.10.1'

serve(async (req) => {
  try {
    // 1. Parse request
    const { zipUploadId } = await req.json()

    // 2. Initialize Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 3. Fetch zip upload record
    const { data: zipUpload, error: fetchError } = await supabase
      .from('events_media_zip_uploads')
      .select('*')
      .eq('id', zipUploadId)
      .single()

    if (fetchError) throw fetchError

    // 4. Update status to processing
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'processing',
        processing_started_at: new Date().toISOString()
      })
      .eq('id', zipUploadId)

    // 5. Download zip file from storage
    const { data: zipBlob, error: downloadError } = await supabase.storage
      .from('media')
      .download(zipUpload.storage_path)

    if (downloadError) throw downloadError

    // 6. Load zip contents
    const zipData = await zipBlob.arrayBuffer()
    const zip = await JSZip.loadAsync(zipData)

    // 7. Count total files
    const files = Object.values(zip.files).filter(f => !f.dir)
    const totalCount = files.length

    await supabase
      .from('events_media_zip_uploads')
      .update({ total_count: totalCount })
      .eq('id', zipUploadId)

    // 8. Process each file
    let processedCount = 0
    const albumMap = new Map<string, string>() // folder name -> album id

    for (const file of files) {
      try {
        // Extract folder name
        const folderName = extractFolderName(file.name)

        // Get or create album
        let albumId = albumMap.get(folderName)
        if (!albumId && folderName) {
          albumId = await getOrCreateAlbum(supabase, zipUpload.event_id, folderName)
          albumMap.set(folderName, albumId)
        }

        // Extract file content
        const content = await file.async('uint8array')
        const fileName = extractFileName(file.name)

        // Determine file type
        const mimeType = getMimeType(fileName)
        const fileType = mimeType.startsWith('image/') ? 'photo' : 'video'

        // Upload to storage
        const timestamp = Date.now()
        const storagePath = `events/${zipUpload.event_id}/${fileType}s/original/${timestamp}-${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('media')
          .upload(storagePath, content, {
            contentType: mimeType,
            cacheControl: '3600'
          })

        if (uploadError) throw uploadError

        // Create media record
        const { data: media, error: mediaError } = await supabase
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
            is_approved: true
          })
          .select()
          .single()

        if (mediaError) throw mediaError

        // Add to album if folder exists
        if (albumId) {
          await supabase
            .from('events_media_album_items')
            .insert({
              media_id: media.id,
              album_id: albumId,
              sort_order: processedCount
            })
        }

        processedCount++

        // Update progress
        await supabase
          .from('events_media_zip_uploads')
          .update({ processed_count: processedCount })
          .eq('id', zipUploadId)

      } catch (error) {
        console.error(`Error processing file ${file.name}:`, error)
        // Continue with next file
      }
    }

    // 9. Mark as completed
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'completed',
        processing_completed_at: new Date().toISOString()
      })
      .eq('id', zipUploadId)

    return new Response(
      JSON.stringify({
        success: true,
        processed: processedCount,
        total: totalCount
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Error processing zip:', error)

    // Update status to failed
    if (zipUploadId) {
      await supabase
        .from('events_media_zip_uploads')
        .update({
          status: 'failed',
          error_message: error.message,
          processing_completed_at: new Date().toISOString()
        })
        .eq('id', zipUploadId)
    }

    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})

// Helper functions
function extractFolderName(filePath: string): string | null {
  const parts = filePath.split('/')
  if (parts.length > 1) {
    return parts[0] // First folder
  }
  return null
}

function extractFileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1]
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo'
  }
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

async function getOrCreateAlbum(
  supabase: any,
  eventId: string,
  albumName: string
): Promise<string> {
  // Check if album exists
  const { data: existing } = await supabase
    .from('events_media_albums')
    .select('id')
    .eq('event_id', eventId)
    .eq('name', albumName)
    .single()

  if (existing) return existing.id

  // Create new album
  const { data: newAlbum } = await supabase
    .from('events_media_albums')
    .insert({
      event_id: eventId,
      name: albumName,
      description: `Auto-created from zip upload`
    })
    .select()
    .single()

  return newAlbum.id
}
```

### 3. Deployment

```bash
# Deploy function
npx supabase functions deploy process-media-zip

# Set environment variables (if not already set)
npx supabase secrets set SUPABASE_URL=your_supabase_url
npx supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

### 4. Testing

```bash
# Test locally
npx supabase functions serve process-media-zip

# Call the function
curl -X POST http://localhost:54321/functions/v1/process-media-zip \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"zipUploadId": "uuid-here"}'
```

## Database Trigger (Optional)

Automatically trigger the function when a zip upload is created:

```sql
-- Create trigger function
CREATE OR REPLACE FUNCTION trigger_process_media_zip()
RETURNS TRIGGER AS $$
BEGIN
  -- Call Edge Function via HTTP
  PERFORM net.http_post(
    url := 'https://your-project.supabase.co/functions/v1/process-media-zip',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')
    ),
    body := jsonb_build_object('zipUploadId', NEW.id)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to table
CREATE TRIGGER on_zip_upload_created
  AFTER INSERT ON event_media_zip_uploads
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION trigger_process_media_zip();
```

## UI Integration

Update `MediaUploadModal.tsx` to add zip upload option:

```typescript
// Add state for zip upload
const [isZipUpload, setIsZipUpload] = useState(false)

// Add zip file input
<input
  ref={zipFileInputRef}
  type="file"
  accept=".zip"
  onChange={handleZipFileSelect}
  className="hidden"
/>

// Handle zip upload
const handleZipUpload = async (file: File) => {
  // 1. Upload zip to storage
  const storagePath = `events/${eventId}/zip-uploads/${Date.now()}-${file.name}`
  const { data, error } = await supabase.storage
    .from('media')
    .upload(storagePath, file)

  if (error) {
    toast.error('Failed to upload zip file')
    return
  }

  // 2. Create zip upload record (will trigger processing)
  const { error: dbError } = await supabase
    .from('events_media_zip_uploads')
    .insert({
      event_id: eventId,
      file_name: file.name,
      storage_path: storagePath,
      file_size: file.size,
      status: 'pending'
    })

  if (dbError) {
    toast.error('Failed to create upload record')
    return
  }

  toast.success('Zip file uploaded! Processing will begin shortly.')
}
```

## Monitoring

Add a view to track zip processing status:

```typescript
// In EventMediaTab.tsx
const [zipUploads, setZipUploads] = useState<EventMediaZipUpload[]>([])

// Load zip uploads
const { data, error } = await supabase
  .from('events_media_zip_uploads')
  .select('*')
  .eq('event_id', eventId)
  .order('created_at', { ascending: false })

// Display processing status
{zipUploads.map(upload => (
  <div key={upload.id}>
    <h4>{upload.file_name}</h4>
    <p>Status: {upload.status}</p>
    {upload.status === 'processing' && (
      <p>Processed: {upload.processed_count} / {upload.total_count}</p>
    )}
  </div>
))}
```

## Error Handling

- Invalid zip files: Log error and mark as failed
- Unsupported file types: Skip and continue
- Storage errors: Retry with exponential backoff
- Duplicate files: Skip or overwrite based on settings

## Performance Considerations

- Process files in batches (e.g., 10 at a time)
- Use streaming for large files
- Implement timeout (max 10 minutes per zip)
- Add rate limiting to avoid overwhelming storage

## Security

- Validate zip file before processing
- Scan for malicious content (future)
- Limit max zip size (500MB recommended)
- Validate extracted file types
- Use service role key (not exposed to client)

---

**Status**: 📝 Planning/Design phase
**Priority**: Medium
**Estimated Time**: 4-6 hours
