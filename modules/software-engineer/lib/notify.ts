// @ts-nocheck
/** Best-effort gate alerts. Notifications never approve or advance a run. */
const SLACK_HOST = 'hooks.slack.com';
const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

function approvalLink(run) {
  if (!/^[0-9a-f-]{36}$/i.test(run?.id ?? '')) return null;
  try {
    const origin = new URL(process.env.SE_ADMIN_ORIGIN ?? '');
    if (origin.protocol !== 'https:' || origin.username || origin.password) return null;
    return new URL(`/software-engineer/runs/${run.id}`, origin.origin).href;
  } catch { return null; }
}

export async function notifyGate(project, run, event, opts = {}) {
  const tasks = [];
  let pushoverDelivered = false;
  let link = approvalLink(run);
  if (opts.approvalLink) {
    try {
      const u=new URL(opts.approvalLink), expected=new URL(process.env.SE_ADMIN_ORIGIN);
      if(u.protocol==='https:' && !u.username && !u.password && u.origin===expected.origin && u.pathname==='/api/modules/software-engineer/internal/approval' && /^#[A-Za-z0-9_-]{43}$/.test(u.hash)) link=u.href;
    } catch { /* invalid capability stays disabled */ }
  }
  const slack = project?.slackWebhook;
  if (slack) {
    try {
      const u = new URL(String(slack));
      if (u.protocol === 'https:' && u.hostname === SLACK_HOST) {
        const reporter = run?.reporter_display_name ? ` · reported by ${run.reporter_display_name}` : '';
        const title = run?.title || (run?.issue_number ? `issue #${run.issue_number}` : 'a run');
        const url = opts.link || link;
        tasks.push(fetch(String(slack), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Software Engineer: ${event} — ${title}${reporter}${url ? `\n${url}` : ''}` }),
          signal: AbortSignal.timeout(8000),
        }));
      }
    } catch { /* malformed webhook stays disabled */ }
  }
  // Explicit project allowlist keeps an existing shared stocks token from
  // unexpectedly sending alerts for other tenants/projects. No key in URLs.
  const allowed = (process.env.SE_PUSHOVER_PROJECT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const token = process.env.SE_PUSHOVER_APP_TOKEN || process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.SE_PUSHOVER_USER_KEY || process.env.PUSHOVER_USER_KEY;
  if (link && token && user && allowed.includes(project?.projectId)) {
    tasks.push(fetch(PUSHOVER_URL, {
      method: 'POST',
      body: new URLSearchParams({ token, user, title: 'Software Engineer approval',
        // Keep private specs, reporter identities and health details off the lock screen.
        message: `${event}. ${project.name || 'Project'}${run?.issue_number ? ` issue #${run.issue_number}` : ''}.`,
        url: link, url_title: 'Review and approve', priority: '0' }),
      signal: AbortSignal.timeout(8000),
    }).then(async response => {
      const result = await response.json();
      if (!response.ok || result.status !== 1) throw new Error('Pushover delivery rejected');
      pushoverDelivered = true;
    }));
  }
  await Promise.allSettled(tasks);
  return { pushoverDelivered };
}
