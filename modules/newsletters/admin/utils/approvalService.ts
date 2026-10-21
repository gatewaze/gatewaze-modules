/**
 * Admin clients for edition approval (api/approval-routes.ts + the migration
 * 096 functions) and for filling an edition from a Google Doc
 * (api/gdoc-fill-routes.ts).
 */

import { supabase } from '@/lib/supabase';
import { jfetch } from './researchService';
import type { GdocProposal } from '../lib/gdoc-merge';

const enc = encodeURIComponent;

export interface ApprovalPerson { user_id: string; email: string | null; name: string | null }

export interface ApprovalLatest {
  id: string;
  status: 'pending' | 'approved' | 'changes_requested';
  requested_by: string | null;
  requested_by_email: string | null;
  requested_at: string | null;
  request_note: string | null;
  decided_by: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** Approved: content differs from what was approved. Pending: from what was submitted. */
  content_changed_since: boolean;
}

export interface ApprovalStatus {
  required: boolean;
  approvers: ApprovalPerson[];
  latest: ApprovalLatest | null;
  gate: { allowed: boolean; reason_code: string };
  is_approver: boolean;
  is_super_admin: boolean;
  me: string | null;
}

export interface ApproverOption { user_id: string; email: string; name: string; role: string; is_approver: boolean }

function origin(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export const approvalService = {
  async status(editionId: string): Promise<ApprovalStatus | null> {
    const { data, error } = await supabase.rpc('newsletters_edition_approval_status', { p_edition_id: editionId });
    if (error) {
      // Pre-migration database: no approval feature, nothing to show.
      if (error.code === 'PGRST202' || /does not exist/i.test(error.message)) return null;
      throw error;
    }
    return data as ApprovalStatus;
  },
  request: (editionId: string, note: string | null) =>
    jfetch<{ approval_id: string; notified: string[]; failed: string[]; local_only?: boolean; email_skipped?: string }>(`/api/admin/newsletters/editions/${enc(editionId)}/approval/request`, {
      method: 'POST',
      body: JSON.stringify({ note, admin_origin: origin() }),
    }),
  decide: (editionId: string, decision: 'approved' | 'changes_requested', expectedVersion: number, note: string | null) =>
    jfetch<{ approval_id: string; status: string; notified: string | null }>(`/api/admin/newsletters/editions/${enc(editionId)}/approval/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, expected_version: expectedVersion, note, admin_origin: origin() }),
    }),
  async approverOptions(collectionId: string): Promise<ApproverOption[]> {
    const { data, error } = await supabase.rpc('newsletters_collection_approver_options', { p_collection_id: collectionId });
    if (error) throw error;
    return (data as ApproverOption[]) ?? [];
  },
  async setApprovers(collectionId: string, userIds: string[]): Promise<number> {
    const { data, error } = await supabase.rpc('newsletters_set_collection_approvers', { p_collection_id: collectionId, p_user_ids: userIds });
    if (error) throw error;
    return (data as number) ?? 0;
  },
};

export interface GdocFillJob {
  id: string;
  status: 'running' | 'complete' | 'failed';
  proposal: GdocProposal | null;
  error_code: string | null;
  error: string | null;
}

export const gdocFillService = {
  start: (editionId: string, input: { google_doc_url: string } | { html: string }) =>
    jfetch<{ job_id: string }>(`/api/admin/newsletters/editions/${enc(editionId)}/gdoc-fill`, { method: 'POST', body: JSON.stringify(input) }),
  job: (jobId: string) => jfetch<GdocFillJob>(`/api/admin/newsletters/gdoc-fill/jobs/${enc(jobId)}`),
};
