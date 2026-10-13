import {it,expect} from 'vitest';
import {canAutoMergeRepo,canRepairRepo,actionableReview} from '../repo-merge-policy.js';
const repo={enabled:true,writeMode:'writable'}, project={autonomyMode:'auto_merge_safe'},run={blast_radius:'safe'};
it('manual override wins over automatic project',()=>expect(canAutoMergeRepo({...repo,mergePolicy:'manual'},project,run)).toBe(false));
it('verified override permits needs-human blast radius but not external or read-only sources',()=>{expect(canAutoMergeRepo({...repo,mergePolicy:'auto_merge_verified'},{autonomyMode:'pr_only'},{blast_radius:'needs_human'})).toBe(true);expect(canAutoMergeRepo({...repo,mergePolicy:'auto_merge_verified'},project,{...run,kind:'external_pr'})).toBe(false);expect(canAutoMergeRepo({...repo,writeMode:'read_only',mergePolicy:'auto_merge_verified'},project,run)).toBe(false);});
it('inherit preserves safe-only project behavior and unknown policy fails closed',()=>{expect(canAutoMergeRepo(repo,project,run)).toBe(true);expect(canAutoMergeRepo(repo,project,{blast_radius:'needs_human'})).toBe(false);expect(canAutoMergeRepo({...repo,mergePolicy:'bad'},project,run)).toBe(false);});

it('repairs writable human-merge repositories without granting merge authority',()=>{const core={...repo,mergePolicy:'manual'};expect(canRepairRepo(core,run)).toBe(true);expect(canAutoMergeRepo(core,project,run)).toBe(false);expect(canRepairRepo(core,{kind:'external_pr'})).toBe(false);});
it('picks up concrete commented reviews, ignores approvals and empty comments',()=>{expect(actionableReview({state:'COMMENTED',body:'Fix the null guard'})).toBe(true);expect(actionableReview({state:'APPROVED',body:'Looks good'})).toBe(false);expect(actionableReview({state:'COMMENTED',body:'  '})).toBe(false);});
