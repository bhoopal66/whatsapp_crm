import { afterEach, describe, expect, it, vi } from 'vitest';
import { smsSendConfig, smsWebhookConfig } from './sms-config';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SEND = {
  DINSTAR_BASE_URL: ' https://192.168.1.50/ ',
  DINSTAR_USERNAME: 'admin',
  DINSTAR_PASSWORD: 'gw-secret-pass',
};

afterEach(() => vi.restoreAllMocks());

describe('smsSendConfig', () => {
  it('is off with nothing set', () => {
    expect(smsSendConfig({})).toBeNull();
  });

  it('reads the three, trimmed, with the default pace', () => {
    expect(smsSendConfig(SEND)).toEqual({
      baseUrl: 'https://192.168.1.50/',
      username: 'admin',
      password: 'gw-secret-pass',
      maxPerMinute: 10,
    });
  });

  it('reads ports, the fingerprint (colons and case normalised) and the pace', () => {
    const fp = 'AB:' + 'cd'.repeat(31);
    expect(
      smsSendConfig({
        ...SEND,
        DINSTAR_PORTS: '0, 3,3',
        DINSTAR_TLS_FINGERPRINT: fp,
        DINSTAR_MAX_PER_MINUTE: '120',
      })
    ).toMatchObject({
      ports: [0, 3],
      tlsFingerprint: 'ab' + 'cd'.repeat(31),
      maxPerMinute: 120,
    });
  });

  it('is off when one is missing, and names it without any value', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      smsSendConfig({
        DINSTAR_BASE_URL: 'https://gw.example',
        DINSTAR_PASSWORD: 'p-secret-value',
      })
    ).toBeNull();
    const line = String(log.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('DINSTAR_USERNAME');
    expect(line).not.toContain('p-secret-value');
  });

  it.each([
    ['DINSTAR_BASE_URL', 'http://gw.example'],
    ['DINSTAR_BASE_URL', 'not a url'],
    ['DINSTAR_PORTS', '0,32'],
    ['DINSTAR_PORTS', 'a'],
    ['DINSTAR_TLS_FINGERPRINT', 'abc'],
    ['DINSTAR_MAX_PER_MINUTE', '0'],
    ['DINSTAR_MAX_PER_MINUTE', '121'],
    ['DINSTAR_MAX_PER_MINUTE', '2.5'],
  ])('is off with %s=%s', (key, value) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(smsSendConfig({ ...SEND, [key]: value })).toBeNull();
  });
});

describe('smsWebhookConfig', () => {
  it('is off with nothing set', () => {
    expect(smsWebhookConfig({})).toBeNull();
  });

  it('reads the secret, the workspace and the options', () => {
    expect(
      smsWebhookConfig({
        SMS_WEBHOOK_SECRET: 'a-long-enough-secret',
        SMS_WORKSPACE_ID: ACCOUNT,
      })
    ).toEqual({
      secret: 'a-long-enough-secret',
      accountId: ACCOUNT,
      allowQueryToken: false,
      allowIps: [],
    });
    expect(
      smsWebhookConfig({
        SMS_WEBHOOK_SECRET: 'a-long-enough-secret',
        SMS_WORKSPACE_ID: ACCOUNT,
        SMS_ALLOW_QUERY_TOKEN: '1',
        SMS_WEBHOOK_ALLOW_IPS: '10.0.0.5, 10.0.0.6',
      })
    ).toMatchObject({
      allowQueryToken: true,
      allowIps: ['10.0.0.5', '10.0.0.6'],
    });
  });

  it('is off half-set, with a short secret or a non-uuid workspace', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      smsWebhookConfig({ SMS_WEBHOOK_SECRET: 'a-long-enough-secret' })
    ).toBeNull();
    expect(
      smsWebhookConfig({
        SMS_WEBHOOK_SECRET: 'short',
        SMS_WORKSPACE_ID: ACCOUNT,
      })
    ).toBeNull();
    expect(
      smsWebhookConfig({
        SMS_WEBHOOK_SECRET: 'a-long-enough-secret',
        SMS_WORKSPACE_ID: 'acme',
      })
    ).toBeNull();
    for (const [line] of log.mock.calls)
      expect(String(line)).not.toContain('a-long-enough-secret');
  });
});
