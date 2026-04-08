import { Router, type Request, type Response } from 'express';
import type { ModuleContext } from '@gatewaze/shared';
import { createClient } from '@supabase/supabase-js';
import * as dns from 'dns/promises';

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

export function registerRoutes(app: any, _context?: ModuleContext) {
  const router = Router();

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

  // PUT /:domainId — Update domain settings (branding)
  router.put('/:domainId', async (req: Request, res: Response) => {
    try {
      const { page_title, favicon_url } = req.body;
      const supabase = getSupabase();

      const { data, error } = await supabase
        .from('custom_domains')
        .update({ page_title, favicon_url })
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

      if (!content_type || !content_id) {
        return res.status(400).json({ error: 'content_type and content_id are required' });
      }

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
      if (domain.content_id && domain.content_id !== content_id) {
        return res.status(409).json({
          error: `Domain is already assigned to ${domain.content_type}:${domain.content_id}. Unassign first.`,
        });
      }

      const { data, error } = await supabase
        .from('custom_domains')
        .update({ content_type, content_id, content_slug })
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

  app.use('/api/modules/custom-domains', router);
}
