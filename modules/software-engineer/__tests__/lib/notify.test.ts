import { afterEach, expect, it, vi } from 'vitest';
import { notifyGate } from '../../lib/notify';
const run = {id:'90239ba4-d406-441f-b2ce-8394d9b4ae76',issue_number:69,title:'private health detail',reporter_display_name:'private person'};
afterEach(() => {vi.unstubAllEnvs();vi.unstubAllGlobals();});
function setup() {
 vi.stubEnv('SE_ADMIN_ORIGIN','https://staging-admin.aaif.live');vi.stubEnv('SE_PUSHOVER_PROJECT_IDS','gatewaze');
 vi.stubEnv('PUSHOVER_APP_TOKEN','test-token');vi.stubEnv('PUSHOVER_USER_KEY','test-user');
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({status:1})});vi.stubGlobal('fetch',fetch);return fetch;
}
it('sends only allowed project approval links without private content',async()=>{
 const fetch=setup();await notifyGate({projectId:'gatewaze',name:'Gatewaze'},run,'Spec ready for review');
 const body=fetch.mock.calls[0][1].body;expect(body.get('url')).toBe(`https://staging-admin.aaif.live/software-engineer/runs/${run.id}`);
 expect(body.get('message')).not.toContain('private');expect(body.get('url_title')).toBe('Review and approve');
});
it('does not notify other projects',async()=>{const fetch=setup();await notifyGate({projectId:'other'},run,'Review');expect(fetch).not.toHaveBeenCalled();});
it('does not let Slack failure suppress Pushover or block a run',async()=>{
 const fetch=setup();fetch.mockRejectedValueOnce(new Error('network'));await expect(notifyGate({projectId:'gatewaze',slackWebhook:'https://hooks.slack.com/services/test'},run,'Review')).resolves.toEqual({pushoverDelivered:true});expect(fetch).toHaveBeenCalledTimes(2);
});
it('rejects insecure or credential-bearing admin origins',async()=>{const fetch=setup();vi.stubEnv('SE_ADMIN_ORIGIN','https://secret@example.com');await notifyGate({projectId:'gatewaze'},run,'Review');expect(fetch).not.toHaveBeenCalled();});
