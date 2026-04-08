/**
 * Custom Domain Controller
 *
 * Runs as a separate Kubernetes Deployment. Polls the custom_domains table
 * and reconciles Kubernetes Ingress + cert-manager Certificate resources.
 *
 * Lifecycle: pending → dns_verified → provisioning → active
 *
 * Environment variables:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key for DB access
 *   CNAME_TARGET              — Expected CNAME target (e.g., custom.aaif.live)
 *   EXPECTED_INGRESS_IP       — Expected A record IP
 *   CLUSTER_ISSUER            — cert-manager ClusterIssuer name (default: letsencrypt-prod)
 *   PORTAL_SERVICE_NAME       — Portal K8s service name (e.g., aaif-portal)
 *   PORTAL_SERVICE_PORT       — Portal service port (default: 3100)
 *   NAMESPACE                 — Kubernetes namespace (default: from in-cluster config)
 *   POLL_INTERVAL_SECONDS     — Poll interval (default: 60)
 */

import { createClient } from '@supabase/supabase-js';
import * as dns from 'dns/promises';
import * as https from 'https';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CNAME_TARGET = process.env.CNAME_TARGET || '';
const EXPECTED_IP = process.env.EXPECTED_INGRESS_IP || '';
const CLUSTER_ISSUER = process.env.CLUSTER_ISSUER || 'letsencrypt-prod';
const PORTAL_SERVICE = process.env.PORTAL_SERVICE_NAME || 'portal';
const PORTAL_PORT = parseInt(process.env.PORTAL_SERVICE_PORT || '3100', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10) * 1000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------------------------------------------------------------------------
// Kubernetes API client (uses in-cluster service account)
// ---------------------------------------------------------------------------

const K8S_API = process.env.KUBERNETES_SERVICE_HOST
  ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
  : 'https://kubernetes.default.svc';

const NAMESPACE = process.env.NAMESPACE ||
  (fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace')
    ? fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim()
    : 'gatewaze');

function getK8sToken() {
  try {
    return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
  } catch {
    return null;
  }
}

function getK8sCa() {
  try {
    return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
  } catch {
    return undefined;
  }
}

async function k8sRequest(method, path, body = null) {
  const token = getK8sToken();
  if (!token) {
    throw new Error('No Kubernetes service account token found — is the controller running in a cluster?');
  }

  const url = `${K8S_API}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ca: getK8sCa(),
    rejectUnauthorized: !!getK8sCa(),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// DNS Verification
// ---------------------------------------------------------------------------

async function verifyDns(domain) {
  try {
    const cnames = await dns.resolveCname(domain).catch(() => []);
    if (CNAME_TARGET && cnames.some(c => c.toLowerCase().includes(CNAME_TARGET.toLowerCase()))) {
      return true;
    }
  } catch { /* expected for apex domains */ }

  try {
    const addresses = await dns.resolve4(domain).catch(() => []);
    if (EXPECTED_IP && addresses.includes(EXPECTED_IP)) return true;
  } catch { /* DNS lookup failed */ }

  return false;
}

// ---------------------------------------------------------------------------
// Ingress Management
// ---------------------------------------------------------------------------

function sanitizeDomain(domain) {
  return domain.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function buildIngress(domain, domainId) {
  const sanitized = sanitizeDomain(domain);
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: `cd-${sanitized}`,
      namespace: NAMESPACE,
      labels: {
        'managed-by': 'gatewaze-custom-domains',
        'domain-id': domainId,
      },
      annotations: {
        'cert-manager.io/cluster-issuer': CLUSTER_ISSUER,
        'nginx.ingress.kubernetes.io/ssl-redirect': 'true',
        'nginx.ingress.kubernetes.io/proxy-body-size': '100m',
        'nginx.ingress.kubernetes.io/proxy-read-timeout': '3600',
        'nginx.ingress.kubernetes.io/proxy-send-timeout': '3600',
      },
    },
    spec: {
      ingressClassName: 'nginx',
      tls: [{ hosts: [domain], secretName: `tls-cd-${sanitized}` }],
      rules: [{
        host: domain,
        http: {
          paths: [{
            path: '/',
            pathType: 'Prefix',
            backend: {
              service: { name: PORTAL_SERVICE, port: { number: PORTAL_PORT } },
            },
          }],
        },
      }],
    },
  };
}

async function createOrUpdateIngress(domain, domainId) {
  const sanitized = sanitizeDomain(domain);
  const ingressName = `cd-${sanitized}`;
  const path = `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/ingresses/${ingressName}`;

  // Check if exists
  const existing = await k8sRequest('GET', path);
  const ingress = buildIngress(domain, domainId);

  if (existing.status === 200) {
    // Update
    const result = await k8sRequest('PUT', path, ingress);
    if (result.status >= 300) throw new Error(`Failed to update Ingress: ${JSON.stringify(result.data)}`);
    return 'updated';
  } else {
    // Create
    const createPath = `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/ingresses`;
    const result = await k8sRequest('POST', createPath, ingress);
    if (result.status >= 300) throw new Error(`Failed to create Ingress: ${JSON.stringify(result.data)}`);
    return 'created';
  }
}

async function deleteIngress(domain) {
  const sanitized = sanitizeDomain(domain);
  const path = `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/ingresses/cd-${sanitized}`;
  const result = await k8sRequest('DELETE', path);
  return result.status < 300 || result.status === 404;
}

// ---------------------------------------------------------------------------
// Certificate Status Check
// ---------------------------------------------------------------------------

async function checkCertificateReady(domain) {
  const sanitized = sanitizeDomain(domain);
  const secretName = `tls-cd-${sanitized}`;

  // Check if the TLS secret exists (cert-manager creates it when cert is ready)
  const path = `/api/v1/namespaces/${NAMESPACE}/secrets/${secretName}`;
  const result = await k8sRequest('GET', path);
  return result.status === 200;
}

// ---------------------------------------------------------------------------
// Main Reconciliation Loop
// ---------------------------------------------------------------------------

async function reconcile() {
  const { data: domains, error } = await supabase
    .from('custom_domains')
    .select('*')
    .neq('status', 'active') // Active domains checked less frequently
    .order('created_at');

  if (error) {
    console.error('[controller] Failed to fetch domains:', error.message);
    return;
  }

  // Also check active domains for self-healing (less frequently)
  const { data: activeDomains } = await supabase
    .from('custom_domains')
    .select('*')
    .eq('status', 'active');

  const allDomains = [...(domains || []), ...(activeDomains || [])];

  for (const domain of allDomains) {
    try {
      await reconcileDomain(domain);
    } catch (err) {
      console.error(`[controller] Error reconciling ${domain.domain}:`, err.message);
      await supabase
        .from('custom_domains')
        .update({ status: 'error', error_message: err.message })
        .eq('id', domain.id);
    }
  }
}

async function reconcileDomain(record) {
  const { id, domain, status } = record;

  switch (status) {
    case 'pending': {
      const verified = await verifyDns(domain);
      if (verified) {
        console.log(`[controller] DNS verified for ${domain}`);
        await supabase
          .from('custom_domains')
          .update({ status: 'dns_verified', dns_verified_at: new Date().toISOString(), error_message: null })
          .eq('id', id);
      }
      break;
    }

    case 'dns_verified': {
      console.log(`[controller] Creating Ingress for ${domain}...`);
      const action = await createOrUpdateIngress(domain, id);
      console.log(`[controller] Ingress ${action} for ${domain}`);
      await supabase
        .from('custom_domains')
        .update({ status: 'provisioning', ingress_created: true })
        .eq('id', id);
      break;
    }

    case 'provisioning': {
      const certReady = await checkCertificateReady(domain);
      if (certReady) {
        console.log(`[controller] Certificate ready for ${domain} — domain is now active!`);
        await supabase
          .from('custom_domains')
          .update({ status: 'active', certificate_ready: true })
          .eq('id', id);
      }
      break;
    }

    case 'active': {
      // Self-healing: verify Ingress still exists
      const sanitized = sanitizeDomain(domain);
      const path = `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/ingresses/cd-${sanitized}`;
      const result = await k8sRequest('GET', path);
      if (result.status === 404) {
        console.warn(`[controller] Ingress missing for active domain ${domain} — recreating`);
        await createOrUpdateIngress(domain, id);
      }
      break;
    }

    case 'removing': {
      console.log(`[controller] Removing Ingress for ${domain}...`);
      await deleteIngress(domain);
      await supabase
        .from('custom_domains')
        .delete()
        .eq('id', id);
      console.log(`[controller] Domain ${domain} removed`);
      break;
    }

    case 'error': {
      // Retry DNS verification for errored domains
      const verified = await verifyDns(domain);
      if (verified) {
        console.log(`[controller] DNS now verified for errored domain ${domain} — retrying`);
        await supabase
          .from('custom_domains')
          .update({ status: 'dns_verified', dns_verified_at: new Date().toISOString(), error_message: null })
          .eq('id', id);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`[controller] Custom Domain Controller starting`);
console.log(`[controller] CNAME target: ${CNAME_TARGET || '(not set)'}`);
console.log(`[controller] Expected IP: ${EXPECTED_IP || '(not set)'}`);
console.log(`[controller] Cluster issuer: ${CLUSTER_ISSUER}`);
console.log(`[controller] Portal service: ${PORTAL_SERVICE}:${PORTAL_PORT}`);
console.log(`[controller] Namespace: ${NAMESPACE}`);
console.log(`[controller] Poll interval: ${POLL_INTERVAL / 1000}s`);

async function run() {
  while (true) {
    try {
      await reconcile();
    } catch (err) {
      console.error('[controller] Reconciliation error:', err.message);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

run();
