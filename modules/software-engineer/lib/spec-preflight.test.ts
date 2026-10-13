import { describe,it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSpecPreflight } from './spec-preflight.js';
describe('spec preflight',()=>{
 it('requires inspected source and verified canonical issues',()=>{
  const root=mkdtempSync(join(tmpdir(),'preflight-'));
  try{
   writeFileSync(join(root,'code.ts'),'export const feature=true');
   const evidence={verdict:'regression',reason:'Existing code does not handle the reported missing state.',files:['code.ts']};
   expect(validateSpecPreflight(evidence,root,[],2).verdict).toBe('regression');
   expect(()=>validateSpecPreflight({...evidence,files:['../outside']},root,[],2)).toThrow();
   expect(()=>validateSpecPreflight({...evidence,verdict:'duplicate',issue_number:3},root,[],2)).toThrow();
   expect(validateSpecPreflight({...evidence,verdict:'duplicate',issue_number:3},root,[{number:3}],2).issue_number).toBe(3);
   expect(()=>validateSpecPreflight(null,root,[],2)).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
