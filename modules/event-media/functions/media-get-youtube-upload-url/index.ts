import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Direct OAuth2 refresh-token exchange against Google's token endpoint.
// Avoids pulling in `npm:googleapis` (~140MB), which intermittently crashes
// Supabase's edge bundler with HTTP 500 "internal error".
async function refreshGoogleAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    throw new Error(`OAuth refresh failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in OAuth response');
  return data.access_token;
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

    // Parse request body
    const { title, description, privacy, tags, category } = await req.json();

    if (!title || !description) {
      throw new Error('Missing required fields: title, description');
    }

    const accessToken = await refreshGoogleAccessToken(clientId, clientSecret, refreshToken);

    console.log('Generating YouTube upload URL...');
    console.log('Title:', title);
    console.log('Privacy:', privacy);

    // Create resumable upload session
    // This returns an upload URL that the browser can use to upload the video directly
    const metadata = {
      snippet: {
        title,
        description,
        tags: tags && tags.length > 0 ? tags : ['event', 'video'],
        categoryId: category || '28',
      },
      status: {
        privacyStatus: privacy || 'unlisted',
        selfDeclaredMadeForKids: false,
      },
    };

    // Call YouTube API to create resumable upload session
    const response = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/*',
        },
        body: JSON.stringify(metadata),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('YouTube API error:', errorText);
      throw new Error(`YouTube API error: ${response.status} ${errorText}`);
    }

    // Get the upload URL from the Location header
    const uploadUrl = response.headers.get('Location');

    if (!uploadUrl) {
      throw new Error('Failed to get upload URL from YouTube');
    }

    console.log('YouTube upload URL generated successfully');

    return new Response(
      JSON.stringify({
        success: true,
        uploadUrl,
        accessToken,
        channelId,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('Error generating YouTube upload URL:', error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || 'Failed to generate YouTube upload URL',
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
