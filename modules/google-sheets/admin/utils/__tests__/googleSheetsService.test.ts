import { beforeEach, describe, expect, it, vi } from 'vitest';

// Records every query-builder call so the tests can check which table and
// columns the service asks for. The builder is thenable and resolves to an
// empty result, like supabase-js.
const calls: Array<[string, unknown[]]> = [];
function builder(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
        }
        return (...args: unknown[]) => {
          calls.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => { calls.push(['from', [table]]); return builder(); } },
}));

import {
  getEventGoogleSheetsNotification,
  getEventGoogleSheetsNotifications,
  getGoogleSheetsNotificationLogs,
  hasValidOAuthCredentials,
  upsertEventGoogleSheetsNotification,
} from '../googleSheetsService';

const TOKEN_COLUMNS = /google_(access|refresh)_token/;
const arg = (name: string) => calls.find(([p]) => p === name)?.[1];

beforeEach(() => {
  calls.length = 0;
});

describe('googleSheetsService reads only the columns client roles may see', () => {
  it.each([
    ['list', () => getEventGoogleSheetsNotifications('abc')],
    ['single', () => getEventGoogleSheetsNotification('abc', 'registration')],
  ])('%s: queries the real table and names its columns, never the tokens or *', async (_l, run) => {
    await run();
    expect(arg('from')).toEqual(['event_google_sheets_notifications']);
    const cols = String(arg('select')?.[0]);
    expect(cols).not.toBe('*');
    expect(cols).not.toMatch(TOKEN_COLUMNS);
    expect(cols).toContain('google_connected');
  });

  it('upsert sends only writable columns and returns only readable ones', async () => {
    await upsertEventGoogleSheetsNotification({
      event_id: 'abc',
      notification_type: 'registration',
      sheet_name: 'Sheet2',
      // A caller passing a whole row, or a hostile one, must not reach the token columns.
      ...({ google_refresh_token: 'x', google_access_token: 'y', id: 'z' } as object),
    });
    expect(arg('from')).toEqual(['event_google_sheets_notifications']);
    const row = arg('upsert')?.[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['event_id', 'notification_type', 'sheet_name', 'updated_at']);
    expect(String(arg('select')?.[0])).not.toMatch(TOKEN_COLUMNS);
    expect(String(arg('select')?.[0])).not.toBe('');
  });

  it('logs come from the table the module creates', async () => {
    await getGoogleSheetsNotificationLogs('abc');
    expect(arg('from')).toEqual(['google_sheets_notification_logs']);
  });

  it('connected state comes from google_connected', () => {
    expect(hasValidOAuthCredentials({ google_connected: true } as never)).toBe(true);
    expect(hasValidOAuthCredentials({ google_connected: false } as never)).toBe(false);
    expect(hasValidOAuthCredentials(null)).toBe(false);
  });
});
