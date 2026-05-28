import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Slack List Channels Edge Function
 *
 * Lists available Slack channels AND users for an event's connected workspace.
 * Used by the admin UI for channel/DM selection.
 */

const SLACK_DEFAULT_BOT_TOKEN = Deno.env.get('SLACK_DEFAULT_BOT_TOKEN');

interface ListChannelsPayload {
  eventId: string;
  useCustomWorkspace?: boolean;
  includePrivate?: boolean;
  includeUsers?: boolean;
  searchQuery?: string; // Search query for filtering channels/users
  searchType?: 'channel' | 'user' | 'all'; // What to search for
}

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members?: number;
  type: 'public_channel' | 'private_channel';
}

interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  email?: string;
  is_bot: boolean;
  profile_image?: string;
}

serve(async (req) => {
  try {
    // CORS headers
    if (req.method === 'OPTIONS') {
      return new Response('ok', {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        },
      });
    }

    const payload: ListChannelsPayload = await req.json();
    const {
      eventId,
      useCustomWorkspace = false,
      includePrivate = true,
      includeUsers = true,
      searchQuery = '',
      searchType = 'all'
    } = payload;

    if (!eventId) {
      return jsonResponse({ error: 'Missing eventId' }, 400);
    }

    // Create Supabase client
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Determine which token to use
    let accessToken: string | null = null;

    if (useCustomWorkspace) {
      const { data: integration } = await supabaseClient
        .from('events_slack_integrations')
        .select('access_token')
        .eq('event_id', eventId)
        .maybeSingle();

      accessToken = integration?.access_token || null;
    } else {
      accessToken = SLACK_DEFAULT_BOT_TOKEN || null;
    }

    if (!accessToken) {
      return jsonResponse({ error: 'No Slack token available' }, 400);
    }

    const channels: SlackChannel[] = [];
    const users: SlackUser[] = [];
    const normalizedQuery = searchQuery.toLowerCase().trim();

    // If searching for channels (# prefix or all)
    if (searchType === 'channel' || searchType === 'all') {
      // Get public channels
      const publicResponse = await fetch(
        'https://slack.com/api/conversations.list?' + new URLSearchParams({
          types: 'public_channel',
          exclude_archived: 'true',
          limit: '100',
        }),
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        }
      );

      const publicData = await publicResponse.json();
      if (publicData.ok && publicData.channels) {
        for (const ch of publicData.channels) {
          // Filter by search query if provided
          if (normalizedQuery && !ch.name.toLowerCase().includes(normalizedQuery)) {
            continue;
          }
          channels.push({
            id: ch.id,
            name: ch.name,
            is_private: false,
            is_member: ch.is_member || false,
            num_members: ch.num_members,
            type: 'public_channel',
          });
        }
      }

      // Get private channels (only ones bot is a member of)
      if (includePrivate) {
        const privateResponse = await fetch(
          'https://slack.com/api/conversations.list?' + new URLSearchParams({
            types: 'private_channel',
            exclude_archived: 'true',
            limit: '100',
          }),
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
            },
          }
        );

        const privateData = await privateResponse.json();
        if (privateData.ok && privateData.channels) {
          for (const ch of privateData.channels) {
            // Filter by search query if provided
            if (normalizedQuery && !ch.name.toLowerCase().includes(normalizedQuery)) {
              continue;
            }
            channels.push({
              id: ch.id,
              name: ch.name,
              is_private: true,
              is_member: true,
              num_members: ch.num_members,
              type: 'private_channel',
            });
          }
        }
      }
    }

    // If searching for users (@ prefix or all)
    if ((searchType === 'user' || searchType === 'all') && includeUsers) {
      // Only fetch users if there's a search query (to avoid loading 30k users)
      if (normalizedQuery.length >= 2) {
        // Use Slack's users.list with pagination but filter server-side
        let cursor: string | undefined;
        let pagesChecked = 0;
        const maxPages = 10; // Limit pages to prevent timeout

        do {
          const params: Record<string, string> = { limit: '200' };
          if (cursor) {
            params.cursor = cursor;
          }

          const usersResponse = await fetch(
            'https://slack.com/api/users.list?' + new URLSearchParams(params),
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            }
          );

          const usersData = await usersResponse.json();
          if (!usersData.ok) {
            console.error('Slack users.list error:', usersData.error);
            break;
          }

          for (const member of usersData.members || []) {
            // Skip bots, deleted users, and restricted users
            if (member.deleted || member.is_bot || member.is_restricted || member.is_ultra_restricted) {
              continue;
            }
            if (member.id === 'USLACKBOT') {
              continue;
            }

            // Filter by search query - check name, real_name, and email
            const matchesName = member.name?.toLowerCase().includes(normalizedQuery);
            const matchesRealName = member.real_name?.toLowerCase().includes(normalizedQuery);
            const matchesEmail = member.profile?.email?.toLowerCase().includes(normalizedQuery);

            if (matchesName || matchesRealName || matchesEmail) {
              users.push({
                id: member.id,
                name: member.name,
                real_name: member.real_name || member.name,
                email: member.profile?.email,
                is_bot: false,
                profile_image: member.profile?.image_48,
              });
            }
          }

          cursor = usersData.response_metadata?.next_cursor;
          pagesChecked++;

          // Stop if we have enough results
          if (users.length >= 50) {
            break;
          }
        } while (cursor && pagesChecked < maxPages);
      }
    }

    // Sort channels alphabetically
    channels.sort((a, b) => a.name.localeCompare(b.name));

    // Sort users by real name
    users.sort((a, b) => a.real_name.localeCompare(b.real_name));

    return jsonResponse({
      channels,
      users,
      total_channels: channels.length,
      total_users: users.length,
    }, 200);
  } catch (error) {
    console.error('Unexpected error:', error);
    return jsonResponse({ error: 'Internal server error', details: error.message }, 500);
  }
});

function jsonResponse(data: object, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
