-- ============================================================================
-- Environments module: tables for managing Supabase environment connections
-- and tracking content sync operations between them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- environments: registered Supabase instances (local, cloud, self-hosted)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,

  -- Connection details
  supabase_url TEXT NOT NULL,
  supabase_anon_key TEXT,
  supabase_service_role_key TEXT,

  -- Classification
  type TEXT NOT NULL DEFAULT 'development'
    CHECK (type IN ('development', 'staging', 'production', 'self-hosted')),

  -- Which environment is "current" (the one this instance is running against)
  is_current BOOLEAN NOT NULL DEFAULT false,

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'unreachable')),
  last_connected_at TIMESTAMPTZ,

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one environment can be marked as current
CREATE UNIQUE INDEX IF NOT EXISTS environments_current_unique
  ON public.environments (is_current) WHERE is_current = true;

-- ---------------------------------------------------------------------------
-- environment_sync_profiles: reusable sync configurations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.environment_sync_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,

  -- What to sync
  include_tables TEXT[] NOT NULL DEFAULT '{}',
  exclude_tables TEXT[] NOT NULL DEFAULT '{}',
  include_storage_buckets TEXT[] NOT NULL DEFAULT '{}',
  include_edge_functions BOOLEAN NOT NULL DEFAULT false,
  include_auth_config BOOLEAN NOT NULL DEFAULT false,

  -- Sync behavior
  conflict_strategy TEXT NOT NULL DEFAULT 'skip'
    CHECK (conflict_strategy IN ('skip', 'overwrite', 'merge')),
  batch_size INT NOT NULL DEFAULT 1000,

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- environment_sync_operations: log of every push/pull operation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.environment_sync_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Direction and endpoints
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
  source_environment_id UUID NOT NULL REFERENCES public.environments(id) ON DELETE CASCADE,
  target_environment_id UUID NOT NULL REFERENCES public.environments(id) ON DELETE CASCADE,

  -- Optional sync profile used
  sync_profile_id UUID REFERENCES public.environment_sync_profiles(id) ON DELETE SET NULL,

  -- What was synced (snapshot of the profile at time of sync)
  tables_synced TEXT[] NOT NULL DEFAULT '{}',
  storage_buckets_synced TEXT[] NOT NULL DEFAULT '{}',
  edge_functions_synced BOOLEAN NOT NULL DEFAULT false,
  auth_config_synced BOOLEAN NOT NULL DEFAULT false,

  -- Execution state
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,

  -- Stats
  rows_processed INT NOT NULL DEFAULT 0,
  rows_inserted INT NOT NULL DEFAULT 0,
  rows_updated INT NOT NULL DEFAULT 0,
  rows_skipped INT NOT NULL DEFAULT 0,
  files_synced INT NOT NULL DEFAULT 0,

  -- Detailed log entries (JSONB array)
  log JSONB NOT NULL DEFAULT '[]',

  initiated_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for querying sync history by environment
CREATE INDEX IF NOT EXISTS idx_sync_ops_source ON public.environment_sync_operations(source_environment_id);
CREATE INDEX IF NOT EXISTS idx_sync_ops_target ON public.environment_sync_operations(target_environment_id);
CREATE INDEX IF NOT EXISTS idx_sync_ops_status ON public.environment_sync_operations(status);

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------
ALTER TABLE public.environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.environment_sync_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.environment_sync_operations ENABLE ROW LEVEL SECURITY;

-- Environments: admins can view, super_admins can manage
CREATE POLICY environments_select ON public.environments
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY environments_manage ON public.environments
  FOR ALL TO authenticated
  USING (public.is_super_admin());

-- Service role has full access
CREATE POLICY environments_service ON public.environments
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Sync profiles: admins can view, super_admins can manage
CREATE POLICY sync_profiles_select ON public.environment_sync_profiles
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY sync_profiles_manage ON public.environment_sync_profiles
  FOR ALL TO authenticated
  USING (public.is_super_admin());

CREATE POLICY sync_profiles_service ON public.environment_sync_profiles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Sync operations: admins can view, super_admins can manage
CREATE POLICY sync_ops_select ON public.environment_sync_operations
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY sync_ops_manage ON public.environment_sync_operations
  FOR ALL TO authenticated
  USING (public.is_super_admin());

CREATE POLICY sync_ops_service ON public.environment_sync_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Updated-at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.environments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER environments_updated_at_trigger
  BEFORE UPDATE ON public.environments
  FOR EACH ROW EXECUTE FUNCTION public.environments_updated_at();

CREATE TRIGGER sync_profiles_updated_at_trigger
  BEFORE UPDATE ON public.environment_sync_profiles
  FOR EACH ROW EXECUTE FUNCTION public.environments_updated_at();
