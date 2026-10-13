import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Fail closed on absent, invented or ambiguous evidence. Existing code alone never dismisses a bug. */
export function validateSpecPreflight(value: any, root: string, issues: any[], current: number) {
  if (!value || !['new_work','regression','duplicate','already_implemented','uncertain'].includes(value.verdict)) throw new Error('Missing valid spec preflight');
  if (typeof value.reason !== 'string' || value.reason.trim().length < 20 || value.reason.length > 4000) throw new Error('Preflight requires an explanation');
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 30) throw new Error('Preflight requires inspected code files');
  for (const file of value.files) {
    if (typeof file !== 'string' || !resolve(root,file).startsWith(resolve(root)+sep) || !existsSync(resolve(root,file))) throw new Error('Preflight references an unavailable file');
  }
  if(value.verdict==='duplicate' && (!Number.isInteger(value.issue_number) || value.issue_number===current || !issues.some(i=>i.number===value.issue_number))) throw new Error('Preflight references an unverified issue');
  return value;
}
