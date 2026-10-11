import {it,expect,vi} from 'vitest';
const state=vi.hoisted(()=>({repos:[],saved:null,inserts:[]}));
vi.mock('../credentials.js',()=>({getCodeRepos:async()=>state.repos}));
import {getRunCodeRepos} from '../run-code-repos.js';
const sb={from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:state.saved,error:null}),insert:async v=>{state.inserts.push(v);return {error:null};}};return q;}};
it('pins preview source and reuses it after deployment advances while preserving main PR targets',async()=>{
 const first='staging/helf-preview/'+'a'.repeat(40),next='staging/helf-preview/'+'b'.repeat(40);
 state.repos=[{repoOwner:'danthebaker',repoName:'gatewaze-modules',baseBranch:'main',checkoutRef:first},{repoOwner:'gatewaze',repoName:'gatewaze-modules',baseBranch:'main'}];state.saved=null;state.inserts=[];
 let repos=await getRunCodeRepos(sb,{repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run',site_id:'site',project_id:'project'});expect(repos[0].baseBranch).toBe('main');expect(repos[0].checkoutRef).toBe(first);
 state.saved=state.inserts[0];state.repos[0].checkoutRef=next;
 repos=await getRunCodeRepos(sb,{repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run',site_id:'site',project_id:'project'});expect(repos[0].checkoutRef).toBe(first);expect(repos[1].checkoutRef).toBeUndefined();expect(state.inserts).toHaveLength(1);
});
it('fails closed on malformed saved source',async()=>{state.saved={content:'[]bad'};await expect(getRunCodeRepos(sb,{repo_owner:'danthebaker',repo_name:'gatewaze-roadmap',id:'run'})).rejects.toThrow('Invalid pinned');});
