// @ts-nocheck
/**
 * Gate-event notifications (§8). A best-effort Slack post to the project's incoming webhook when one is
 * configured; off by default. The message names the event, the issue, and the reporter. A per-user Slack
 * mapping is out of scope for now, so this is a channel post. This never throws: a notification failure
 * must never affect a run.
 */
const SLACK_HOST = 'hooks.slack.com';

/**
 * @param project resolved project settings (must include slackWebhook, decrypted)
 * @param run the run row (title, issue_number, reporter_display_name)
 * @param event a short human label, e.g. 'Spec ready for review'
 * @param opts.link optional admin URL to include
 */
export async function notifyGate(project, run, event, opts = {}) {
  try {
    const url = project?.slackWebhook;
    if (!url) return;
    // SSRF guard: only ever post to a real Slack incoming webhook over https.
    let u;
    try { u = new URL(String(url)); } catch { return; }
    if (u.protocol !== 'https:' || u.hostname !== SLACK_HOST) return;
    const reporter = run?.reporter_display_name ? ` · reported by ${run.reporter_display_name}` : '';
    const title = run?.title || (run?.issue_number ? `issue #${run.issue_number}` : 'a run');
    const link = opts.link ? `\n${opts.link}` : '';
    const text = `Software Engineer: ${event} — ${title}${reporter}${link}`;
    await fetch(String(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch { /* best-effort — never let a notification failure affect a run */ }
}
