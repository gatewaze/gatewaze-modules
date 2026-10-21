-- ============================================================================
-- 096_edition_approval
-- ============================================================================
-- Executive-director approval before a newsletter is sent.
--
-- A publication (newsletters_template_collections row) may name approvers.
-- When it has at least one, no edition of it can be sent until an approver
-- has approved the edition's CURRENT content:
--
--   * newsletters_collection_approvers   who may approve, per publication.
--                                        Only super admins change it.
--   * newsletters_edition_approvals      one row per approval request, with
--                                        the decision recorded on the row.
--
-- An approval is tied to a hash of the edition's subject, preheader, blocks
-- and bricks (newsletters_edition_content_hash), not to the save counter, so
-- a save that changes nothing keeps the approval and any real edit after
-- approval needs approving again.
--
-- Enforcement is the existing send gate (094): newsletters_send_gate now
-- also returns APPROVAL_REQUIRED / APPROVAL_PENDING /
-- APPROVAL_CHANGES_REQUESTED / APPROVAL_STALE. The BEFORE INSERT trigger on
-- newsletter_sends refuses the send, and a scheduled send is held by the
-- dispatcher until the edition is approved.
--
-- Who may do what:
--   * any admin can request approval (the editor);
--   * only a configured approver can approve or ask for changes;
--   * an approver can approve a request they made themselves only when they
--     are a super admin, and only a super admin approver can approve without
--     a pending request. So only a super admin can be both editor and
--     approver and send on their own say-so.
-- All writes go through the SECURITY DEFINER functions below. The tables
-- are readable by admins and writable by nobody else.
--
-- Access to the approval view (route newsletters/approve/:id) is the module
-- feature 'newsletters.approve'. Setting approvers grants it to them and
-- removing someone from every publication withdraws it, so an executive
-- director needs no other admin permission. Only grants made here (no
-- granted_by) are withdrawn; one an admin gave by hand is left alone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.newsletters_collection_approvers (
  collection_id uuid NOT NULL REFERENCES public.newsletters_template_collections(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.newsletters_edition_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id     uuid NOT NULL REFERENCES public.newsletters_editions(id) ON DELETE CASCADE,
  collection_id  uuid,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'changes_requested', 'superseded')),
  requested_by   uuid,
  requested_at   timestamptz,
  request_note   text CHECK (request_note IS NULL OR length(request_note) <= 2000),
  requested_hash text,
  decided_by     uuid,
  decided_at     timestamptz,
  decision_note  text CHECK (decision_note IS NULL OR length(decision_note) <= 2000),
  decided_hash   text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS newsletters_edition_approvals_edition_idx
  ON public.newsletters_edition_approvals (edition_id, created_at DESC);

ALTER TABLE public.newsletters_collection_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.newsletters_edition_approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS newsletters_collection_approvers_admin_read ON public.newsletters_collection_approvers;
CREATE POLICY newsletters_collection_approvers_admin_read ON public.newsletters_collection_approvers
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS newsletters_edition_approvals_admin_read ON public.newsletters_edition_approvals;
CREATE POLICY newsletters_edition_approvals_admin_read ON public.newsletters_edition_approvals
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
REVOKE ALL ON public.newsletters_collection_approvers, public.newsletters_edition_approvals FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON public.newsletters_collection_approvers, public.newsletters_edition_approvals FROM anon, authenticated;
  GRANT SELECT ON public.newsletters_collection_approvers, public.newsletters_edition_approvals TO authenticated;
  GRANT ALL ON public.newsletters_collection_approvers, public.newsletters_edition_approvals TO service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Content hash: what an approval is tied to.
-- jsonb's text form orders object keys, so the same content always hashes
-- the same. Soft-deleted blocks and bricks (069) are left out.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_edition_content_hash(p_edition_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT md5(jsonb_build_object(
    'title', e.title,
    'preheader', e.preheader,
    'blocks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', b.id, 'type', b.block_type, 'sort', b.sort_order, 'content', b.content,
               'bricks', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object('id', k.id, 'type', k.brick_type, 'sort', k.sort_order, 'content', k.content)
                                  ORDER BY k.sort_order, k.id)
                 FROM public.newsletters_edition_bricks k
                 WHERE k.block_id = b.id AND k.deleted_at IS NULL), '[]'::jsonb))
             ORDER BY b.sort_order, b.id)
      FROM public.newsletters_edition_blocks b
      WHERE b.edition_id = e.id AND b.deleted_at IS NULL), '[]'::jsonb)
  )::text)
  FROM public.newsletters_editions e
  WHERE e.id = p_edition_id
$$;

-- ---------------------------------------------------------------------------
-- The approval part of the send gate. Read-only. Mirrors the shape of the
-- research gate so newsletters_send_gate can return either.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_approval_gate(p_edition_id uuid)
RETURNS TABLE (allowed boolean, reason_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_collection uuid;
  a record;
BEGIN
  SELECT collection_id INTO v_collection FROM public.newsletters_editions WHERE id = p_edition_id;
  -- Approval is required when the edition's publication has approvers. An
  -- edition that has lost its publication (deleted, or collection_id
  -- cleared) but has been through approval stays gated: that must not be a
  -- way round it. A super admin turning approval off for a publication does
  -- unlock its editions. The guard triggers below stop anyone else moving an
  -- edition out of, or deleting, a publication that has approvers.
  IF NOT EXISTS (SELECT 1 FROM public.newsletters_collection_approvers WHERE collection_id = v_collection)
     AND NOT (v_collection IS NULL
              AND EXISTS (SELECT 1 FROM public.newsletters_edition_approvals WHERE edition_id = p_edition_id)) THEN
    RETURN QUERY SELECT true, 'OK'; RETURN;
  END IF;
  SELECT * INTO a FROM public.newsletters_edition_approvals
   WHERE edition_id = p_edition_id AND status <> 'superseded'
   ORDER BY created_at DESC LIMIT 1;
  IF a.id IS NULL THEN RETURN QUERY SELECT false, 'APPROVAL_REQUIRED'; RETURN; END IF;
  IF a.status = 'pending' THEN RETURN QUERY SELECT false, 'APPROVAL_PENDING'; RETURN; END IF;
  IF a.status = 'changes_requested' THEN RETURN QUERY SELECT false, 'APPROVAL_CHANGES_REQUESTED'; RETURN; END IF;
  IF a.decided_hash IS DISTINCT FROM public.newsletters_edition_content_hash(p_edition_id) THEN
    RETURN QUERY SELECT false, 'APPROVAL_STALE'; RETURN;
  END IF;
  RETURN QUERY SELECT true, 'OK';
END $$;

-- ---------------------------------------------------------------------------
-- newsletters_send_gate: the research checks are unchanged from 094 (keep
-- the two in step), then the approval gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_send_gate(p_edition_id uuid)
RETURNS TABLE (allowed boolean, reason_code text, block_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b record; r record; g record;
BEGIN
  FOR b IN
    SELECT eb.id, d.data_source
    FROM public.newsletters_edition_blocks eb
    JOIN public.templates_block_defs d ON d.id = eb.templates_block_def_id
    WHERE eb.edition_id = p_edition_id AND eb.deleted_at IS NULL
      AND d.source_kind = 'research' AND coalesce(d.data_source->>'schedule','edition') = 'edition'
  LOOP
    SELECT * INTO r FROM public.newsletters_research_runs rr WHERE rr.block_id = b.id ORDER BY rr.seq DESC LIMIT 1;
    IF r.id IS NULL THEN RETURN QUERY SELECT false, 'NO_RESEARCH_RUN', b.id; RETURN; END IF;
    IF r.status IN ('queued','running') THEN RETURN QUERY SELECT false, 'RESEARCH_IN_PROGRESS', b.id; RETURN; END IF;
    IF r.status = 'failed' AND r.failure_kind = 'cost_cap' THEN RETURN QUERY SELECT false, 'COST_CAP_BREACH', b.id; RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.newsletters_research_runs rr WHERE rr.block_id = b.id AND rr.status = 'complete') THEN
      RETURN QUERY SELECT false, 'NO_RESEARCH_RUN', b.id; RETURN;
    END IF;
  END LOOP;
  SELECT * INTO g FROM public.newsletters_approval_gate(p_edition_id);
  IF NOT g.allowed THEN RETURN QUERY SELECT false, g.reason_code, NULL::uuid; RETURN; END IF;
  RETURN QUERY SELECT true, 'OK', NULL::uuid;
END $$;

-- ---------------------------------------------------------------------------
-- Approvers per publication (super admins only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_set_collection_approvers(p_collection_id uuid, p_user_ids uuid[])
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_bad uuid; v_count integer;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'only a super admin can change who approves a newsletter' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.newsletters_template_collections WHERE id = p_collection_id) THEN
    RAISE EXCEPTION 'newsletter not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF cardinality(COALESCE(p_user_ids, '{}')) > 20 THEN
    RAISE EXCEPTION 'at most 20 approvers' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT u INTO v_bad FROM unnest(COALESCE(p_user_ids, '{}')) u
   WHERE NOT EXISTS (SELECT 1 FROM public.admin_profiles ap WHERE ap.user_id = u AND ap.is_active)
   LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'approver % is not an active admin user', v_bad USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM public.newsletters_collection_approvers
   WHERE collection_id = p_collection_id AND NOT (user_id = ANY (COALESCE(p_user_ids, '{}')));
  INSERT INTO public.newsletters_collection_approvers (collection_id, user_id, created_by)
  SELECT p_collection_id, u, auth.uid() FROM (SELECT DISTINCT unnest(COALESCE(p_user_ids, '{}')) AS u) x
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO v_count FROM public.newsletters_collection_approvers WHERE collection_id = p_collection_id;

  -- Keep the 'newsletters.approve' feature in step with being an approver
  -- anywhere (admin_permissions.admin_id is the admin_profiles id).
  IF to_regclass('public.admin_permissions') IS NOT NULL THEN
    INSERT INTO public.admin_permissions (admin_id, feature, is_active)
    SELECT DISTINCT ap.id, 'newsletters.approve', true
      FROM public.newsletters_collection_approvers ca
      JOIN public.admin_profiles ap ON ap.user_id = ca.user_id
     WHERE NOT EXISTS (SELECT 1 FROM public.admin_permissions p
                        WHERE p.admin_id = ap.id AND p.feature = 'newsletters.approve'
                          AND p.account_id IS NULL AND p.is_active);
    DELETE FROM public.admin_permissions p
     WHERE p.feature = 'newsletters.approve' AND p.granted_by IS NULL AND p.account_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.newsletters_collection_approvers ca
                        JOIN public.admin_profiles ap ON ap.user_id = ca.user_id
                       WHERE ap.id = p.admin_id);
  END IF;
  RETURN v_count;
END $$;

-- Admins who can be chosen as approvers, and the current choice. Admin-only.
CREATE OR REPLACE FUNCTION public.newsletters_collection_approver_options(p_collection_id uuid)
RETURNS TABLE (user_id uuid, email text, name text, role text, is_approver boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ap.user_id, ap.email::text,
         COALESCE(NULLIF(btrim(ap.name), ''), NULLIF(btrim(concat_ws(' ', ap.first_name, ap.last_name)), ''), ap.email)::text,
         ap.role::text,
         EXISTS (SELECT 1 FROM public.newsletters_collection_approvers ca
                  WHERE ca.collection_id = p_collection_id AND ca.user_id = ap.user_id)
    FROM public.admin_profiles ap
   WHERE ap.user_id IS NOT NULL
     AND (ap.is_active OR EXISTS (SELECT 1 FROM public.newsletters_collection_approvers ca
                                   WHERE ca.collection_id = p_collection_id AND ca.user_id = ap.user_id))
   ORDER BY 3;
END $$;

-- ---------------------------------------------------------------------------
-- Approval status of one edition, for the Sending tab and the approval view.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_edition_approval_status(p_edition_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_collection uuid;
  v_hash text;
  v_latest jsonb;
  v_approvers jsonb;
  v_gate record;
  v_me uuid := auth.uid();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = '42501';
  END IF;
  SELECT collection_id INTO v_collection FROM public.newsletters_editions WHERE id = p_edition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition not found' USING ERRCODE = 'no_data_found';
  END IF;
  v_hash := public.newsletters_edition_content_hash(p_edition_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', ca.user_id,
           'email', ap.email,
           'name', COALESCE(NULLIF(btrim(ap.name), ''), NULLIF(btrim(concat_ws(' ', ap.first_name, ap.last_name)), ''), ap.email)
         ) ORDER BY ap.email), '[]'::jsonb)
    INTO v_approvers
    FROM public.newsletters_collection_approvers ca
    LEFT JOIN public.admin_profiles ap ON ap.user_id = ca.user_id
   WHERE ca.collection_id = v_collection;
  SELECT jsonb_build_object(
           'id', a.id, 'status', a.status,
           'requested_by', a.requested_by, 'requested_by_email', rq.email, 'requested_at', a.requested_at,
           'request_note', a.request_note,
           'decided_by', a.decided_by, 'decided_by_email', dc.email, 'decided_at', a.decided_at,
           'decision_note', a.decision_note,
           'content_changed_since', CASE WHEN a.status = 'approved' THEN a.decided_hash IS DISTINCT FROM v_hash
                                         ELSE a.requested_hash IS DISTINCT FROM v_hash END)
    INTO v_latest
    FROM public.newsletters_edition_approvals a
    LEFT JOIN public.admin_profiles rq ON rq.user_id = a.requested_by
    LEFT JOIN public.admin_profiles dc ON dc.user_id = a.decided_by
   WHERE a.edition_id = p_edition_id AND a.status <> 'superseded'
   ORDER BY a.created_at DESC LIMIT 1;
  SELECT * INTO v_gate FROM public.newsletters_approval_gate(p_edition_id);
  RETURN jsonb_build_object(
    'required', jsonb_array_length(v_approvers) > 0,
    'approvers', v_approvers,
    'latest', v_latest,
    'gate', jsonb_build_object('allowed', v_gate.allowed, 'reason_code', v_gate.reason_code),
    'is_approver', EXISTS (SELECT 1 FROM public.newsletters_collection_approvers
                            WHERE collection_id = v_collection AND user_id = v_me),
    'is_super_admin', public.is_super_admin(),
    'me', v_me
  );
END $$;

-- ---------------------------------------------------------------------------
-- Request approval (the editor). Supersedes any earlier open request.
-- Returns the request id and the approvers to notify.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_request_edition_approval(p_edition_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_collection uuid;
  v_id uuid;
  v_to jsonb;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = '42501';
  END IF;
  SELECT collection_id INTO v_collection FROM public.newsletters_editions WHERE id = p_edition_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.newsletters_collection_approvers WHERE collection_id = v_collection) THEN
    RAISE EXCEPTION 'this newsletter has no approvers set up' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Re-requesting must not throw away an approval of the content as it is.
  IF EXISTS (SELECT 1 FROM public.newsletters_edition_approvals a
              WHERE a.edition_id = p_edition_id AND a.status = 'approved'
                AND a.decided_hash = public.newsletters_edition_content_hash(p_edition_id)
                AND a.created_at = (SELECT max(created_at) FROM public.newsletters_edition_approvals
                                     WHERE edition_id = p_edition_id AND status <> 'superseded')) THEN
    RAISE EXCEPTION 'this edition is already approved as it stands' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.newsletters_edition_approvals
     SET status = 'superseded'
   WHERE edition_id = p_edition_id AND status IN ('pending', 'changes_requested', 'approved');
  INSERT INTO public.newsletters_edition_approvals
    (edition_id, collection_id, status, requested_by, requested_at, request_note, requested_hash)
  VALUES (p_edition_id, v_collection, 'pending', auth.uid(), now(),
          NULLIF(btrim(COALESCE(p_note, '')), ''), public.newsletters_edition_content_hash(p_edition_id))
  RETURNING id INTO v_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', ca.user_id, 'email', ap.email,
           'name', COALESCE(NULLIF(btrim(ap.name), ''), ap.email))), '[]'::jsonb)
    INTO v_to
    FROM public.newsletters_collection_approvers ca
    JOIN public.admin_profiles ap ON ap.user_id = ca.user_id AND ap.is_active
   WHERE ca.collection_id = v_collection;
  RETURN jsonb_build_object('approval_id', v_id, 'approvers', v_to);
END $$;

-- ---------------------------------------------------------------------------
-- Decide (an approver): 'approved' or 'changes_requested'.
-- p_expected_version is the edition version the approver reviewed; if the
-- edition changed since, the decision is refused so nobody approves content
-- they have not seen. Returns who to notify.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_decide_edition_approval(
  p_edition_id uuid, p_decision text, p_expected_version integer, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_me uuid := auth.uid();
  v_collection uuid;
  v_version integer;
  v_super boolean := public.is_super_admin();
  v_pending record;
  v_id uuid;
  v_hash text;
  v_notify jsonb;
BEGIN
  IF p_decision NOT IN ('approved', 'changes_requested') THEN
    RAISE EXCEPTION 'decision must be approved or changes_requested' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_me IS NULL OR NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = '42501';
  END IF;
  SELECT collection_id, version INTO v_collection, v_version
    FROM public.newsletters_editions WHERE id = p_edition_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'edition not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.newsletters_collection_approvers
                  WHERE collection_id = v_collection AND user_id = v_me) THEN
    RAISE EXCEPTION 'you are not an approver for this newsletter' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> v_version THEN
    RAISE EXCEPTION 'the edition changed since you opened it; reload and review it again'
      USING ERRCODE = '55006';
  END IF;

  SELECT * INTO v_pending FROM public.newsletters_edition_approvals
   WHERE edition_id = p_edition_id AND status = 'pending'
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF v_pending.id IS NULL THEN
    IF NOT v_super THEN
      RAISE EXCEPTION 'there is no approval request for this edition yet' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF v_pending.requested_by = v_me AND NOT v_super AND p_decision = 'approved' THEN
    RAISE EXCEPTION 'only a super admin can approve their own request' USING ERRCODE = '42501';
  END IF;

  v_hash := public.newsletters_edition_content_hash(p_edition_id);
  IF v_pending.id IS NULL THEN
    UPDATE public.newsletters_edition_approvals SET status = 'superseded'
     WHERE edition_id = p_edition_id AND status IN ('approved', 'changes_requested');
    INSERT INTO public.newsletters_edition_approvals
      (edition_id, collection_id, status, requested_by, requested_at, requested_hash,
       decided_by, decided_at, decision_note, decided_hash)
    VALUES (p_edition_id, v_collection, p_decision, v_me, now(), v_hash,
            v_me, now(), NULLIF(btrim(COALESCE(p_note, '')), ''), v_hash)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.newsletters_edition_approvals
       SET status = p_decision, decided_by = v_me, decided_at = now(),
           decision_note = NULLIF(btrim(COALESCE(p_note, '')), ''), decided_hash = v_hash
     WHERE id = v_pending.id
    RETURNING id INTO v_id;
  END IF;

  SELECT jsonb_build_object('user_id', ap.user_id, 'email', ap.email, 'name', COALESCE(NULLIF(btrim(ap.name), ''), ap.email))
    INTO v_notify
    FROM public.admin_profiles ap
   WHERE ap.user_id = v_pending.requested_by AND ap.is_active AND ap.user_id <> v_me;
  RETURN jsonb_build_object('approval_id', v_id, 'status', p_decision, 'notify', v_notify);
END $$;

-- ---------------------------------------------------------------------------
-- Guards: approval cannot be dodged by moving an edition out of a publication
-- that has approvers, or by deleting that publication. Super admins and the
-- service role (auth.uid() is null) may still do both.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.newsletters_edition_approval_move_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.collection_id IS DISTINCT FROM OLD.collection_id
     AND auth.uid() IS NOT NULL AND NOT public.is_super_admin()
     AND EXISTS (SELECT 1 FROM public.newsletters_collection_approvers WHERE collection_id = OLD.collection_id) THEN
    RAISE EXCEPTION 'this newsletter needs approval, so only a super admin can move its editions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS newsletters_edition_approval_move_guard ON public.newsletters_editions;
CREATE TRIGGER newsletters_edition_approval_move_guard BEFORE UPDATE OF collection_id ON public.newsletters_editions
  FOR EACH ROW EXECUTE FUNCTION public.newsletters_edition_approval_move_guard();

CREATE OR REPLACE FUNCTION public.newsletters_collection_approval_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_super_admin()
     AND EXISTS (SELECT 1 FROM public.newsletters_collection_approvers WHERE collection_id = OLD.id) THEN
    RAISE EXCEPTION 'this newsletter has approvers, so only a super admin can delete it' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS newsletters_collection_approval_delete_guard ON public.newsletters_template_collections;
CREATE TRIGGER newsletters_collection_approval_delete_guard BEFORE DELETE ON public.newsletters_template_collections
  FOR EACH ROW EXECUTE FUNCTION public.newsletters_collection_approval_delete_guard();

REVOKE ALL ON FUNCTION public.newsletters_edition_content_hash(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_approval_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_set_collection_approvers(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_collection_approver_options(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_edition_approval_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_request_edition_approval(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_decide_edition_approval(uuid, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.newsletters_send_gate(uuid) FROM PUBLIC;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.newsletters_edition_content_hash(uuid) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.newsletters_approval_gate(uuid) FROM anon, authenticated;
  REVOKE ALL ON FUNCTION public.newsletters_send_gate(uuid) FROM anon;
  GRANT EXECUTE ON FUNCTION public.newsletters_edition_content_hash(uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_approval_gate(uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_send_gate(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_set_collection_approvers(uuid, uuid[]) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_collection_approver_options(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_edition_approval_status(uuid) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_request_edition_approval(uuid, text) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.newsletters_decide_edition_approval(uuid, text, integer, text) TO authenticated, service_role;
EXCEPTION WHEN undefined_object THEN NULL; END $$;
