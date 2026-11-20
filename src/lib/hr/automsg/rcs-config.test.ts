import { afterEach, describe, expect, it, vi } from 'vitest';
import { rcsSendConfig, rcsWebhookConfig } from './rcs-config';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

afterEach(() => vi.restoreAllMocks());

describe('rcsSendConfig', () => {
  it('is off with nothing set', () => {
    expect(rcsSendConfig({})).toBeNull();
  });

  it('reads all three, trimmed', () => {
    expect(
      rcsSendConfig({
        RCS_BASE_URL: ' https://rcs.example.com/v1 ',
        RCS_TOKEN: 'tok',
        RCS_SENDER_ID: 'sender-1',
      })
    ).toEqual({
      baseUrl: 'https://rcs.example.com/v1',
      token: 'tok',
      senderId: 'sender-1',
    });
  });

  it('is off when one is missing, and names it without any value', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      rcsSendConfig({
        RCS_BASE_URL: 'https://rcs.example.com',
        RCS_TOKEN: 'secret-token',
      })
    ).toBeNull();
    const line = String(log.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('RCS_SENDER_ID');
    expect(line).not.toContain('secret-token');
  });

  it('refuses a plain-http or malformed base URL', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = { RCS_TOKEN: 't', RCS_SENDER_ID: 's' };
    expect(
      rcsSendConfig({ ...base, RCS_BASE_URL: 'http://rcs.example.com' })
    ).toBeNull();
    expect(rcsSendConfig({ ...base, RCS_BASE_URL: 'not a url' })).toBeNull();
  });
});

describe('rcsWebhookConfig', () => {
  it('is off with nothing set', () => {
    expect(rcsWebhookConfig({})).toBeNull();
  });

  it('reads the secret and the workspace', () => {
    expect(
      rcsWebhookConfig({
        RCS_WEBHOOK_SECRET: 'a-long-enough-secret',
        RCS_WORKSPACE_ID: ACCOUNT,
      })
    ).toEqual({ secret: 'a-long-enough-secret', accountId: ACCOUNT });
  });

  it('is off when half set, the secret is short, or the id is not a uuid', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      rcsWebhookConfig({ RCS_WEBHOOK_SECRET: 'a-long-enough-secret' })
    ).toBeNull();
    expect(rcsWebhookConfig({ RCS_WORKSPACE_ID: ACCOUNT })).toBeNull();
    expect(
      rcsWebhookConfig({
        RCS_WEBHOOK_SECRET: 'short',
        RCS_WORKSPACE_ID: ACCOUNT,
      })
    ).toBeNull();
    expect(
      rcsWebhookConfig({
        RCS_WEBHOOK_SECRET: 'a-long-enough-secret',
        RCS_WORKSPACE_ID: 'workspace-1',
      })
    ).toBeNull();
  });
});
