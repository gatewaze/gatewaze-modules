/**
 * Reconciliation targets (§12.3) — the in-scope tables the daily source-side
 * count snapshot covers, with the soft-delete + change-detection columns the
 * count RPC needs. MIRRORS manifest/appendix-a.yaml; `pnpm generate:sql`
 * re-emits this file, so edit the manifest, not this list, then regenerate.
 */
export interface ReconcileTarget {
  schema: string;
  table: string;
  /** Soft-delete column, or null for hard-delete tables (§7.2.1). */
  deletedCol: string | null;
  /** Change-detection column for the freshness anchor (§12.3). */
  updatedCol: string | null;
}

export const RECONCILE_TARGETS: ReconcileTarget[] = [
  { schema: 'public', table: 'people', deletedCol: 'deleted_at', updatedCol: 'updated_at' },
  { schema: 'public', table: 'person_emails', deletedCol: 'deleted_at', updatedCol: 'updated_at' },
  { schema: 'public', table: 'people_events', deletedCol: null, updatedCol: 'created_at' },
  { schema: 'public', table: 'events', deletedCol: 'deleted_at', updatedCol: 'updated_at' },
  { schema: 'public', table: 'event_registrations', deletedCol: 'deleted_at', updatedCol: 'updated_at' },
  { schema: 'public', table: 'send_log', deletedCol: null, updatedCol: 'updated_at' },
  { schema: 'public', table: 'email_interactions', deletedCol: null, updatedCol: 'created_at' },
  { schema: 'public', table: 'newsletter_sends', deletedCol: 'deleted_at', updatedCol: 'updated_at' },
];
