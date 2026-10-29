import { describe, it, expect, afterEach } from 'vitest';
import {
  escapeSlackText, readSlackToken, scanTokens, setSlackStoreLoader, slackSenderOf, slackSubstitutions, type SlackStore,
} from '../slack-message';

describe('slackSubstitutions', () => {
  const attrs = { first_name: 'Sam', last_name: 'Lee', company: 'A<b>&C', job_title: '' };

  it('fills merge fields from the profile', () => {
    const tokens = scanTokens('Hi {{first_name}} ({{name}}) at {{company}}');
    expect(slackSubstitutions(tokens, attrs, 'sam@x.io')).toEqual({
      '{{first_name}}': 'Sam', '{{name}}': 'Sam Lee', '{{company}}': 'A&lt;b&gt;&amp;C',
    });
  });

  it('escapes profile values so they cannot mention or link', () => {
    const subs = slackSubstitutions(['{{first_name}}'], { first_name: '<!channel> <https://evil.example|x>' }, null);
    expect(subs['{{first_name}}']).toBe('&lt;!channel&gt; &lt;https://evil.example|x&gt;');
  });

  it('uses the fallback for an empty field, and blanks unsubscribe tokens', () => {
    const subs = slackSubstitutions(['{{job_title|"friend"}}', '{{unsubscribe_url}}'], attrs, null);
    expect(subs).toEqual({ '{{job_title|"friend"}}': 'friend', '{{unsubscribe_url}}': '' });
  });

  it('leaves unknown tokens alone', () => {
    expect(slackSubstitutions(['{{event_name}}'], attrs, null)).toEqual({});
  });

  it('escapes only Slack control characters', () => {
    expect(escapeSlackText('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
  });
});

describe('readSlackToken', () => {
  afterEach(() => setSlackStoreLoader(async () => { throw new Error('reset'); }));

  const store = (bot: string, user: string | null): SlackStore => ({
    readSlackConfig: async () => ({ botToken: bot }),
    readSenderWithToken: async () => (user === null ? null : { token: user }),
    readSender: async () => null,
  });

  it('reads the bot token or the welcome sender token', async () => {
    setSlackStoreLoader(async () => store('xoxb-1', 'xoxp-2'));
    expect(await readSlackToken({}, 'bot')).toBe('xoxb-1');
    expect(await readSlackToken({}, 'welcome_sender')).toBe('xoxp-2');
  });

  it('returns empty when the sender is not connected', async () => {
    setSlackStoreLoader(async () => store('', null));
    expect(await readSlackToken({}, 'bot')).toBe('');
    expect(await readSlackToken({}, 'welcome_sender')).toBe('');
  });

  it('defaults the sender to the bot', () => {
    expect(slackSenderOf(null)).toBe('bot');
    expect(slackSenderOf({ slack_sender: 'something' })).toBe('bot');
    expect(slackSenderOf({ slack_sender: 'welcome_sender' })).toBe('welcome_sender');
  });
});
