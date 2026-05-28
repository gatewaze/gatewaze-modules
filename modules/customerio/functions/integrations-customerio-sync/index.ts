import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CUSTOMERIO_API_KEY = Deno.env.get('CUSTOMERIO_APP_API_KEY')!;
const CUSTOMERIO_BASE_URL = 'https://api.customer.io/v1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const RATE_LIMIT_DELAY = 100;
const BATCH_SIZE = 50; // Number of customers to sync per run

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Parse request body once and store it
  const { syncType = 'customers', mode = 'incremental' } = await req.json().catch(() => ({}));

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

    console.log(`Starting ${mode} Customer.io ${syncType} sync...`);

    // Get the last sync cursor
    const { data: syncStatus } = await supabaseClient
      .from('integrations_customerio_sync_status')
      .select('sync_cursor')
      .eq('sync_type', syncType)
      .single();

    const nextCursor = mode === 'full' ? null : (syncStatus?.sync_cursor || null);
    console.log(`Starting from cursor: ${nextCursor || 'beginning'}`);

    // Update sync status to running
    await supabaseClient
      .from('integrations_customerio_sync_status')
      .update({
        last_sync_started_at: new Date().toISOString(),
        last_sync_status: 'running',
        sync_mode: mode,
        sync_cursor: mode === 'full' ? null : syncStatus?.sync_cursor
      })
      .eq('sync_type', syncType);

    // Fetch a batch of customers from Customer.io
    const searchPayload: any = {
      limit: BATCH_SIZE
    };

    if (nextCursor) {
      searchPayload.start = nextCursor;
    }

    const searchResponse = await fetch(`${CUSTOMERIO_BASE_URL}/customers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CUSTOMERIO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(searchPayload)
    });

    if (!searchResponse.ok) {
      throw new Error(`Failed to fetch customers: ${searchResponse.statusText}`);
    }

    const searchData = await searchResponse.json();
    const customers = searchData.identifiers || [];
    const newCursor = searchData.next || null;

    console.log(`Fetched ${customers.length} customers`);

    // Sync each customer
    let syncedCount = 0;
    let skippedCount = 0;

    for (const customer of customers) {
      try {
        // Check if customer already exists
        const { data: existingCustomer } = await supabaseClient
          .from('people')
          .select('cio_id')
          .eq('cio_id', customer.cio_id)
          .single();

        if (existingCustomer) {
          skippedCount++;
          continue;
        }

        // Fetch full customer details
        const detailsResponse = await fetch(
          `${CUSTOMERIO_BASE_URL}/customers/${customer.cio_id}/attributes`,
          {
            headers: {
              'Authorization': `Bearer ${CUSTOMERIO_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (detailsResponse.ok) {
          const details = await detailsResponse.json();

          await supabaseClient
            .from('people')
            .upsert({
              cio_id: customer.cio_id,
              email: details.customer.email,
              attributes: details.customer.attributes || {},
              last_synced_at: new Date().toISOString()
            }, {
              onConflict: 'cio_id'
            });

          syncedCount++;
          console.log(`Synced customer ${customer.cio_id} (${syncedCount}/${BATCH_SIZE})`);
        }

        await delay(RATE_LIMIT_DELAY);
      } catch (error) {
        console.error(`Error processing customer ${customer.cio_id}:`, error);
      }
    }

    // Update sync status with new cursor
    const isComplete = !newCursor;
    await supabaseClient
      .from('integrations_customerio_sync_status')
      .update({
        last_sync_completed_at: new Date().toISOString(),
        last_sync_status: isComplete ? 'completed' : 'running',
        records_synced: syncedCount,
        sync_cursor: newCursor,
        sync_mode: 'incremental'
      })
      .eq('sync_type', 'customers');

    console.log(`Sync batch complete: ${syncedCount} synced, ${skippedCount} skipped`);

    return new Response(
      JSON.stringify({
        success: true,
        mode,
        syncType,
        customersSynced: syncedCount,
        customersSkipped: skippedCount,
        hasMore: !isComplete,
        cursor: newCursor,
        message: isComplete
          ? `Sync complete - no more ${syncType} to process`
          : `Synced ${syncedCount} ${syncType}, ${skippedCount} already existed. Run again to continue.`
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      }
    );
  } catch (error) {
    console.error('Error in sync function:', error);

    // Update sync status to failed
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

      await supabaseClient
        .from('integrations_customerio_sync_status')
        .update({
          last_sync_status: 'failed',
          last_sync_error: error instanceof Error ? error.message : 'Unknown error'
        })
        .eq('sync_type', syncType);
    } catch (updateError) {
      console.error('Failed to update sync status:', updateError);
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
    );
  }
});
