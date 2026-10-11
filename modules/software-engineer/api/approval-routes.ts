// @ts-nocheck
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { reviewApproval, applyApproval } from '../lib/approval-links.js';
import { rateLimit, clientIp } from '../lib/rate-limit.js';
const script = `
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const heading=document.querySelector('h1'),detail=document.querySelector('pre'),button=document.querySelector('button'),note=document.querySelector('#note');
const post=async(path,body)=>{const r=await fetch(location.pathname+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',cache:'no-store'});const data=await r.json();if(!r.ok)throw new Error(data.error||'Unable to review this approval');return data;};
let nonce;
(async()=>{try{const data=await post('/review',{token});heading.textContent=data.title;detail.textContent=data.detail;button.textContent=data.action;nonce=data.nonce;note.textContent='This link authorizes only this task and expires '+new Date(data.expires).toLocaleString()+'. Anyone holding the link can approve this step. GitHub checks remain enforced.';button.disabled=false;}catch(e){note.textContent=e.message;}})();
button.addEventListener('click',async()=>{button.disabled=true;try{const data=await post('/approve',{token,nonce});note.textContent=data.message;button.hidden=true;}catch(e){note.textContent=e.message+' This link may already have been used; check the task before retrying.';}});
`;
const hash=createHash('sha256').update(script).digest('base64');
export const page=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review Software Engineer approval</title><style>body{max-width:780px;margin:32px auto;padding:0 20px;font:17px system-ui;line-height:1.5;color:#202733;background:#f6f8fa}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px system-ui;background:white;padding:20px;border-radius:12px}button{padding:14px 24px;font:600 17px system-ui;background:#155b43;color:white;border:0;border-radius:8px}#note{margin:20px 0}</style></head><body><h1>Review approval</h1><p id="note">Opening secure review…</p><pre></pre><button disabled>Approve</button><script>${script}</script></body></html>`;
export function mountApprovalRoutes(router,{supabase,getRedis,enqueueJob}) {
  let fallbackRedis;
  const redis=async()=>{
    const provided=await getRedis?.();if(provided)return provided;
    if(!process.env.REDIS_URL)throw new Error('Approval storage unavailable');
    // Older module hosts omit getRedisConnection. Resolve their existing queue dependency.
    if(!fallbackRedis){const Redis=createRequire(join(process.cwd(),'package.json'))('ioredis');fallbackRedis=new Redis(process.env.REDIS_URL,{maxRetriesPerRequest:1,connectTimeout:3000,commandTimeout:5000});fallbackRedis.on('error',()=>{});}
    return fallbackRedis;
  };
  const protect=(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':`default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`});
    if(!rateLimit(`se-cap:${clientIp(req)}`,40,60000)){res.status(429).json({error:'Too many requests. Try later.'});return false;}return true;
  };
  router.get('/approval',(req,res)=>{if(protect(req,res))res.type('html').send(page);});
  router.post('/approval/review',async(req,res)=>{
    if(!protect(req,res))return;
    try{
      if(!req.is('application/json'))throw new Error('JSON review required');
      const {grant,s}=await reviewApproval(supabase,await redis(),req.body?.token,req.get('Origin'));
      res.json({title:`${s.action}: ${s.run.title||'issue #'+s.run.issue_number}`,detail:s.detail,action:s.action,nonce:grant.nonce,expires:grant.expires});
    }catch(error){console.warn('[se-approval] review refused',error?.name, ['JSON review required','Invalid or expired approval link','Invalid, used or expired approval link','Approval access expired','Task changed; this approval link is stale','Approval storage unavailable'].includes(error?.message)?error.message:'storage or lookup unavailable');res.status(410).json({error:'This link is invalid, expired, already used, or the task has changed. Open a fresh approval link.'});}
  });
  router.post('/approval/approve',async(req,res)=>{
    if(!protect(req,res))return;
    try{
      if(!req.is('application/json')||typeof req.body?.nonce!=='string'||req.body.nonce.length!==22)throw new Error('Review required');
      const message=await applyApproval(supabase,await redis(),req.body?.token,req.get('Origin'),req.body.nonce,enqueueJob);res.json({message});
    }catch{res.status(409).json({error:'Approval could not complete. The link may be stale or used; check the task before requesting another.'});}
  });
}
