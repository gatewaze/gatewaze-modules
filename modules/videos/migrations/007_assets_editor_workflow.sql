-- ============================================================================
-- Module: videos
-- Migration: 007_assets_editor_workflow
-- Description: Gatewaze holds the master before YouTube.
--              spec-videos-publishing-and-platform-metrics §16–§19.
--
-- Until now a `videos` row described something that already existed on a
-- platform. A third-party editor delivering a cut inverts that: the only copy
-- is ours, nothing is published, and what needs managing is a file plus an
-- intention to publish it later. So this adds:
--
--   video_assets          the bytes, with no external id yet
--   video_upload_sessions a resumable upload, so a 2GB file is viable
--   video_subjects        what the video is about (an agenda entry, an episode)
--   video_publications    where it went, or is scheduled to go
--   video_editor_grants   per-subject access, because an editor is not an admin
--
-- Additive throughout. Nothing here changes behaviour for an existing row.
-- ============================================================================

-- ── videos: widen for non-YouTube providers and short-form derivatives ──────
--
-- `provider` was CHECK (provider IN ('youtube')), a single-value enum, so
-- nothing cross-platform could be stored at all. 'gatewaze' is load-bearing
-- rather than a placeholder: a master we hold and have not published anywhere
-- still needs a (provider, provider_video_id) pair for the unique key.
ALTER TABLE public.videos DROP CONSTRAINT IF EXISTS videos_provider_check;
ALTER TABLE public.videos
  ADD CONSTRAINT videos_provider_check CHECK (provider IN (
    'youtube', 'tiktok', 'linkedin', 'instagram', 'x', 'vimeo',
    'spotify', 'apple_podcasts', 'gatewaze'
  ));

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'full'
    CHECK (kind IN ('full', 'short', 'clip', 'trailer', 'livestream')),
  -- The recording a short was cut from. SET NULL so deleting a recording
  -- orphans its shorts rather than destroying them.
  ADD COLUMN IF NOT EXISTS derived_from_video_id uuid
    REFERENCES public.videos(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.videos.kind IS
  'What this video IS. A short is not a worse recording; it publishes separately and carries its own metrics.';

CREATE INDEX IF NOT EXISTS videos_derived_from
  ON public.videos (derived_from_video_id)
  WHERE derived_from_video_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS videos_kind ON public.videos (kind);

-- ── video_subjects: what the video is about ─────────────────────────────────
--
-- Polymorphic on content-platform's (content_type, content_id) convention
-- rather than four nullable FK columns, because a podcast episode and an
-- agenda entry live in different modules and `videos` must install on a brand
-- that has neither.
CREATE TABLE IF NOT EXISTS public.video_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN (
    'agenda_entry', 'event', 'podcast_episode', 'talk', 'person'
  )),
  -- No FK: five target tables across four modules. The reader re-checks the
  -- row and degrades to "unattached" rather than erroring. Same convention as
  -- conference_recap_videos.agenda_entry_id.
  subject_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('auto', 'recap', 'manual', 'editor')),
  confidence numeric(4,3)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS video_subjects_subject
  ON public.video_subjects (subject_type, subject_id);

COMMENT ON TABLE public.video_subjects IS
  'What a video is about. event_videos stays for the coarse portal link; this is the per-talk grain reporting needs.';

-- ── video_assets: the bytes ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.video_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN ('master', 'short', 'caption', 'thumbnail')),

  -- Defaults to the PRIVATE bucket. An asset that is genuinely public (a
  -- thumbnail for a published video) sets this explicitly; defaulting the
  -- other way would put unpublished masters in a world-readable bucket.
  storage_bucket text NOT NULL DEFAULT 'video-masters',
  storage_path text NOT NULL,
  filename text,
  mime_type text,
  bytes bigint,
  duration_seconds integer,
  width integer,
  height integer,
  -- sha256 of the bytes: a re-upload of the same file is a no-op and a
  -- corrupted transfer is detectable.
  checksum text,

  state text NOT NULL DEFAULT 'uploading'
    CHECK (state IN ('uploading', 'ready', 'failed', 'superseded')),
  error text,
  -- An imported YouTube file and an editor's upload have different provenance
  -- and different trust.
  source text NOT NULL DEFAULT 'upload'
    CHECK (source IN ('upload', 'youtube_import', 'recap')),

  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One READY master per video. Shorts are deliberately unbounded, and a
-- superseded or failed master does not block a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS video_assets_one_master
  ON public.video_assets (video_id)
  WHERE kind = 'master' AND state = 'ready';

CREATE INDEX IF NOT EXISTS video_assets_video ON public.video_assets (video_id, kind);
CREATE INDEX IF NOT EXISTS video_assets_state ON public.video_assets (state)
  WHERE state = 'uploading';

-- ── video_upload_sessions: resumable, direct to storage ─────────────────────
--
-- The bytes never pass through the API container. That is the only reason a
-- 2GB upload over a domestic connection is viable: a single POST cannot
-- resume and dies against any body-size limit in the path.
CREATE TABLE IF NOT EXISTS public.video_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES public.video_assets(id) ON DELETE CASCADE,
  storage_bucket text NOT NULL DEFAULT 'video-masters',
  storage_path text NOT NULL,
  expected_bytes bigint,
  expected_mime text,
  -- Opaque handle from the storage provider's resumable protocol.
  provider_upload_id text,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'completed', 'aborted', 'expired')),
  created_by uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS video_upload_sessions_open
  ON public.video_upload_sessions (expires_at)
  WHERE state = 'open';

-- ── video_publications: where it went, or is scheduled to go ────────────────
CREATE TABLE IF NOT EXISTS public.video_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  -- Free text with no CHECK on purpose: a new platform is a new module, and a
  -- migration in the host module should not be what blocks installing one.
  platform text NOT NULL,
  -- Which ACCOUNT. AAIF runs two YouTube channels, so the platform alone does
  -- not identify where a video went. Nullable until §4.5's connections table
  -- exists; the publisher refuses a row without one.
  connection_id uuid,

  state text NOT NULL DEFAULT 'draft' CHECK (state IN (
    'draft', 'scheduled', 'queued', 'uploading', 'processing',
    'published', 'failed', 'removed'
  )),
  -- NULL means "now, on the next tick".
  scheduled_for timestamptz,
  -- Mirrors the platforms' own vocabulary rather than inventing one.
  requested_visibility text NOT NULL DEFAULT 'private'
    CHECK (requested_visibility IN ('public', 'unlisted', 'private')),

  external_id text,
  external_url text,
  external_visibility text
    CHECK (external_visibility IS NULL OR external_visibility IN ('public', 'unlisted', 'private')),

  -- What we asked for, so a re-publish is reproducible.
  requested jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the platform said, verbatim, so the UI needs no second call.
  response jsonb,

  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  -- A credential problem is terminal and must stop the retry loop; a timeout
  -- is not.
  last_error_kind text
    CHECK (last_error_kind IS NULL OR last_error_kind IN ('auth', 'quota', 'rejected', 'transient')),
  -- Recorded rather than hidden: if the worker was down, a schedule still
  -- publishes, late, and says so. Dropping it would leave the editor
  -- believing it went out.
  published_late_by_seconds integer,

  requested_by uuid,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One publication per video per account. Publishing the same talk to both
-- AAIF channels is two rows, which is the point.
CREATE UNIQUE INDEX IF NOT EXISTS video_publications_video_connection
  ON public.video_publications (video_id, connection_id)
  WHERE connection_id IS NOT NULL;

-- The external id is what a metrics collector looks up.
CREATE UNIQUE INDEX IF NOT EXISTS video_publications_external
  ON public.video_publications (platform, external_id)
  WHERE external_id IS NOT NULL;

-- The due-work index for videos:publish-due.
CREATE INDEX IF NOT EXISTS video_publications_due
  ON public.video_publications (scheduled_for)
  WHERE state = 'scheduled';

-- ── video_editor_grants: a third-party editor is not an admin ───────────────
--
-- The existing module admin routes authorise with is_admin(), which is far
-- too much for a contractor: it would let them read every event's import
-- outcomes and start a backfill. Access is granted per subject instead.
CREATE TABLE IF NOT EXISTS public.video_editor_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- auth.users id. No FK: auth is another schema, and a deleted user must not
  -- delete the record of what they were given.
  user_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('event', 'podcast', 'all')),
  subject_id uuid,
  can_upload boolean NOT NULL DEFAULT true,
  -- Deliberately separate. Letting someone deliver a file and letting them put
  -- it on the foundation's public channel at a time of their choosing are
  -- different decisions.
  can_schedule boolean NOT NULL DEFAULT false,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS video_editor_grants_user
  ON public.video_editor_grants (user_id);

-- A 'all' grant must not carry a subject id, and a scoped grant must.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'video_editor_grants_subject_coherent'
  ) THEN
    ALTER TABLE public.video_editor_grants
      ADD CONSTRAINT video_editor_grants_subject_coherent CHECK (
        (subject_type = 'all' AND subject_id IS NULL)
        OR (subject_type <> 'all' AND subject_id IS NOT NULL)
      );
  END IF;
END $$;

-- ── The access predicate every route and policy uses ────────────────────────
--
-- SECURITY DEFINER so it can read the grants table regardless of the caller's
-- own policies, and STABLE so the planner may cache it within a statement.
-- search_path is pinned: a SECURITY DEFINER function without it can be
-- hijacked by a caller-controlled search_path.
CREATE OR REPLACE FUNCTION public.can_edit_videos_for(
  p_subject_type text,
  p_subject_id uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.video_editor_grants g
    WHERE g.user_id = auth.uid()
      AND (
        g.subject_type = 'all'
        OR (g.subject_type = p_subject_type AND g.subject_id = p_subject_id)
      )
  );
$$;

COMMENT ON FUNCTION public.can_edit_videos_for(text, uuid) IS
  'True when the caller is an admin, or holds a video-editor grant covering this subject.';

REVOKE ALL ON FUNCTION public.can_edit_videos_for(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_videos_for(text, uuid) TO authenticated;

-- Does the caller hold any grant at all? Used to decide whether to show the
-- module at all, without leaking which subjects exist.
CREATE OR REPLACE FUNCTION public.can_edit_any_videos()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT public.is_admin() OR EXISTS (
    SELECT 1 FROM public.video_editor_grants g WHERE g.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.can_edit_any_videos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_any_videos() TO authenticated;

-- ── The predicate that actually protects a video ────────────────────────────
--
-- can_edit_any_videos() answers "does this person hold any grant at all". That
-- is the right question for "should the module appear in the nav" and the
-- WRONG question for "may they touch this row". A security review of the first
-- version of this migration found the difference exploitable without going
-- through the application at all: with `USING (can_edit_any_videos())` on
-- video_assets, an editor granted one event could read every master's
-- storage_path in the system straight through PostgREST, then ask the API for
-- a signed URL for any of them.
--
-- So this resolves a video to the subject that OWNS it and checks the grant
-- against that. The mapping is the awkward part: grants are held on an
-- 'event' or a 'podcast', while video_subjects records the finer grain the
-- editor actually works at, an 'agenda_entry' or a 'podcast_episode'. Those
-- belong to other modules, so the lookups are dynamic and guarded with
-- to_regclass: `videos` must install on a brand that has neither module, and
-- a missing table means "cannot establish ownership", which denies.
CREATE OR REPLACE FUNCTION public.can_edit_video(p_video_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  owner_id uuid;
BEGIN
  IF public.is_admin() THEN
    RETURN true;
  END IF;
  IF p_video_id IS NULL THEN
    RETURN false;
  END IF;

  -- An 'all' grant covers everything, and is checked first so the common
  -- admin-ish case does no joins.
  IF EXISTS (
    SELECT 1 FROM public.video_editor_grants g
    WHERE g.user_id = auth.uid() AND g.subject_type = 'all'
  ) THEN
    RETURN true;
  END IF;

  FOR r IN
    SELECT subject_type, subject_id
    FROM public.video_subjects
    WHERE video_id = p_video_id
  LOOP
    IF r.subject_type = 'event' THEN
      IF public.can_edit_videos_for('event', r.subject_id) THEN RETURN true; END IF;

    ELSIF r.subject_type IN ('agenda_entry', 'talk') THEN
      IF to_regclass('public.events_agenda_entries') IS NOT NULL THEN
        EXECUTE 'SELECT event_uuid FROM public.events_agenda_entries WHERE id = $1'
          INTO owner_id USING r.subject_id;
        IF owner_id IS NOT NULL AND public.can_edit_videos_for('event', owner_id) THEN
          RETURN true;
        END IF;
      END IF;

    ELSIF r.subject_type = 'podcast_episode' THEN
      IF to_regclass('public.podcast_episodes') IS NOT NULL THEN
        EXECUTE 'SELECT podcast_id FROM public.podcast_episodes WHERE id = $1'
          INTO owner_id USING r.subject_id;
        IF owner_id IS NOT NULL AND public.can_edit_videos_for('podcast', owner_id) THEN
          RETURN true;
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- A video with no subject at all belongs to nobody, so nobody but an admin
  -- may touch it. That is deliberate: an orphan is not a free-for-all.
  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.can_edit_video(uuid) IS
  'True when the caller may edit this specific video, resolved through its subject to the event or podcast the grant is held on.';

REVOKE ALL ON FUNCTION public.can_edit_video(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_video(uuid) TO authenticated;

/** Does the caller hold a grant covering the subject that owns this unit? */
CREATE OR REPLACE FUNCTION public.can_edit_videos_for_unit(
  p_subject_type text,
  p_unit_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  owner_id uuid;
BEGIN
  IF public.is_admin() THEN RETURN true; END IF;
  IF p_unit_id IS NULL THEN RETURN false; END IF;

  IF p_subject_type = 'event' THEN
    IF to_regclass('public.events_agenda_entries') IS NULL THEN RETURN false; END IF;
    EXECUTE 'SELECT event_uuid FROM public.events_agenda_entries WHERE id = $1'
      INTO owner_id USING p_unit_id;
    RETURN owner_id IS NOT NULL AND public.can_edit_videos_for('event', owner_id);
  ELSIF p_subject_type = 'podcast' THEN
    IF to_regclass('public.podcast_episodes') IS NULL THEN RETURN false; END IF;
    EXECUTE 'SELECT podcast_id FROM public.podcast_episodes WHERE id = $1'
      INTO owner_id USING p_unit_id;
    RETURN owner_id IS NOT NULL AND public.can_edit_videos_for('podcast', owner_id);
  END IF;
  RETURN false;
END;
$$;

COMMENT ON FUNCTION public.can_edit_videos_for_unit(text, uuid) IS
  'True when the caller may edit videos for the event or podcast that owns this agenda entry or episode. Stops an editor attaching an upload to another subject''s talk.';

REVOKE ALL ON FUNCTION public.can_edit_videos_for_unit(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_edit_videos_for_unit(text, uuid) TO authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Every writer here is the worker or an admin route running as the service
-- role, which bypasses RLS. So no INSERT/UPDATE/DELETE policy is granted to
-- `authenticated` on purpose: an editor's writes go through the module API,
-- which applies can_edit_videos_for() as the CALLER before using the service
-- role. That keeps one authorisation decision in one place.
--
-- Reads are granted, because the admin UI reads directly in places.

ALTER TABLE public.video_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.video_editor_grants ENABLE ROW LEVEL SECURITY;

-- Every read policy here is scoped to the video's OWNING subject via
-- can_edit_video(), not to "holds any grant". The first version of this
-- migration used can_edit_any_videos() and a security review showed the
-- difference was exploitable straight through PostgREST: one grant anywhere
-- returned every master's storage_path in the system.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_subjects' AND policyname='video_subjects_select') THEN
    CREATE POLICY video_subjects_select ON public.video_subjects
      FOR SELECT TO authenticated
      USING (public.can_edit_video(video_id));
  END IF;

  -- Assets and sessions carry a storage path, which is not public data.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_assets' AND policyname='video_assets_select') THEN
    CREATE POLICY video_assets_select ON public.video_assets
      FOR SELECT TO authenticated
      USING (public.can_edit_video(video_id));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_upload_sessions' AND policyname='video_upload_sessions_select') THEN
    CREATE POLICY video_upload_sessions_select ON public.video_upload_sessions
      FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.video_assets a
        WHERE a.id = video_upload_sessions.asset_id
          AND public.can_edit_video(a.video_id)
      ));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_publications' AND policyname='video_publications_select') THEN
    CREATE POLICY video_publications_select ON public.video_publications
      FOR SELECT TO authenticated
      USING (public.can_edit_video(video_id));
  END IF;

  -- A grant row names a person and what they may touch. Admins only, plus
  -- your own rows so the UI can tell you what you have.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_editor_grants' AND policyname='video_editor_grants_select') THEN
    CREATE POLICY video_editor_grants_select ON public.video_editor_grants
      FOR SELECT TO authenticated
      USING (public.is_admin() OR user_id = auth.uid());
  END IF;
END $$;

-- ── updated_at maintenance ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.videos_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['video_assets', 'video_publications'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = t || '_touch_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.videos_touch_updated_at()',
        t || '_touch_updated_at', t
      );
    END IF;
  END LOOP;
END $$;

-- ── A PRIVATE bucket, because the shared one is world-readable ──────────────
--
-- The `media` bucket is `public = true`, and its RLS SELECT policy is
-- `USING (bucket_id = 'media')` with no role and no path predicate
-- (supabase/migrations/00006_rls_policies.sql). So every object in it is
-- readable by anyone who knows the URL, and `host_media.access_level` plus
-- the adapter's createSignedUrl only change which URL the API hands out; they
-- do not restrict the object.
--
-- That is fine for published photos. It is not fine for an unpublished talk
-- recording sitting in storage waiting for an editor's cut to be approved,
-- which is exactly what this migration introduces. So masters get their own
-- bucket, not public, and playback is by signed URL only.
--
-- 5 GiB per file, matching the `media` bucket, which is above the largest
-- realistic talk recording and below Supabase's own ceiling.
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit)
  VALUES ('video-masters', 'video-masters', false, 5368709120)
  ON CONFLICT (id) DO UPDATE
    SET public = false, file_size_limit = EXCLUDED.file_size_limit;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping video-masters bucket insert — storage.buckets not writable here';
END;
$$;

-- Reads and writes are service-role or an explicit grant holder. No anon
-- policy at all: there is no case for an anonymous read of an unpublished
-- master, and omitting the policy is how that stays true.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'storage_select_video_masters'
  ) THEN
    -- Scoped by joining the object's path back to its asset row. The path is
    -- the only link storage has to a video, which is why buildStoragePath
    -- puts the asset id in it. `can_edit_any_videos()` here would have let any
    -- grant holder read every unpublished master in the bucket.
    CREATE POLICY storage_select_video_masters
      ON storage.objects FOR SELECT TO authenticated
      USING (
        bucket_id = 'video-masters'
        AND EXISTS (
          SELECT 1 FROM public.video_assets a
          WHERE a.storage_bucket = 'video-masters'
            AND a.storage_path = storage.objects.name
            AND public.can_edit_video(a.video_id)
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'storage_write_video_masters'
  ) THEN
    -- Editors upload through a signed URL minted by the module API, which runs
    -- as the service role and bypasses RLS. This policy exists so an admin
    -- can also work directly, not as the editor's path.
    CREATE POLICY storage_write_video_masters
      ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'video-masters' AND public.is_admin());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'storage_delete_video_masters'
  ) THEN
    CREATE POLICY storage_delete_video_masters
      ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'video-masters' AND public.is_admin());
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping video-masters storage policies — storage.objects not alterable here';
END;
$$;
