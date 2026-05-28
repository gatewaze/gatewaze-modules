-- ============================================================================
-- Module: ai
-- Migration: 037_relax_mcp_uri_https_internal
-- Description: Allow http:// for INTERNAL single-label hosts (Docker/k8s
--              service names, e.g. http://browser-mcp:8080/mcp) in
--              ai_mcp_servers.uri, so dedicated in-cluster MCP services can be
--              registered as type=streamable_http without TLS termination.
--
--              Public / dotted hosts STILL require https — the host part of the
--              http:// alternative is a single DNS label (no dots), which only
--              matches in-cluster service names, never a public domain or an
--              IP literal. The network-level protection is unchanged: the
--              runtime SSRF guard (checkSsrfSafe) still rejects private targets
--              unless AI_MCP_HTTP_ALLOW_PRIVATE=true is set on the worker/api.
--              This migration only relaxes the storage-layer https-only check.
-- ============================================================================

ALTER TABLE public.ai_mcp_servers DROP CONSTRAINT IF EXISTS ai_mcp_servers_uri_https;

ALTER TABLE public.ai_mcp_servers ADD CONSTRAINT ai_mcp_servers_uri_https CHECK (
  uri IS NULL
  OR uri ~ '^https://'
  -- http:// only for a single-label host (Docker/k8s service name), optional
  -- :port and /path. Dotted hosts and IP literals do not match → still https.
  OR uri ~ '^http://[a-z0-9]([a-z0-9-]*[a-z0-9])?(:[0-9]+)?(/.*)?$'
);

COMMENT ON CONSTRAINT ai_mcp_servers_uri_https ON public.ai_mcp_servers IS
  'streamable_http MCP URIs must be https, EXCEPT http:// to a single-label '
  'internal host (in-cluster service name). Public/dotted hosts require https. '
  'Network-level SSRF protection is enforced separately at connect time.';
