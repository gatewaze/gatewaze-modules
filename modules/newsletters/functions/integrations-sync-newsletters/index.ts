import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GOOGLE_SHEET_ID = '1IHKCXK6NMS0k9Xfgvk2nJSK3GMMUvIO--k_hqPORiwI';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Simple CSV parser that handles quoted fields
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next character
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Add the last field
  result.push(current.trim());

  return result;
}

interface Newsletter {
  title: string;
  description: string;
  url: string;
  image_url: string;
  date: string;
  published: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );

    console.log('Fetching newsletter data from Google Sheets...');

    // Fetch CSV from Google Sheets
    const response = await fetch(CSV_URL);
    if (!response.ok) {
      throw new Error(`Failed to fetch Google Sheet: ${response.statusText}`);
    }

    const csvText = await response.text();
    const lines = csvText.split('\n');

    // Skip header row and filter out empty lines
    const dataLines = lines.slice(1).filter(line => line.trim());

    const newsletters: Newsletter[] = [];

    for (const line of dataLines) {
      // Parse CSV line (handling quoted fields)
      const fields = parseCSVLine(line);

      // Expected columns: published, productionPlaybook, date, title, description, url, image
      // We skip productionPlaybook as per requirements
      if (fields.length < 7 || !fields[1] || !fields[2] || !fields[4]) {
        continue;
      }

      const [published, _productionPlaybook, date, title, description, url, image] = fields;

      // Only include newsletters where published column is set to true
      if (!published || published.toLowerCase().trim() !== 'true') {
        continue;
      }

      // Also ensure we have essential data
      if (!date || !title || !url) {
        continue;
      }

      newsletters.push({
        title: title || '',
        description: description || '',
        url: url || '',
        image_url: image || '',
        date: date || '',
        published: true,
      });
    }

    console.log(`Parsed ${newsletters.length} newsletters from Google Sheets`);

    if (newsletters.length === 0) {
      return new Response(
        JSON.stringify({ success: true, count: 0, message: 'No newsletters found in the sheet' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Delete all existing newsletters and insert fresh data
    // This is a simple replace strategy to handle deduplication
    const { error: deleteError } = await supabaseClient
      .from('newsletters')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all rows

    if (deleteError) {
      console.error('Error deleting existing newsletters:', deleteError);
      throw new Error(`Failed to clear existing newsletters: ${deleteError.message}`);
    }

    // Insert all newsletters
    const { error: insertError } = await supabaseClient
      .from('newsletters')
      .insert(newsletters.map(n => ({
        title: n.title,
        description: n.description || null,
        url: n.url,
        image_url: n.image_url || null,
        date: n.date,
        published: n.published,
      })));

    if (insertError) {
      console.error('Error inserting newsletters:', insertError);
      throw new Error(`Failed to insert newsletters: ${insertError.message}`);
    }

    console.log(`Successfully synced ${newsletters.length} newsletters`);

    return new Response(
      JSON.stringify({
        success: true,
        count: newsletters.length,
        message: `Successfully synced ${newsletters.length} newsletters`,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error syncing newsletters:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to sync newsletters' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
