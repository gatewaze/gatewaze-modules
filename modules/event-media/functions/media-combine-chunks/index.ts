import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CombineChunksRequest {
  bucket: string;
  finalPath: string;
  markerPath: string;
}

/**
 * Edge Function to combine uploaded chunks into a single file
 * This is called after all chunks have been uploaded successfully
 */
Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const { bucket, finalPath, markerPath }: CombineChunksRequest = await req.json();

    if (!bucket || !finalPath || !markerPath) {
      throw new Error('Missing required parameters: bucket, finalPath, markerPath');
    }

    console.log(`Combining chunks for ${finalPath}...`);

    // Download the marker file to get chunk information
    const { data: markerData, error: markerError } = await supabase.storage
      .from(bucket)
      .download(markerPath);

    if (markerError || !markerData) {
      throw new Error(`Failed to download marker file: ${markerError?.message || 'Unknown error'}`);
    }

    // Parse marker data
    const markerText = await markerData.text();
    const markerInfo = JSON.parse(markerText);
    const { chunks, totalSize, mimeType, originalName } = markerInfo;

    console.log(`Found ${chunks.length} chunks to combine, total size: ${totalSize} bytes`);

    // Instead of using filesystem, combine chunks in memory
    // For very large files, this might hit memory limits
    const chunkBuffers: Uint8Array[] = [];

    try {
      // Download all chunks into memory
      for (let i = 0; i < chunks.length; i++) {
        const chunkPath = chunks[i];
        console.log(`Downloading chunk ${i + 1}/${chunks.length}: ${chunkPath}`);

        // Download chunk
        const { data: chunkData, error: chunkError } = await supabase.storage
          .from(bucket)
          .download(chunkPath);

        if (chunkError || !chunkData) {
          throw new Error(`Failed to download chunk ${chunkPath}: ${chunkError?.message}`);
        }

        // Add chunk to array
        const chunkBuffer = new Uint8Array(await chunkData.arrayBuffer());
        chunkBuffers.push(chunkBuffer);
      }

      console.log('All chunks downloaded, combining...');

      // Combine all chunks into a single buffer
      const combinedBuffer = new Uint8Array(totalSize);
      let offset = 0;

      for (const chunk of chunkBuffers) {
        combinedBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      console.log(`Combined buffer size: ${combinedBuffer.length} bytes`);

      // Upload the combined file
      const blob = new Blob([combinedBuffer], { type: mimeType });
      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(finalPath, blob, {
          contentType: mimeType,
          upsert: true,
        });

      if (uploadError) {
        throw new Error(`Failed to upload combined file: ${uploadError.message}`);
      }

      console.log('Combined file uploaded successfully');

      // Clean up: Delete chunks and marker file
      const pathsToDelete = [...chunks, markerPath];
      const { error: deleteError } = await supabase.storage
        .from(bucket)
        .remove(pathsToDelete);

      if (deleteError) {
        console.error('Failed to clean up chunks:', deleteError);
        // Don't throw here, as the main operation succeeded
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: 'Chunks combined successfully',
          finalPath,
          totalSize,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );

    } catch (error) {
      // Re-throw error for outer catch block
      throw error;
    }

  } catch (error) {
    console.error('Error combining chunks:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    );
  }
});