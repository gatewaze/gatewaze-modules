/**
 * Scraper Alert Service
 *
 * Sends alerts to Slack when scraper jobs fail, stall, or time out.
 * No-op if SCRAPER_ALERT_WEBHOOK_URL is not set.
 */

const SEVERITY_COLORS = {
  critical: '#FF0000',
  error: '#FF6600',
  warning: '#FFCC00',
  info: '#0066FF',
};

/**
 * Send a scraper alert to Slack
 */
export async function sendScraperAlert({ severity = 'warning', title, message, scraperName, jobId }) {
  const webhookUrl = process.env.SCRAPER_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.warning;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color,
          title: `[Scraper ${severity.toUpperCase()}] ${title}`,
          text: message,
          fields: [
            { title: 'Scraper', value: scraperName || 'unknown', short: true },
            { title: 'Job ID', value: jobId || 'N/A', short: true },
          ],
          ts: Math.floor(Date.now() / 1000),
        }]
      })
    });
  } catch (err) {
    console.error(`[scraper-alerts] Failed to send alert: ${err.message}`);
  }
}
