import { Router, type Request, type Response, type NextFunction } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import * as dns from 'dns/promises';
import { requireJwt } from './lib/require-jwt';
import { cleanTheme } from './lib/theme';

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  );
}

function getConfig() {
  return {
    cnameTarget: process.env.CUSTOM_DOMAINS_CNAME_TARGET || '',
    expectedIp: process.env.CUSTOM_DOMAINS_EXPECTED_IP || '',
    clusterIssuer: process.env.CUSTOM_DOMAINS_CLUSTER_ISSUER || 'letsencrypt-prod',
  };
}

function isApexDomain(domain: string): boolean {
  const parts = domain.split('.');
  if (parts.length === 2) return true;
  // Handle two-part TLDs like co.uk, com.au
  const knownSecondLevel = ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'];
  if (parts.length === 3 && knownSecondLevel.includes(parts[parts.length - 2])) return true;
  return false;
}

async function verifyDns(domain: string, cnameTarget: string, expectedIp: string): Promise<boolean> {
  // Try CNAME first (won't work for apex domains — that's expected)
  try {
    const cnames = await dns.resolveCname(domain);
    if (cnames.some(c => c.toLowerCase().includes(cnameTarget.toLowerCase()))) return true;
  } catch { /* CNAME lookup failed — try A record */ }

  // Fall back to A record (works for both apex and subdomains)
  try {
    const addresses = await dns.resolve4(domain);
    if (addresses.includes(expectedIp)) return true;
  } catch { /* A record lookup failed */ }

  return false;
}

/**
 * Who may register, point and style a domain: an active admin or super
 * admin, read through the service client after this module's own
 * requireJwt has verified the token. The platform does not gate
 * /api/modules/* (see require-jwt.ts), so without this anyone who could
 * reach the api could re-point an active domain (security review
 * 2026-10-29). Editors are not admins here.
 */
async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) { res.status(401).json({ error: 'unauthenticated' }); return; }
  try {
    const { data, error } = await getSupabase()
      .from('admin_profiles')
      .select('role, is_active')
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data || data.is_active !== true || !['super_admin', 'admin'].includes(data.role)) {
      res.status(403).json({ error: 'forbidden', message: 'custom domains are managed by admins' });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: 'forbidden', message: 'custom domains are managed by admins' });
  }
}

export function registerRoutes(app: any, _context?: ModuleContext) {
  const router = Router();

  // The lookups (domain for a piece of content) are read-only and say
  // nothing DNS does not; other modules' admin panels call them without
  // a token. Everything else is for admins.
  // Exact shapes, method included, so no other route can wear the lookup's path.
  const isOpen = (req: Request): boolean =>
    (req.method === 'GET' && /^\/lookup\/[^/]+\/[^/]+\/?$/.test(req.path)) ||
    (req.method === 'POST' && /^\/lookup-batch\/?$/.test(req.path));
  const jwt = requireJwt();
  router.use((req: Request, res: Response, next: NextFunction) => (isOpen(req) ? next() : jwt(req, res, next)));
  router.use((req: Request, res: Response, next: NextFunction) => (isOpen(req) ? next() : requireAdmin(req, res, next)));

  // GET / — List all custom domains
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('custom_domains')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list domains' });
    }
  });

  // POST / — Register a new domain
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { domain } = req.body;

      if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ error: 'Domain is required' });
      }

      const normalizedDomain = domain.trim().toLowerCase();

      if (!DOMAIN_REGEX.test(normalizedDomain)) {
        return res.status(400).json({
          error: 'Invalid domain format. Enter a bare hostname like myconference.com (no https://)',
        });
      }

      const config = getConfig();
      const supabase = getSupabase();

      // Check if domain already exists
      const { data: existing } = await supabase
        .from('custom_domains')
        .select('id')
        .eq('domain', normalizedDomain)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({ error: `Domain ${normalizedDomain} is already registered` });
      }

      const apex = isApexDomain(normalizedDomain);

      const { data, error } = await supabase
        .from('custom_domains')
        .insert({
          domain: normalizedDomain,
          status: 'pending',
          cname_target: config.cnameTarget,
          expected_ip: config.expectedIp,
        })
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });

      return res.status(201).json({
        ...data,
        is_apex: apex,
        dns_instructions: {
          ...(apex ? {} : {
            cname: {
              type: 'CNAME',
              name: normalizedDomain,
              target: config.cnameTarget,
            },
          }),
          a_record: {
            type: 'A',
            name: normalizedDomain,
            target: config.expectedIp,
          },
          note: apex
            ? `This is a root/apex domain. Add an A record pointing to ${config.expectedIp}. If your DNS provider supports ALIAS/ANAME records, you can point to ${config.cnameTarget} instead.`
            : `Add a CNAME record pointing to ${config.cnameTarget}. Alternatively, add an A record pointing to ${config.expectedIp}.`,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to register domain' });
    }
  });

  // GET /:domainId — Get domain detail
  router.get('/:domainId', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('custom_domains')
        .select('*')
        .eq('id', req.params.domainId)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Domain not found' });

      return res.json({
        ...data,
        is_apex: isApexDomain(data.domain),
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to get domain' });
    }
  });

  // PUT /:domainId — Update domain settings (branding and the look)
  router.put('/:domainId', async (req: Request, res: Response) => {
    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const update: Record<string, unknown> = {};
      if ('page_title' in body) {
        const v = body.page_title;
        if (v !== null && (typeof v !== 'string' || v.length > 120)) return res.status(400).json({ error: 'page_title must be text up to 120 characters, or null' });
        update.page_title = v === '' ? null : v;
      }
      if ('favicon_url' in body) {
        const v = body.favicon_url;
        let ok = v === null || v === '';
        if (!ok && typeof v === 'string' && v.length <= 500) { try { ok = new URL(v).protocol === 'https:'; } catch { ok = false; } }
        if (!ok) return res.status(400).json({ error: 'favicon_url must be an https URL, or null' });
        update.favicon_url = v === '' ? null : v;
      }
      if ('theme' in body) {
        const { theme, refused } = cleanTheme(body.theme);
        if (refused.length) return res.status(400).json({ error: `theme: not acceptable: ${refused.join(', ')}`, refused });
        update.theme = theme;
      }
      if (Object.keys(update).length === 0) return res.status(400).json({ error: 'nothing to change' });
      const supabase = getSupabase();

      const { data, error } = await supabase
        .from('custom_domains')
        .update(update)
        .eq('id', req.params.domainId)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to update domain' });
    }
  });

  // DELETE /:domainId — Remove domain
  router.delete('/:domainId', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();

      // Set status to 'removing' — controller will clean up Ingress
      const { error } = await supabase
        .from('custom_domains')
        .update({ status: 'removing' })
        .eq('id', req.params.domainId);

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ success: true, message: 'Domain removal initiated' });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to remove domain' });
    }
  });

  // POST /:domainId/verify — Trigger immediate DNS re-check
  router.post('/:domainId/verify', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      const { data: domain } = await supabase
        .from('custom_domains')
        .select('*')
        .eq('id', req.params.domainId)
        .maybeSingle();

      if (!domain) return res.status(404).json({ error: 'Domain not found' });

      if (domain.status !== 'pending' && domain.status !== 'error') {
        return res.json({ verified: domain.status !== 'pending', status: domain.status });
      }

      const config = getConfig();
      const verified = await verifyDns(
        domain.domain,
        domain.cname_target || config.cnameTarget,
        domain.expected_ip || config.expectedIp,
      );

      if (verified) {
        await supabase
          .from('custom_domains')
          .update({ status: 'dns_verified', dns_verified_at: new Date().toISOString(), error_message: null })
          .eq('id', domain.id);
      }

      return res.json({ verified, status: verified ? 'dns_verified' : domain.status });
    } catch (err) {
      return res.status(500).json({ error: 'DNS verification failed' });
    }
  });

  // POST /:domainId/assign — Assign domain to content
  router.post('/:domainId/assign', async (req: Request, res: Response) => {
    try {
      const { content_type, content_id, content_slug } = req.body;

      if (!content_type) {
        return res.status(400).json({ error: 'content_type is required' });
      }

      // Top-level assignment: content_id is __top_level__ or missing
      const isTopLevel = !content_id || content_id === '__top_level__';
      const effectiveContentId = isTopLevel ? null : content_id;

      const supabase = getSupabase();
      const { data: domain } = await supabase
        .from('custom_domains')
        .select('*')
        .eq('id', req.params.domainId)
        .maybeSingle();

      if (!domain) return res.status(404).json({ error: 'Domain not found' });

      // Domain must be verified or active to assign
      if (!['dns_verified', 'provisioning', 'active'].includes(domain.status)) {
        return res.status(400).json({
          error: `Domain must be DNS-verified before assignment. Current status: ${domain.status}`,
        });
      }

      // Check if domain is already assigned to different content
      if (domain.content_id && effectiveContentId && domain.content_id !== effectiveContentId) {
        return res.status(409).json({
          error: `Domain is already assigned to ${domain.content_type}:${domain.content_id}. Unassign first.`,
        });
      }

      const { data, error } = await supabase
        .from('custom_domains')
        .update({
          content_type,
          content_id: effectiveContentId,
          content_slug: content_slug || null,
        })
        .eq('id', req.params.domainId)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to assign domain' });
    }
  });

  // DELETE /:domainId/assign — Unassign domain from content
  router.delete('/:domainId/assign', async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();

      const { data, error } = await supabase
        .from('custom_domains')
        .update({ content_type: null, content_id: null, content_slug: null })
        .eq('id', req.params.domainId)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to unassign domain' });
    }
  });

  // GET /available — List active, unassigned domains
  router.get('/available', async (_req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('custom_domains')
        .select('id, domain, status')
        .eq('status', 'active')
        .is('content_id', null)
        .order('domain');

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list available domains' });
    }
  });

  // GET /lookup/:contentType/:contentId — Look up custom domain for a content item
  // Used by other modules to get the custom domain URL for links, QR codes, etc.
  router.get('/lookup/:contentType/:contentId', async (req: Request, res: Response) => {
    try {
      const { contentType, contentId } = req.params;
      const supabase = getSupabase();

      const { data, error } = await supabase
        .from('custom_domains')
        .select('id, domain, status, content_slug')
        .eq('content_type', contentType)
        .eq('content_id', contentId)
        .eq('status', 'active')
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.json({ domain: null });

      return res.json({
        domain: data.domain,
        url: `https://${data.domain}`,
        content_slug: data.content_slug,
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to lookup domain' });
    }
  });

  // GET /lookup-batch — Look up custom domains for multiple content items
  // Body: { items: [{ content_type, content_id }] }
  router.post('/lookup-batch', async (req: Request, res: Response) => {
    try {
      const { items } = req.body;
      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'items array required' });
      }

      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('custom_domains')
        .select('domain, content_type, content_id')
        .eq('status', 'active')
        .not('content_id', 'is', null);

      if (error) return res.status(500).json({ error: error.message });

      // Build a map of content_type:content_id → domain
      const domainMap: Record<string, string> = {};
      for (const row of data || []) {
        if (row.content_id) {
          domainMap[`${row.content_type}:${row.content_id}`] = row.domain;
        }
      }

      // Return domains for requested items
      const results = items.map((item: { content_type: string; content_id: string }) => {
        const domain = domainMap[`${item.content_type}:${item.content_id}`];
        return {
          content_type: item.content_type,
          content_id: item.content_id,
          domain: domain || null,
          url: domain ? `https://${domain}` : null,
        };
      });

      return res.json(results);
    } catch (err) {
      return res.status(500).json({ error: 'Failed to batch lookup domains' });
    }
  });

  app.use('/api/modules/custom-domains', router);
}
