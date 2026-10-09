// @ts-nocheck
import {it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>({review:vi.fn(async()=>({grant:{nonce:'n'.repeat(22),expires:Date.now()+1000},s:{action:'Approve',run:{title:'<script>bad</script>'},detail:'<img onerror=bad>'}}))}));
vi.mock('../approval-links.js',()=>({reviewApproval:calls.review,applyApproval:vi.fn()}));
vi.mock('../rate-limit.js',()=>({rateLimit:()=>true,clientIp:()=> 'test'}));
import {mountApprovalRoutes,page} from '../../api/approval-routes.js';
it('awaits asynchronous legacy Redis context and renders data via textContent',async()=>{
 const routes={};const redis={get:vi.fn()};const router={get:(p,f)=>routes['GET '+p]=f,post:(p,f)=>routes['POST '+p]=f};
 mountApprovalRoutes(router,{supabase:{},getRedis:async()=>redis,enqueueJob:vi.fn()});
 let data;const res={set:vi.fn(),status:()=>res,json:x=>data=x};
 await routes['POST /approval/review']({is:()=>true,body:{token:'t'.repeat(43)},get:()=> 'https://staging-admin.aaif.live'},res);
 expect(calls.review.mock.calls[0][1]).toBe(redis);expect(data.nonce).toHaveLength(22);
 expect(page).toContain('textContent=data.detail');expect(page).not.toContain('innerHTML');expect(page).toContain("history.replaceState(null,'',location.pathname)");
});
it('public landing page has no approval mutation',()=>{
 const routes={};const router={get:(p,f)=>routes[p]=f,post:vi.fn()};mountApprovalRoutes(router,{supabase:{},getRedis:vi.fn()});
 const res={set:vi.fn(),type:()=>res,send:vi.fn()};routes['/approval']({},res);
 expect(res.send).toHaveBeenCalledWith(page);expect(res.set).toHaveBeenCalledWith(expect.objectContaining({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}));
});
