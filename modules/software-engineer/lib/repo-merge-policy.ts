/** Repository overrides never grant authority over another repository in the same run. */
export type RepoMergePolicy = 'inherit' | 'manual' | 'auto_merge_verified';
export function canAutoMergeRepo(repo: any, project: any, run: any): boolean {
  if (!repo || !repo.enabled || repo.writeMode !== 'writable' || run.kind === 'external_pr') return false;
  if (repo.mergePolicy === 'manual') return false;
  if (repo.mergePolicy === 'auto_merge_verified') return true;
  return (!repo.mergePolicy || repo.mergePolicy === 'inherit') && project.autonomyMode === 'auto_merge_safe' && run.blast_radius === 'safe';
}
export function validRepoMergePolicy(value: unknown): boolean {
  return ['inherit', 'manual', 'auto_merge_verified'].includes(value as string);
}

export function canRepairRepo(repo: any, run: any): boolean {
  return !!repo?.enabled && repo.writeMode === 'writable' && run.kind !== 'external_pr';
}
export function actionableReview(review: any): boolean {
  return ['CHANGES_REQUESTED','COMMENTED'].includes(review.state) && !!review.body?.trim();
}
