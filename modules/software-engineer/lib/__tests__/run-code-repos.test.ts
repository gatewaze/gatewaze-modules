import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({repos:[],saved:null,inserts:[]}));
vi.mock('../credentials.js',()=>({getCodeRepos:async()=>state.repos}));
import {getRunCodeRepos} from '../run-code-repos.js';
const sb={from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:state.saved,error:null}),insert:async v=>{state.inserts.push(v);return {error:null};}};return q;}};
it('pins preview source and reuses it after deployment advances while preserving main PR targets',async()=>{
 const first='staging/helf-preview/'+'a'.repeat(40),next='staging/helf-preview/'+'b'.repeat(40);
 state.repos=[{repoOwner:'danthebaker',repoName:'gatewaze-modules',baseBranch:'main',checkoutRef:first},{repoOwner:'gatewaze',repoName:'gatewaze-modules',baseBranch:'main'}];state.saved=null;state.inserts=[];
 let repos=await getRunCodeRepos(sb,{title:'HELF: test feedback',repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run',site_id:'site',project_id:'project'});expect(repos[0].baseBranch).toBe('main');expect(repos[0].checkoutRef).toBe(first);
 state.saved=state.inserts[0];state.repos[0].checkoutRef=next;
 repos=await getRunCodeRepos(sb,{title:'HELF: test feedback',repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run',site_id:'site',project_id:'project'});expect(repos[0].checkoutRef).toBe(first);expect(repos[1].checkoutRef).toBeUndefined();expect(state.inserts).toHaveLength(1);
});
it('fails closed on malformed saved source',async()=>{state.saved={content:'[]bad'};await expect(getRunCodeRepos(sb,{title:'HELF: test feedback',repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run'})).rejects.toThrow('Invalid pinned');});

it('pins both health and app-shell sources and keeps older single-repo runs on their original platform source',async()=>{
 const privateRef='staging/helf-preview/'+'a'.repeat(40),publicRef='staging/helf-app-shell/'+'b'.repeat(40);
 state.repos=[{repoOwner:'danthebaker',repoName:'gatewaze-modules',baseBranch:'main',checkoutRef:privateRef},{repoOwner:'gatewaze',repoName:'gatewaze',baseBranch:'main',checkoutRef:publicRef}];state.saved=null;state.inserts=[];
 const run={title:'HELF: test feedback',repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run',site_id:'site',project_id:'project'};
 await getRunCodeRepos(sb,run);expect(JSON.parse(state.inserts[0].content)).toHaveLength(2);
 state.saved={content:JSON.stringify([{owner:'danthebaker',name:'gatewaze-modules',ref:privateRef}])};
 const repos=await getRunCodeRepos(sb,run);expect(repos[1].checkoutRef).toBeUndefined();expect(repos[1].baseBranch).toBe('main');
});

it('uses normal main for non-health roadmap issues',async()=>{
 state.saved=null;state.inserts=[];state.repos=[{repoOwner:'gatewaze',repoName:'gatewaze',baseBranch:'main',checkoutRef:'staging/helf-app-shell/'+'a'.repeat(40)}];
 const repos=await getRunCodeRepos(sb,{title:'Improve SE dashboard',repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run'});
 expect(repos[0].checkoutRef).toBeUndefined();expect(state.inserts).toHaveLength(0);
});
