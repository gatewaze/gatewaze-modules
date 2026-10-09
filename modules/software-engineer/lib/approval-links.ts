// @ts-nocheck
import { createHash, randomBytes } from 'node:crypto';
import { getProject, getCodeRepos } from './credentials.js';
import { githubClient } from './github.js';
import { enqueuePhase } from './enqueue.js';
import { mergeRunPrs } from './merge-prs.js';
import { approveArchitecture } from './decisions.js';
const ROLES = new Set(['super_admin','admin','editor']);
const ACTIONS = {awaiting_spec:'Approve specification',architecture_in_review:'Approve architecture',ready_to_submit:'Submit pull request',watching:'Approve merge',pr_open:'Approve merge'};
export const tokenKey = token => `se:approval:${process.env.BRAND||'default'}:${createHash('sha256').update(token).digest('hex')}`;
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function authorized(sb, actorId, projectId) {
  const {data:admin,error:a}=await sb.from('admin_profiles').select('role').eq('user_id',actorId).eq('is_active',true).maybeSingle();
  const {data:project,error:p}=await sb.from('se_projects').select('approvers').eq('id',projectId).maybeSingle();
  return !a&&!p&&!!project&&ROLES.has(admin?.role)&&(!project.approvers?.length||project.approvers.includes(actorId));
}
export async function snapshot(sb, runId) {
  const {data:run,error}=await sb.from('se_runs').select('id,site_id,project_id,status,current_phase,kind,branch_name,title,issue_number,repo_owner,repo_name,archived_at').eq('id',runId).maybeSingle();
  if(error||!run||run.archived_at||!ACTIONS[run.status]) throw new Error('Approval is no longer available');
  const project=await getProject(sb,run.project_id);
  if(!project?.intakeEnabled||!project.githubToken) throw new Error('Project is unavailable');
  const gh=githubClient(project.githubToken);let detail='',artifact=null,heads=[];
  if(['watching','pr_open'].includes(run.status)) {
    const {data:prs,error:p}=await sb.from('se_run_prs').select('repo_owner,repo_name,pr_number,state').eq('run_id',run.id).eq('state','open').order('repo_owner').order('repo_name');
    if(p||!prs?.length) throw new Error('No open pull requests');
    for(const p of prs) {
      const info=await gh.getPullRequest(p.repo_owner,p.repo_name,p.pr_number);
      if(info.state!=='open'||info.merged||!/^[0-9a-f]{40}$/i.test(info.head?.sha||'')) throw new Error('Pull request changed');
      heads.push({owner:p.repo_owner,name:p.repo_name,number:p.pr_number,sha:info.head.sha});
      detail+=`${p.repo_owner}/${p.repo_name} #${p.pr_number}\n${info.title}\nChecks/merge state: ${info.mergeable_state||'pending'}\n${(info.body||'').slice(0,6000)}\n\n`;
    }
  } else {
    const kind=run.status==='architecture_in_review'?'architecture':'spec';
    const {data:art,error:a}=await sb.from('se_artifacts').select('id,content').eq('run_id',run.id).eq('kind',kind).order('created_at',{ascending:false}).limit(1).maybeSingle();
    if(a||!art?.content) throw new Error('Review artifact unavailable');
    artifact=digest([art.id,art.content]);detail=art.content.slice(0,20000);
    if(run.status==='ready_to_submit') for(const r of await getCodeRepos(sb,run.project_id)) {
      if(r.writeMode==='writable') heads.push({owner:r.repoOwner,name:r.repoName,sha:await gh.getBranchHeadSha(r.repoOwner,r.repoName,run.branch_name)});
    }
  }
  const revision=digest({status:run.status,phase:run.current_phase,artifact,heads});
  return {run,project,revision,heads,action:ACTIONS[run.status],detail};
}
export async function mintApprovalLink(sb, redis, runId, actorId, origin) {
  const u=new URL(origin);
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/') throw new Error('Invalid approval origin');
  const s=await snapshot(sb,runId);
  if(!await authorized(sb,actorId,s.run.project_id)) throw new Error('Approver is unavailable');
  const token=randomBytes(32).toString('base64url'),nonce=randomBytes(16).toString('base64url');
  const expires=Date.now()+24*60*60*1000;
  await redis.set(tokenKey(token),JSON.stringify({runId,actorId,projectId:s.run.project_id,revision:s.revision,nonce,origin:u.origin,expires}),'EX',86400,'NX');
  return `${u.origin}/api/modules/software-engineer/internal/approval#${token}`;
}
export async function reviewApproval(sb, redis, token, origin) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(token||'')) throw new Error('Invalid or expired approval link');
  const raw=await redis.get(tokenKey(token));if(!raw)throw new Error('Invalid, used or expired approval link');
  const grant=JSON.parse(raw);
  if(grant.expires<Date.now()||origin!==grant.origin||!await authorized(sb,grant.actorId,grant.projectId)) throw new Error('Approval access expired');
  const s=await snapshot(sb,grant.runId);
  if(s.run.project_id!==grant.projectId||s.revision!==grant.revision) throw new Error('Task changed; this approval link is stale');
  return {grant,s,raw};
}
export async function consume(redis,token,raw) {
  return Number(await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]);return 1 else return 0 end",1,tokenKey(token),raw))===1;
}
export async function applyApproval(sb,redis,token,origin,nonce,enqueueJob) {
  const {grant,s,raw}=await reviewApproval(sb,redis,token,origin);
  if(nonce!==grant.nonce)throw new Error('Review the task before approving');
  if(!await consume(redis,token,raw))throw new Error('Approval link has already been used');
  const run=s.run;
  if(['watching','pr_open'].includes(run.status)) {
    const expectedHeads=Object.fromEntries(s.heads.map(p=>[`${p.owner}/${p.name}#${p.number}`,p.sha]));
    const result=await mergeRunPrs(sb,run,s.project,{expectedHeads});
    await sb.from('se_messages').insert({run_id:run.id,site_id:run.site_id,role:'system',author:grant.actorId,content:`Merge approved through single-use Pushover link: ${result.merged} merged, ${result.held} held by GitHub checks.`});
    if(result.merged) await enqueueJob?.('se','software-engineer:pr-monitor',{runId:run.id});
    return `${result.merged} pull request(s) merged; ${result.held} held by checks or protection. This link is now used.`;
  }
  if(run.status==='architecture_in_review') {
    const result=await approveArchitecture(sb,null,run,{actorId:grant.actorId,enqueueJob,note:'Architecture approved through single-use Pushover link.'});
    if(result.error)throw new Error('Task changed before approval');
    return 'Architecture approved. Implementation will resume.';
  }
  const phase=run.status==='ready_to_submit'?'pr':s.project.architectureRepo&&run.kind!=='external_pr'?'architecture':'implement';
  const {data,error}=await sb.from('se_runs').update({status:'running',current_phase:phase,acting_user_id:grant.actorId}).eq('id',run.id).eq('status',run.status).select('id');
  if(error||!data?.length)throw new Error('Task changed before approval');
  await enqueuePhase({enqueueJob},run.id,phase,run.status==='ready_to_submit'?{submitApproved:true}:{});
  await sb.from('se_messages').insert({run_id:run.id,site_id:run.site_id,role:'system',author:grant.actorId,content:`${s.action} confirmed through single-use Pushover link; proceeding to ${phase}.`});
  return 'Approved. Software Engineer will continue.';
}
