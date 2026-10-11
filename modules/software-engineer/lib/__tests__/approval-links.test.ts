// @ts-nocheck
import {beforeEach,describe,it,expect,vi} from 'vitest';
const f=vi.hoisted(()=>({run:{},role:'admin',active:true,approvers:[],head:'a'.repeat(40),merge:vi.fn()}));
vi.mock('../credentials.js',()=>({getProject:async()=>({githubToken:'test',intakeEnabled:true}),getCodeRepos:async()=>[]}));
vi.mock('../github.js',()=>({githubClient:()=>({getPullRequest:async()=>({state:'open',head:{sha:f.head},mergeable_state:'clean',title:'A change',body:''})})}));
vi.mock('../merge-prs.js',()=>({mergeRunPrs:f.merge}));
vi.mock('../decisions.js',()=>({approveArchitecture:vi.fn()}));
import {mintApprovalLink,reviewApproval,applyApproval,tokenKey} from '../approval-links.js';
const origin='https://staging-admin.aaif.live';
function fixtures(){
 const records=new Map();
 const redis={get:async k=>records.get(k)||null,set:async(k,v)=>{records.set(k,v);return 'OK'},eval:async(_s,_n,k,v)=>{if(records.get(k)!==v)return 0;records.delete(k);return 1}};
 const sb={from:table=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,insert:()=>q,maybeSingle:async()=>({data:table==='se_runs'?{...f.run}:table==='admin_profiles'?(f.active?{role:f.role}:null):table==='se_projects'?{approvers:f.approvers}:null}),then:(yes,no)=>Promise.resolve({data:table==='se_run_prs'?[{repo_owner:'private',repo_name:'modules',pr_number:1,state:'open'}]:[]}).then(yes,no)};return q;}};
 return {sb,redis,records};
}
beforeEach(()=>{f.run={id:'run',site_id:'site',project_id:'project',status:'watching',current_phase:'pr',title:'HELF change',issue_number:70};f.role='admin';f.active=true;f.approvers=[];f.head='a'.repeat(40);f.merge.mockReset().mockResolvedValue({merged:1,held:0});});
describe('single-use approval capabilities',()=>{
 it('uses URL fragment and read-only review does not consume the grant',async()=>{const {sb,redis,records}=fixtures();const url=await mintApprovalLink(sb,redis,'run','actor',origin);expect(url).toMatch(/\/approval#[\w-]{43}$/);const token=new URL(url).hash.slice(1);await reviewApproval(sb,redis,token,origin);expect(records.has(tokenKey(token))).toBe(true);expect(f.merge).not.toHaveBeenCalled();});
 it('rejects invalid tokens, foreign origins, stale heads and expired grants',async()=>{const {sb,redis,records}=fixtures();const token=new URL(await mintApprovalLink(sb,redis,'run','actor',origin)).hash.slice(1);await expect(reviewApproval(sb,redis,'wrong',origin)).rejects.toThrow();await expect(reviewApproval(sb,redis,token,'https://evil.example')).rejects.toThrow();f.head='b'.repeat(40);await expect(reviewApproval(sb,redis,token,origin)).rejects.toThrow('stale');f.head='a'.repeat(40);const grant=JSON.parse(records.get(tokenKey(token)));grant.expires=0;records.set(tokenKey(token),JSON.stringify(grant));await expect(reviewApproval(sb,redis,token,origin)).rejects.toThrow();});
 it('rechecks admin and project approver rights',async()=>{const {sb,redis}=fixtures();const token=new URL(await mintApprovalLink(sb,redis,'run','actor',origin)).hash.slice(1);f.active=false;await expect(reviewApproval(sb,redis,token,origin)).rejects.toThrow();f.active=true;f.approvers=['different'];await expect(reviewApproval(sb,redis,token,origin)).rejects.toThrow();});
 it('requires review nonce and consumes exactly once under concurrent approvals',async()=>{const {sb,redis}=fixtures();const token=new URL(await mintApprovalLink(sb,redis,'run','actor',origin)).hash.slice(1);const {grant}=await reviewApproval(sb,redis,token,origin);await expect(applyApproval(sb,redis,token,origin,'wrong',vi.fn())).rejects.toThrow();const results=await Promise.allSettled([applyApproval(sb,redis,token,origin,grant.nonce,vi.fn()),applyApproval(sb,redis,token,origin,grant.nonce,vi.fn())]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(f.merge).toHaveBeenCalledTimes(1);expect(f.merge.mock.calls[0][3].expectedHeads).toEqual({'private/modules#1':'a'.repeat(40)});await expect(reviewApproval(sb,redis,token,origin)).rejects.toThrow();});
 it('refuses non-approval states and disabled approvers at mint',async()=>{const {sb,redis}=fixtures();f.run.status='running';await expect(mintApprovalLink(sb,redis,'run','actor',origin)).rejects.toThrow();f.run.status='watching';f.role='viewer';await expect(mintApprovalLink(sb,redis,'run','actor',origin)).rejects.toThrow();});
});
