import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { google } from 'npm:googleapis@144.0.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface PendingUpload {
  id: string;
  event_id: string;
  storage_path: string;
  file_name: string;
  file_type: string;
  file_size: number;
  youtube_retry_count: number;
}

interface ProcessingResult {
  success: boolean;
  processed: number;
  failed: number;
  skipped: number;
  results: Array<{
    id: string;
    status: 'success' | 'failed' | 'skipped';
    error?: string;
    videoId?: string;
  }>;
}

/**
 * Process pending YouTube uploads
 * This function can be called:
 * 1. Via HTTP request (for manual triggering)
 * 2. Via cron job (for automatic processing)
 * 3. Via webhook after storage upload
 */
Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('Starting YouTube upload processing...');

    // Parse request body to check for specific media ID
    let specificMediaId: string | undefined;
    try {
      const body = await req.json();
      specificMediaId = body.mediaId;
      if (specificMediaId) {
        console.log(`Processing specific media ID: ${specificMediaId}`);
      }
    } catch {
      // No body or invalid JSON, process all pending uploads
    }

    // Get YouTube credentials from environment
    const clientId = Deno.env.get('YOUTUBE_CLIENT_ID');
    const clientSecret = Deno.env.get('YOUTUBE_CLIENT_SECRET');
    const refreshToken = Deno.env.get('YOUTUBE_REFRESH_TOKEN');
    const channelId = Deno.env.get('YOUTUBE_CHANNEL_ID');

    if (!clientId || !clientSecret || !refreshToken || !channelId) {
      throw new Error('YouTube credentials not configured');
    }

    // Initialize Supabase client with service role key (full access)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Query for pending uploads
    let query = supabase
      .from('events_media')
      .select('id, event_id, storage_path, file_name, file_type, file_size, youtube_retry_count')
      .eq('file_type', 'video')
      .eq('youtube_upload_status', 'pending');

    // If specific media ID provided, only process that one
    if (specificMediaId) {
      query = query.eq('id', specificMediaId);
    } else {
      // Otherwise process up to 10 at a time to avoid timeouts
      query = query.order('created_at', { ascending: true }).limit(10);
    }

    const { data: pendingUploads, error: queryError } = await query;

    if (queryError) {
      throw new Error(`Failed to query pending uploads: ${queryError.message}`);
    }

    if (!pendingUploads || pendingUploads.length === 0) {
      console.log('No pending uploads found');
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          failed: 0,
          skipped: 0,
          message: 'No pending uploads',
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );
    }

    console.log(`Found ${pendingUploads.length} pending upload(s)`);

    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'urn:ietf:wg:oauth:2.0:oob'
    );

    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    // Initialize YouTube API
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    const result: ProcessingResult = {
      success: true,
      processed: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };

    // Process each pending upload
    for (const upload of pendingUploads as PendingUpload[]) {
      try {
        console.log(`Processing upload ${upload.id}: ${upload.file_name}`);

        // Update status to 'processing'
        await supabase
          .from('events_media')
          .update({
            youtube_upload_status: 'processing',
            youtube_processing_started_at: new Date().toISOString(),
          })
          .eq('id', upload.id);

        // Get signed URL for direct download (avoids loading into memory)
        console.log(`Getting download URL for: ${upload.storage_path}`);
        const { data: signedUrlData, error: urlError } = await supabase.storage
          .from('media')
          .createSignedUrl(upload.storage_path, 3600); // 1 hour expiry

        if (urlError || !signedUrlData) {
          throw new Error(`Failed to get signed URL: ${urlError?.message}`);
        }

        console.log(`Downloading video from storage (${(upload.file_size / 1024 / 1024).toFixed(2)}MB)...`);

        // Download directly to temp file using streaming to avoid memory issues
        const tempFilePath = `/tmp/${crypto.randomUUID()}.mp4`;

        // Fetch video and stream to file
        const response = await fetch(signedUrlData.signedUrl);
        if (!response.ok) {
          throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
        }

        const file = await Deno.open(tempFilePath, { write: true, create: true });
        await response.body?.pipeTo(file.writable);

        console.log(`Video streamed to temp file: ${tempFilePath}`);

        // Generate video metadata
        const title = upload.file_name.replace(/\.[^/.]+$/, ''); // Remove extension
        const description = `Video from event ${upload.event_id}\n\nUploaded via event management system.`;

        // Open file for reading
        const readFile = await Deno.open(tempFilePath, { read: true });

        try {
          // Upload to YouTube
          console.log(`Uploading to YouTube: ${title}`);
          const response = await youtube.videos.insert({
            part: ['snippet', 'status'],
            requestBody: {
              snippet: {
                title,
                description,
                tags: ['event', 'video', upload.event_id],
                categoryId: '28', // Science & Technology
              },
              status: {
                privacyStatus: 'unlisted',
                selfDeclaredMadeForKids: false,
              },
            },
            media: {
              body: readFile.readable,
            },
          });

          readFile.close();

          const videoId = response.data.id;

          if (!videoId) {
            throw new Error('Failed to get video ID from YouTube response');
          }

          console.log(`Successfully uploaded to YouTube: ${videoId}`);

          // Update database record
          await supabase
            .from('events_media')
            .update({
              upload_method: 'youtube',
              youtube_video_id: videoId,
              youtube_upload_status: 'completed',
              youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
              youtube_embed_url: `https://www.youtube.com/embed/${videoId}`,
              youtube_thumbnail_url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
              youtube_channel_id: channelId,
              youtube_uploaded_at: new Date().toISOString(),
              youtube_processing_completed_at: new Date().toISOString(),
              youtube_error_message: null,
            })
            .eq('id', upload.id);

          result.processed++;
          result.results.push({
            id: upload.id,
            status: 'success',
            videoId,
          });

          // Clean up temp file
          try {
            await Deno.remove(tempFilePath);
          } catch (e) {
            console.warn('Failed to remove temp file:', e);
          }

        } catch (uploadError) {
          readFile.close();

          // Clean up temp file on error
          try {
            await Deno.remove(tempFilePath);
          } catch (e) {
            console.warn('Failed to remove temp file:', e);
          }

          throw uploadError;
        }

      } catch (error) {
        console.error(`Failed to process upload ${upload.id}:`, error);

        // Calculate exponential backoff for retry
        const retryCount = (upload.youtube_retry_count || 0) + 1;
        const backoffMinutes = Math.pow(2, retryCount) * 5; // 5, 10, 20, 40, 80 minutes...
        const nextRetryAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

        // Update database with failure info
        await supabase
          .from('events_media')
          .update({
            youtube_upload_status: 'failed',
            youtube_error_message: error instanceof Error ? error.message : 'Unknown error',
            youtube_retry_count: retryCount,
            youtube_last_retry_at: new Date().toISOString(),
            youtube_next_retry_at: retryCount < 5 ? nextRetryAt.toISOString() : null, // Stop retrying after 5 attempts
          })
          .eq('id', upload.id);

        result.failed++;
        result.results.push({
          id: upload.id,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    console.log(`Processing complete: ${result.processed} succeeded, ${result.failed} failed`);

    return new Response(
      JSON.stringify(result),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );

  } catch (error) {
    console.error('Error in YouTube upload processor:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
