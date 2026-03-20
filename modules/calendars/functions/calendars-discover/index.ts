import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DiscoveryRequest {
  mode?: 'analyze' | 'discover' | 'process_query' | 'create_scraper';
  query?: string;
  max_queries?: number;
  brand?: 'techtickets' | 'mlops';
  calendar_id?: string; // For create_scraper mode
}

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface LumaCalendarInfo {
  calendarApiId: string;
  calendarName: string;
  calendarUrl: string;
  icalUrl: string;
}

/**
 * Extract calendar info from a Luma event page's __NEXT_DATA__ JSON
 * Luma event pages contain calendar info in props.pageProps.initialData.data.event.calendar
 */
async function extractCalendarFromEventPage(eventUrl: string): Promise<LumaCalendarInfo | null> {
  try {
    console.log(`🔍 Fetching event page: ${eventUrl}`);

    const response = await fetch(eventUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EventDiscoveryBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${eventUrl}: ${response.status}`);
      return null;
    }

    const html = await response.text();

    // Extract __NEXT_DATA__ JSON from the page
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!nextDataMatch) {
      console.log(`No __NEXT_DATA__ found on page`);
      return null;
    }

    const nextData = JSON.parse(nextDataMatch[1]);
    const eventData = nextData?.props?.pageProps?.initialData?.data?.event;

    if (!eventData) {
      console.log(`No event data found in __NEXT_DATA__`);
      return null;
    }

    // Extract calendar info - can be in 'calendar' or 'calendar_api_id'
    const calendar = eventData.calendar;
    const calendarApiId = calendar?.api_id || eventData.calendar_api_id;

    if (!calendarApiId) {
      console.log(`No calendar API ID found in event data`);
      return null;
    }

    // Extract calendar name and URL
    const calendarName = calendar?.name || eventData.calendar_name || 'Unknown Calendar';
    const calendarSlug = calendar?.url_key || calendar?.slug;

    // Construct calendar URL
    let calendarUrl = '';
    if (calendarSlug) {
      calendarUrl = `https://lu.ma/${calendarSlug}`;
    } else if (calendarApiId.startsWith('cal-')) {
      // If we only have the API ID, we can't construct the public URL easily
      // But we can use it for the iCal feed
      calendarUrl = `https://lu.ma/calendar/${calendarApiId}`;
    }

    // Construct iCal feed URL
    const icalUrl = `https://api2.luma.com/ics/get?entity=calendar&id=${calendarApiId}`;

    console.log(`✅ Found calendar: ${calendarName} (${calendarApiId})`);

    return {
      calendarApiId,
      calendarName,
      calendarUrl,
      icalUrl,
    };
  } catch (error) {
    console.error(`Error extracting calendar from ${eventUrl}:`, error);
    return null;
  }
}

/**
 * Edge function to discover Luma calendars based on user search queries.
 *
 * Modes:
 * - analyze: Aggregate recent search queries and identify discovery candidates
 * - discover: Run Google searches for candidate queries and store discovered calendars
 * - process_query: Process a specific query for calendar discovery
 */
export default async function(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const googleApiKey = Deno.env.get("GOOGLE_SEARCH_API_KEY") || "";
    const googleSearchEngineId = Deno.env.get("GOOGLE_SEARCH_ENGINE_ID") || "";

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const body: DiscoveryRequest = await req.json().catch(() => ({}));
    const mode = body.mode || 'analyze';
    const maxQueries = body.max_queries || 10;
    const brand = body.brand || 'techtickets'; // Default to techtickets for discovery

    // MLOps brand should not use auto-discovery
    if (brand === 'mlops' && (mode === 'discover' || mode === 'create_scraper')) {
      return new Response(
        JSON.stringify({
          error: 'Calendar discovery is only available for Techtickets brand. MLOps calendars are manually managed.',
          hint: 'MLOps Community has curated calendars that are manually configured.'
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mode 1: Aggregate search queries for analysis
    if (mode === 'analyze') {
      const { error } = await supabase.rpc('aggregate_search_queries');

      if (error) {
        console.error('Error aggregating queries:', error);
        return new Response(
          JSON.stringify({ error: 'Failed to aggregate search queries' }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get discovery candidates
      const { data: candidates, error: candidatesError } = await supabase.rpc(
        'get_discovery_candidate_queries',
        { max_results: maxQueries }
      );

      if (candidatesError) {
        console.error('Error getting candidates:', candidatesError);
        return new Response(
          JSON.stringify({ error: 'Failed to get discovery candidates' }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'analyze',
          candidates: candidates || [],
          message: `Found ${candidates?.length || 0} discovery candidate queries`
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mode 2: Discover calendars from candidate queries
    if (mode === 'discover') {
      if (!googleApiKey || !googleSearchEngineId) {
        return new Response(
          JSON.stringify({
            error: 'Google Search API not configured. Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID.',
            hint: 'You can still manually add calendars or use mode=process_query with mock results for testing.'
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get discovery candidates
      const { data: candidates, error: candidatesError } = await supabase.rpc(
        'get_discovery_candidate_queries',
        { max_results: maxQueries }
      );

      if (candidatesError || !candidates || candidates.length === 0) {
        return new Response(
          JSON.stringify({
            success: true,
            mode: 'discover',
            message: 'No candidate queries to process'
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const discoveredCalendars: any[] = [];

      for (const candidate of candidates) {
        const query = candidate.query_text;

        // Search Google for Luma calendars matching this query
        // Pattern: site:lu.ma "keyword" OR site:luma.com "keyword"
        const searchQuery = `site:lu.ma "${query}" OR site:luma.com "${query}"`;

        try {
          const searchUrl = `https://www.googleapis.com/customsearch/v1?` +
            `key=${googleApiKey}&cx=${googleSearchEngineId}&q=${encodeURIComponent(searchQuery)}&num=10`;

          const searchResponse = await fetch(searchUrl);
          const searchData = await searchResponse.json();

          if (searchData.items && searchData.items.length > 0) {
            // Track unique calendars to avoid duplicates within this search
            const seenCalendars = new Set<string>();

            for (let i = 0; i < Math.min(searchData.items.length, 5); i++) {
              const item = searchData.items[i];
              const eventUrl = item.link;

              // Check if this is a Luma event URL
              const lumaMatch = eventUrl.match(/https?:\/\/(lu\.ma|luma\.com)\/([a-zA-Z0-9_-]+)/);
              if (!lumaMatch) continue;

              // Extract calendar info from the event page
              const calendarInfo = await extractCalendarFromEventPage(eventUrl);

              if (calendarInfo && !seenCalendars.has(calendarInfo.calendarApiId)) {
                seenCalendars.add(calendarInfo.calendarApiId);

                // Try to insert the discovered calendar
                const { error: insertError } = await supabase
                  .from('search_discovered_calendars')
                  .insert({
                    search_query: query,
                    luma_calendar_url: calendarInfo.calendarUrl,
                    luma_calendar_name: calendarInfo.calendarName,
                    luma_calendar_api_id: calendarInfo.calendarApiId,
                    luma_ical_url: calendarInfo.icalUrl,
                    discovery_source: 'google_search',
                    relevance_score: candidate.priority_score,
                    search_result_position: i + 1,
                    source_event_url: eventUrl,
                    brand_id: brand, // Track which brand discovered this
                    status: 'pending'
                  })
                  .select()
                  .single();

                if (!insertError) {
                  discoveredCalendars.push({
                    url: calendarInfo.calendarUrl,
                    name: calendarInfo.calendarName,
                    icalUrl: calendarInfo.icalUrl,
                    query: query,
                    position: i + 1,
                    sourceEventUrl: eventUrl
                  });
                }
              }

              // Rate limiting between event page fetches
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }

          // Update the query analysis to mark as processed
          await supabase
            .from('search_query_analysis')
            .update({
              discovery_attempts: supabase.sql`discovery_attempts + 1`,
              last_discovery_attempt: new Date().toISOString(),
              calendars_discovered: discoveredCalendars.filter(c => c.query === query).length,
              updated_at: new Date().toISOString()
            })
            .eq('query_text', query);

        } catch (searchError) {
          console.error(`Error searching for "${query}":`, searchError);
        }

        // Rate limiting - wait between searches
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'discover',
          queries_processed: candidates.length,
          calendars_discovered: discoveredCalendars.length,
          calendars: discoveredCalendars
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mode 3: Process a specific query
    if (mode === 'process_query' && body.query) {
      const query = body.query;

      if (!googleApiKey || !googleSearchEngineId) {
        // Return mock structure for testing without Google API
        return new Response(
          JSON.stringify({
            success: true,
            mode: 'process_query',
            query: query,
            search_pattern: `site:lu.ma "${query}" OR site:luma.com "${query}"`,
            message: 'Google Search API not configured. This is the search pattern that would be used.',
            hint: 'Set GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID to enable automatic discovery.'
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const searchQuery = `site:lu.ma "${query}" OR site:luma.com "${query}"`;
      const searchUrl = `https://www.googleapis.com/customsearch/v1?` +
        `key=${googleApiKey}&cx=${googleSearchEngineId}&q=${encodeURIComponent(searchQuery)}&num=10`;

      const searchResponse = await fetch(searchUrl);
      const searchData = await searchResponse.json();

      const results: GoogleSearchResult[] = searchData.items?.map((item: any) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet
      })) || [];

      return new Response(
        JSON.stringify({
          success: true,
          mode: 'process_query',
          query: query,
          search_pattern: searchQuery,
          results_count: results.length,
          results: results
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Mode 4: Create scraper from discovered calendar
    if (mode === 'create_scraper' && body.calendar_id) {
      const { data: result, error } = await supabase.rpc('scrapers_create_from_discovered_calendar', {
        p_discovered_calendar_id: body.calendar_id
      });

      if (error) {
        return new Response(
          JSON.stringify({ error: `Failed to create scraper: ${error.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: result.success,
          mode: 'create_scraper',
          scraper_id: result.scraper_id,
          calendar_name: result.calendar_name,
          error: result.error
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Invalid mode. Use: analyze, discover, process_query, or create_scraper' }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error('Error in discover-calendars:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
