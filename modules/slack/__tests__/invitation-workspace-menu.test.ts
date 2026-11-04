// @ts-nocheck — vitest harness.

/**
 * Through the residential proxy the Slack client takes 11-20 s to render its
 * header. Opening the workspace menu must wait for the header itself, and
 * reload once before an invite is given up on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('puppeteer-extra', () => ({ default: { use: () => {}, launch: async () => ({}) } }));
vi.mock('puppeteer-extra-plugin-stealth', () => ({ default: () => ({}) }));

const { SlackInvitationManager } = await import('../scripts/SlackInvitationManager.js');

function manager({ uiReady = [true], clicks = [true] } = {}) {
  const m = new SlackInvitationManager({ workspaceUrl: 'https://example.slack.com' });
  const page = {
    goto: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {
      if (!uiReady.shift()) throw new Error('timeout');
    }),
    evaluate: vi.fn(async () => ({ url: 'https://app.slack.com/client/T1', title: 'Slack' })),
  };
  m.page = page;
  m.wait = vi.fn(async () => {});
  m.clickWorkspaceMenu = vi.fn(async () => clicks.shift() ?? false);
  return { m, page };
}

beforeEach(() => {
  delete process.env.SLACK_UI_TIMEOUT_MS;
});

describe('openWorkspaceMenu', () => {
  it('opens the menu after one load, without reloading', async () => {
    const { m, page } = manager();
    expect(await m.openWorkspaceMenu('https://example.slack.com')).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('waits up to 60 s for the visible workspace button, not a fixed delay', async () => {
    const { m, page } = manager();
    await m.openWorkspaceMenu('https://example.slack.com');
    const [selector, opts] = page.waitForSelector.mock.calls[0];
    expect(selector).toContain('[data-qa="workspace_actions_button"]');
    expect(opts).toMatchObject({ visible: true, timeout: 60000 });
  });

  it('reloads once and opens the menu on the second try', async () => {
    const { m, page } = manager({ uiReady: [false, true], clicks: [false, true] });
    expect(await m.openWorkspaceMenu('https://example.slack.com')).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('gives up after the reload also fails', async () => {
    const { m, page } = manager({ uiReady: [false, false], clicks: [false, false] });
    expect(await m.openWorkspaceMenu('https://example.slack.com')).toBe(false);
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(m.clickWorkspaceMenu).toHaveBeenCalledTimes(2);
  });

  it('carries on when navigation times out, since the SPA is often usable', async () => {
    const { m, page } = manager();
    page.goto.mockRejectedValueOnce(new Error('Navigation timeout'));
    expect(await m.openWorkspaceMenu('https://example.slack.com')).toBe(true);
  });

  it('honours SLACK_UI_TIMEOUT_MS', async () => {
    process.env.SLACK_UI_TIMEOUT_MS = '90000';
    const { m, page } = manager();
    await m.openWorkspaceMenu('https://example.slack.com');
    expect(page.waitForSelector.mock.calls[0][1].timeout).toBe(90000);
  });
});
