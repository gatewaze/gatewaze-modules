import { afterEach, describe, expect, it, vi } from 'vitest';

// speakerEmailService pulls in admin-only modules (the core supabase client,
// template helpers, the bulk-emailing services). buildConfirmationLink uses
// none of them, so they are stubbed to let the file load standalone.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/utils/templateVariables', () => ({ replaceVariables: vi.fn(), buildContext: vi.fn() }));
vi.mock('../../bulk-emailing/admin/utils/emailService', () => ({ default: {} }));
vi.mock('../../bulk-emailing/admin/utils/emailTemplateService', () => ({ default: {} }));

import { SpeakerEmailService } from '../admin/utils/speakerEmailService';

const ADMIN_ORIGIN = 'https://admin.example.test';
const SUPABASE_URL = 'https://project.supabase.co';
const LINK = `${SUPABASE_URL}/functions/v1/events-speaker-confirm?token=t`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SpeakerEmailService.buildConfirmationLink', () => {
  it('host-session: emails the real Supabase URL, not the admin origin', () => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', SUPABASE_URL);
    expect(SpeakerEmailService.buildConfirmationLink('t')).toBe(LINK);
  });

  it('older admin or local mode: falls back to VITE_SUPABASE_URL when the public URL is unset', () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(SpeakerEmailService.buildConfirmationLink('t')).toBe(LINK);
  });

  it('does not produce a double slash when the public URL ends in one', () => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', `${SUPABASE_URL}/`);
    expect(SpeakerEmailService.buildConfirmationLink('t')).toBe(LINK);
  });
});
