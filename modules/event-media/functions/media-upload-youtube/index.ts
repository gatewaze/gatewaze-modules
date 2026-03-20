import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { google } from 'npm:googleapis@144.0.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface UploadRequest {
  video: Blob;
  title: string;
  description: string;
  privacy: 'public' | 'unlisted' | 'private';
  tags?: string[];
  category?: string;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get YouTube credentials from environment
    const clientId = Deno.env.get('YOUTUBE_CLIENT_ID');
    const clientSecret = Deno.env.get('YOUTUBE_CLIENT_SECRET');
    const refreshToken = Deno.env.get('YOUTUBE_REFRESH_TOKEN');
    const channelId = Deno.env.get('YOUTUBE_CHANNEL_ID');

    if (!clientId || !clientSecret || !refreshToken || !channelId) {
      throw new Error('YouTube credentials not configured');
    }

    // Parse multipart form data
    const formData = await req.formData();
    const videoFile = formData.get('video') as Blob;
    const title = formData.get('title') as string;
    const description = formData.get('description') as string;
    const privacy = (formData.get('privacy') as string) || 'unlisted';
    const tagsStr = formData.get('tags') as string;
    const category = (formData.get('category') as string) || '28'; // 28 = Science & Technology

    if (!videoFile || !title || !description) {
      throw new Error('Missing required fields: video, title, description');
    }

    // Parse tags
    let tags: string[] = [];
    if (tagsStr) {
      try {
        tags = JSON.parse(tagsStr);
      } catch (e) {
        console.error('Error parsing tags:', e);
      }
    }

    // Initialize OAuth2 client
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'urn:ietf:wg:oauth:2.0:oob' // For server-side apps
    );

    // Set credentials
    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });

    // Initialize YouTube API
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client,
    });

    console.log('Uploading video to YouTube...');
    console.log('Title:', title);
    console.log('Privacy:', privacy);
    console.log('Video size:', videoFile.size, 'bytes');

    // Save video to ephemeral storage first to avoid memory issues
    // This is the recommended approach from Supabase docs for large file uploads
    const tempFilePath = `/tmp/${crypto.randomUUID()}.mp4`;
    console.log('Writing video to temporary file:', tempFilePath);

    // Stream the blob to temp storage to avoid loading entire file into memory
    const fileStream = videoFile.stream();
    const writeFile = await Deno.open(tempFilePath, { write: true, create: true });

    await fileStream.pipeTo(writeFile.writable);

    console.log('Video written to temp file, starting YouTube upload...');

    // Open file for reading and upload to YouTube
    const readFile = await Deno.open(tempFilePath, { read: true });

    try {
      // Upload video to YouTube using the file stream
      const response = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title,
            description,
            tags: tags.length > 0 ? tags : ['event', 'video'],
            categoryId: category,
          },
          status: {
            privacyStatus: privacy,
            selfDeclaredMadeForKids: false,
          },
        },
        media: {
          body: readFile.readable,
        },
      });

      readFile.close();

      // Clean up temp file
      try {
        await Deno.remove(tempFilePath);
      } catch (e) {
        console.warn('Failed to remove temp file:', e);
      }

      const videoId = response.data.id;

      if (!videoId) {
        throw new Error('Failed to get video ID from YouTube response');
      }

      console.log('Video uploaded successfully:', videoId);

      return new Response(
        JSON.stringify({
          success: true,
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          embedUrl: `https://www.youtube.com/embed/${videoId}`,
          thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          channelId,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        }
      );
    } catch (error) {
      readFile.close();
      // Clean up temp file on error
      try {
        await Deno.remove(tempFilePath);
      } catch (e) {
        console.warn('Failed to remove temp file:', e);
      }
      throw error;
    }
  } catch (error) {
    console.error('Error uploading to YouTube:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to upload video to YouTube',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
