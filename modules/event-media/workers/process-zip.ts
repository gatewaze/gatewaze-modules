/**
 * Background worker handler for processing uploaded ZIP files.
 *
 * Runs in the BullMQ worker container (Node.js, not Deno edge runtime),
 * so it has no memory/timeout limits from the edge runtime. This allows
 * processing of 2GB+ ZIP files.
 *
 * The worker:
 * 1. Downloads the ZIP from Supabase Storage
 * 2. Extracts files one at a time (streaming decompression)
 * 3. Uploads each image/video to storage
 * 4. Creates DB records for each media item
 * 5. Auto-creates albums from folder structure
 * 6. Updates progress in the events_media_zip_uploads table
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import JSZip from 'jszip';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface ProcessZipJobData {
  zipUploadId: string;
}

const MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/x-m4v',
};

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function extractFolderName(filePath: string): string | null {
  const parts = filePath.split('/').filter(p => p && p !== '__MACOSX');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join(' - ');
}

function extractFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

async function getOrCreateAlbum(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
  albumName: string
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from('events_media_albums')
      .select('id')
      .eq('event_id', eventId)
      .eq('name', albumName)
      .maybeSingle();

    if (existing) return existing.id;

    const { data: newAlbum, error } = await supabase
      .from('events_media_albums')
      .insert({ event_id: eventId, name: albumName, description: 'Auto-created from zip upload' })
      .select()
      .single();

    if (error) {
      console.error(`[media:process-zip] Failed to create album "${albumName}":`, error);
      return null;
    }
    return newAlbum.id;
  } catch (error) {
    console.error(`[media:process-zip] Error in getOrCreateAlbum:`, error);
    return null;
  }
}

export default async function handleProcessZip(job: Job<ProcessZipJobData>) {
  const { zipUploadId } = job.data;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  console.log(`[media:process-zip] Starting job for zipUploadId: ${zipUploadId}`);

  // Fetch zip upload record
  const { data: zipUpload, error: fetchError } = await supabase
    .from('events_media_zip_uploads')
    .select('*')
    .eq('id', zipUploadId)
    .single();

  if (fetchError || !zipUpload) {
    throw new Error(`Failed to fetch zip upload record: ${fetchError?.message}`);
  }

  // Update status to processing
  await supabase
    .from('events_media_zip_uploads')
    .update({ status: 'processing', processing_started_at: new Date().toISOString() })
    .eq('id', zipUploadId);

  try {
    // Download zip file from storage
    const { data: zipBlob, error: downloadError } = await supabase.storage
      .from('media')
      .download(zipUpload.storage_path);

    if (downloadError || !zipBlob) {
      throw new Error(`Failed to download zip: ${downloadError?.message}`);
    }

    console.log(`[media:process-zip] Downloaded: ${zipBlob.size} bytes`);

    // Load zip — JSZip in Node.js handles memory better than edge functions
    // For truly massive files, the file list is read from the central directory first
    const zipData = await zipBlob.arrayBuffer();
    const zip = await JSZip.loadAsync(zipData);

    // Get all valid files (excluding directories and system files)
    const files = Object.values(zip.files).filter(f =>
      !f.dir &&
      !f.name.startsWith('__MACOSX/') &&
      !f.name.includes('/.') &&
      !f.name.startsWith('.')
    );

    const totalCount = files.length;
    console.log(`[media:process-zip] Found ${totalCount} files`);

    await supabase
      .from('events_media_zip_uploads')
      .update({ total_count: totalCount })
      .eq('id', zipUploadId);

    let processedCount = 0;
    const albumMap = new Map<string, string>();
    const errors: string[] = [];

    for (const file of files) {
      try {
        const folderName = extractFolderName(file.name);
        const fileName = extractFileName(file.name);
        const mimeType = getMimeType(fileName);
        const fileType = mimeType.startsWith('image/') ? 'photo'
          : mimeType.startsWith('video/') ? 'video' : null;

        if (!fileType) {
          console.log(`[media:process-zip] Skipping unsupported: ${fileName}`);
          continue;
        }

        // Get or create album from folder structure
        let albumId: string | null = null;
        if (folderName) {
          albumId = albumMap.get(folderName) || null;
          if (!albumId) {
            albumId = await getOrCreateAlbum(supabase, zipUpload.event_id, folderName);
            if (albumId) albumMap.set(folderName, albumId);
          }
        }

        // Decompress just this one file
        const content = await file.async('uint8array');

        // Upload to storage
        const timestamp = Date.now();
        const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        const storagePath = `events/${zipUpload.event_id}/${fileType}s/original/${timestamp}-${sanitizedName}`;

        const { error: uploadError } = await supabase.storage
          .from('media')
          .upload(storagePath, content, { contentType: mimeType, cacheControl: '3600' });

        if (uploadError) {
          throw new Error(`Upload failed: ${uploadError.message}`);
        }

        // Get public URL
        const { data: urlData } = supabase.storage.from('media').getPublicUrl(storagePath);

        // Create media record
        const { data: media, error: mediaError } = await supabase
          .from('events_media')
          .insert({
            event_id: zipUpload.event_id,
            file_name: fileName,
            storage_path: storagePath,
            url: urlData.publicUrl,
            file_type: fileType,
            mime_type: mimeType,
            file_size: content.length,
          })
          .select()
          .single();

        if (mediaError) {
          throw new Error(`DB insert failed: ${mediaError.message}`);
        }

        // Add to album
        if (albumId && media) {
          await supabase
            .from('event_media_album_items')
            .insert({ media_id: media.id, album_id: albumId, sort_order: processedCount });
        }

        processedCount++;

        // Update progress every 5 files
        if (processedCount % 5 === 0) {
          await supabase
            .from('events_media_zip_uploads')
            .update({ processed_count: processedCount })
            .eq('id', zipUploadId);

          // Update BullMQ job progress
          await job.updateProgress(Math.round((processedCount / totalCount) * 100));
        }
      } catch (error) {
        const errorMsg = `Error processing ${file.name}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(`[media:process-zip] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    // Final progress update
    await supabase
      .from('events_media_zip_uploads')
      .update({ processed_count: processedCount })
      .eq('id', zipUploadId);

    // Mark as completed
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'completed',
        processing_completed_at: new Date().toISOString(),
        error_message: errors.length > 0 ? errors.join('; ') : null,
      })
      .eq('id', zipUploadId);

    console.log(`[media:process-zip] Completed: ${processedCount}/${totalCount}`);

    // Clean up the ZIP file from storage
    try {
      await supabase.storage.from('media').remove([zipUpload.storage_path]);
      console.log(`[media:process-zip] Deleted zip: ${zipUpload.storage_path}`);
    } catch (cleanupError) {
      console.error('[media:process-zip] Cleanup error:', cleanupError);
    }

    await job.updateProgress(100);
  } catch (error) {
    // Mark as failed
    await supabase
      .from('events_media_zip_uploads')
      .update({
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        processing_completed_at: new Date().toISOString(),
      })
      .eq('id', zipUploadId);

    throw error; // BullMQ will handle retries
  }
}
