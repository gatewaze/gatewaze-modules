import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'crypto';

export function registerRoutes(app: any, context?: ModuleContext) {
  const getSupabase = () => {
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    return createClient(url, key);
  };

  // GET /api/lists — list all active lists
  app.get('/api/lists', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { data: lists, error } = await supabase
        .from('lists')
        .select('*')
        .eq('is_active', true)
        .order('name');

      if (error) throw error;

      // Get subscriber counts
      const { data: counts } = await supabase.rpc('lists_get_subscriber_counts');
      const countMap = new Map((counts || []).map((c: any) => [c.list_id, Number(c.subscriber_count)]));

      const result = (lists || []).map((list: any) => ({
        ...list,
        subscriber_count: countMap.get(list.id) || 0,
      }));

      res.json({ data: result });
    } catch (err: any) {
      console.error('[lists] Error fetching lists:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/lists — create a list
  app.post('/api/lists', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('lists')
        .insert(req.body)
        .select()
        .single();

      if (error) throw error;
      res.status(201).json({ data });
    } catch (err: any) {
      console.error('[lists] Error creating list:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/lists/:id — update a list
  app.patch('/api/lists/:id', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('lists')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();

      if (error) throw error;
      res.json({ data });
    } catch (err: any) {
      console.error('[lists] Error updating list:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/lists/:id — delete a list
  app.delete('/api/lists/:id', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { error } = await supabase
        .from('lists')
        .delete()
        .eq('id', req.params.id);

      if (error) throw error;
      res.status(204).send();
    } catch (err: any) {
      console.error('[lists] Error deleting list:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/lists/:id/subscribe — subscribe email to list
  app.post('/api/lists/:id/subscribe', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { email, source = 'api' } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const listId = req.params.id;

      // Fetch list for webhook config
      const { data: list } = await supabase.from('lists').select('*').eq('id', listId).single();
      if (!list) return res.status(404).json({ error: 'List not found' });

      // Link to person if exists
      const { data: person } = await supabase
        .from('people')
        .select('id')
        .eq('email', email.toLowerCase())
        .maybeSingle();

      // Upsert subscription
      const { data, error } = await supabase
        .from('list_subscriptions')
        .upsert({
          list_id: listId,
          email: email.toLowerCase(),
          person_id: person?.id || null,
          subscribed: true,
          subscribed_at: new Date().toISOString(),
          unsubscribed_at: null,
          source,
        }, { onConflict: 'list_id,email' })
        .select()
        .single();

      if (error) throw error;

      // Fire webhook if configured
      if (list.webhook_url && list.webhook_events?.includes('subscribe')) {
        fireWebhook(supabase, list, 'subscribe', email, source).catch(console.error);
      }

      res.json({ data });
    } catch (err: any) {
      console.error('[lists] Error subscribing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/lists/:id/unsubscribe — unsubscribe email from list
  app.post('/api/lists/:id/unsubscribe', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { email, source = 'api' } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const listId = req.params.id;

      const { data: list } = await supabase.from('lists').select('*').eq('id', listId).single();
      if (!list) return res.status(404).json({ error: 'List not found' });

      const { data, error } = await supabase
        .from('list_subscriptions')
        .update({
          subscribed: false,
          unsubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('list_id', listId)
        .eq('email', email.toLowerCase())
        .select()
        .single();

      if (error) throw error;

      if (list.webhook_url && list.webhook_events?.includes('unsubscribe')) {
        fireWebhook(supabase, list, 'unsubscribe', email, source).catch(console.error);
      }

      res.json({ data });
    } catch (err: any) {
      console.error('[lists] Error unsubscribing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/lists/unsubscribe-all — unsubscribe from all lists
  app.post('/api/lists/unsubscribe-all', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { email, source = 'api' } = req.body;
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const { data, error } = await supabase
        .from('list_subscriptions')
        .update({
          subscribed: false,
          unsubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('email', email.toLowerCase())
        .eq('subscribed', true)
        .select('list_id');

      if (error) throw error;

      // Fire webhooks for each list
      const listIds = (data || []).map((s: any) => s.list_id);
      if (listIds.length > 0) {
        const { data: lists } = await supabase
          .from('lists')
          .select('*')
          .in('id', listIds);

        for (const list of lists || []) {
          if (list.webhook_url && list.webhook_events?.includes('unsubscribe')) {
            fireWebhook(supabase, list, 'unsubscribe_all', email, source).catch(console.error);
          }
        }
      }

      res.json({ unsubscribed_count: listIds.length });
    } catch (err: any) {
      console.error('[lists] Error unsubscribing all:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/lists/subscriptions/:email — get all subscriptions for email
  app.get('/api/lists/subscriptions/:email', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('list_subscriptions')
        .select('*, list:lists(id, name, slug, description, is_public)')
        .eq('email', req.params.email.toLowerCase());

      if (error) throw error;
      res.json({ data: data || [] });
    } catch (err: any) {
      console.error('[lists] Error fetching subscriptions:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/lists/:id/import — bulk import subscribers
  app.post('/api/lists/:id/import', async (req: any, res: any) => {
    try {
      const supabase = getSupabase();
      const { emails } = req.body;
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'emails array is required' });
      }

      const listId = req.params.id;
      const rows = emails
        .filter((e: string) => e && e.includes('@'))
        .map((email: string) => ({
          list_id: listId,
          email: email.toLowerCase().trim(),
          subscribed: true,
          subscribed_at: new Date().toISOString(),
          source: 'import',
        }));

      const { error } = await supabase
        .from('list_subscriptions')
        .upsert(rows, { onConflict: 'list_id,email' });

      if (error) throw error;
      res.json({ imported_count: rows.length });
    } catch (err: any) {
      console.error('[lists] Error importing:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // External subscribe/unsubscribe endpoints are implemented as Supabase Edge Functions:
  //   - list-subscribe: POST /functions/v1/list-subscribe { slug, email }
  //   - list-unsubscribe: POST /functions/v1/list-unsubscribe { slug, email } or { email, all: true }
  // Auth: X-Api-Key header or X-Webhook-Signature (HMAC-SHA256)
}

async function fireWebhook(
  supabase: any,
  list: any,
  eventType: string,
  email: string,
  source: string
) {
  const payload = JSON.stringify({
    event: eventType,
    email,
    list_id: list.id,
    list_slug: list.slug,
    list_name: list.name,
    timestamp: new Date().toISOString(),
    source,
  });

  const signature = list.webhook_secret
    ? createHmac('sha256', list.webhook_secret).update(payload).digest('hex')
    : '';

  let status = 'sent';
  let responseCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(list.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    responseCode = response.status;
    responseBody = await response.text().catch(() => null);

    if (!response.ok) {
      status = 'failed';
      errorMessage = `HTTP ${response.status}`;
    }
  } catch (err: any) {
    status = 'failed';
    errorMessage = err.message;
  }

  // Log webhook call
  await supabase.from('list_webhook_logs').insert({
    list_id: list.id,
    event_type: eventType,
    email,
    status,
    response_code: responseCode,
    response_body: responseBody,
    error_message: errorMessage,
  });
}
