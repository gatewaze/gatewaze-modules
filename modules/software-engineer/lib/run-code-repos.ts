// @ts-nocheck
/** Pin optional HELF preview checkouts per run; PR targets and other repos retain main. */
import { getCodeRepos } from './credentials.js';
function previewRepo(owner,name) { return (owner==='danthebaker'&&name==='gatewaze-modules')||(owner==='gatewaze'&&name==='gatewaze'); }
function validPin(p) { return p.owner==='danthebaker'&&p.name==='gatewaze-modules'&&/^staging\/helf-preview\/[0-9a-f]{40}$/.test(p.ref) || p.owner==='gatewaze'&&p.name==='gatewaze'&&/^staging\/helf-app-shell\/[0-9a-f]{40}$/.test(p.ref); }
export async function getRunCodeRepos(sb,run) {
  const repos=await getCodeRepos(sb,run.project_id);
  if(run.repo_owner!=='danthebaker'||run.repo_name!=='gatewaze-roadmap'||!/^HELF:/i.test(run.title??''))return repos.map(r=>previewRepo(r.repoOwner,r.repoName)?{...r,checkoutRef:undefined}:r);
  const {data:saved,error}=await sb.from('se_artifacts').select('content').eq('run_id',run.id).eq('kind','workspace_base').order('created_at',{ascending:true}).limit(1).maybeSingle();
  if(error)throw new Error('Could not load pinned workspace source');
  let pins;
  if(saved){
    try{pins=JSON.parse(saved.content);}catch{throw new Error('Invalid pinned workspace source');}
    if(!Array.isArray(pins)||pins.some(p=>!validPin(p)))throw new Error('Invalid pinned workspace source');
  }else{
    pins=repos.filter(r=>previewRepo(r.repoOwner,r.repoName)&&r.checkoutRef).map(r=>({owner:r.repoOwner,name:r.repoName,ref:r.checkoutRef}));
    {const {error:writeError}=await sb.from('se_artifacts').insert({run_id:run.id,site_id:run.site_id,phase:'spec',kind:'workspace_base',content:JSON.stringify(pins)});if(writeError)throw new Error('Could not pin workspace source');}
  }
  return repos.map(r=>{const p=pins.find(p=>p.owner===r.repoOwner&&p.name===r.repoName);return p?{...r,checkoutRef:p.ref}:previewRepo(r.repoOwner,r.repoName)?{...r,checkoutRef:undefined}:r;});
}
