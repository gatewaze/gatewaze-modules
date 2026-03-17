-- Segments Module: Core Tables
-- Migration: 001_segments_tables.sql

-- 1. Segments
CREATE TABLE IF NOT EXISTS public.module_segments (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  description text,
  segment_type text NOT NULL DEFAULT 'manual', -- manual, dynamic, imported
  filter_criteria jsonb DEFAULT '{}'::jsonb,
  member_count integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Segment members
CREATE TABLE IF NOT EXISTS public.module_segment_members (
  id bigserial PRIMARY KEY,
  segment_id bigint NOT NULL REFERENCES public.module_segments(id) ON DELETE CASCADE,
  member_email text NOT NULL,
  member_name text,
  added_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  UNIQUE(segment_id, member_email)
);

CREATE INDEX IF NOT EXISTS idx_module_segment_members_segment ON public.module_segment_members(segment_id);
CREATE INDEX IF NOT EXISTS idx_module_segment_members_email ON public.module_segment_members(member_email);

-- 3. RLS
ALTER TABLE public.module_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_segment_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_all_module_segments" ON public.module_segments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_module_segment_members" ON public.module_segment_members FOR ALL TO authenticated USING (true) WITH CHECK (true);
