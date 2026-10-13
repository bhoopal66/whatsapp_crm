import { describe, expect, it } from 'vitest';

import {
  PBX_AUTH_BACKOFF_MINUTES,
  applyExtensionPatch,
  baseUrlHost,
  canEditExtension,
  connectionState,
  extensionState,
  lastEventAgo,
  parseDueMinutes,
  enforcedRetention,
  parseRetentionDays,
  retentionNeedsConfirm,
  routedWorkspaceNames,
  rulesBody,
  sendsRetention,
  validateBankNumbers,
  validateConnectionForm,
  validateRoutes,
  workspaceChangePatch,
  type ConnectionDraft,
  type MappableWorkspace,
  type PbxExtensionView,
  type RecordingRules,
} from '../admin-ui';
import { PBX_AUTH_BACKOFF_MS } from '../connection';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const SARA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OMAR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const workspaces: MappableWorkspace[] = [
  {
    accountId: WS_A,
    name: 'Taamul',
    people: [
      { userId: SARA, name: 'Sara' },
      { userId: OMAR, name: 'Omar' },
    ],
  },
  { accountId: WS_B, name: 'Mortgages', people: [{ userId: SARA, name: 'S' }] },
];

const ext = (over: Partial<PbxExtensionView> = {}): PbxExtensionView => ({
  id: 'e1',
  extension: '201',
  accountId: WS_A,
  userId: OMAR,
  personName: 'Omar',
  mapped: true,
  softphoneEnabled: false,
  presenceMonitor: true,
  registrationState: 'registered',
  clientKind: 'web',
  updatedAt: '2026-10-12T00:00:00Z',
  ...over,
});

describe('backoff mirror', () => {
  it('matches the server backoff', () => {
    expect(PBX_AUTH_BACKOFF_MINUTES * 60_000).toBe(PBX_AUTH_BACKOFF_MS);
  });
});

describe('connectionState', () => {
  it('names each status with its colour', () => {
    expect(connectionState(null)).toEqual({ state: 'none', tone: 'amber' });
    expect(connectionState({ status: 'connected' })).toEqual({
      state: 'connected',
      tone: 'green',
    });
    expect(connectionState({ status: 'auth_failed' })).toEqual({
      state: 'auth_failed',
      tone: 'red',
    });
    for (const status of ['unknown', 'disconnected', 'weird'])
      expect(connectionState({ status })).toEqual({
        state: 'not_connected',
        tone: 'amber',
      });
  });
});

describe('lastEventAgo', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('uses the largest whole unit', () => {
    expect(lastEventAgo(ago(2_000), now)).toEqual({ unit: 's', count: 2 });
    expect(lastEventAgo(ago(59_999), now)).toEqual({ unit: 's', count: 59 });
    expect(lastEventAgo(ago(60_000), now)).toEqual({ unit: 'min', count: 1 });
    expect(lastEventAgo(ago(3_599_000), now)).toEqual({
      unit: 'min',
      count: 59,
    });
    expect(lastEventAgo(ago(5 * 3_600_000), now)).toEqual({
      unit: 'h',
      count: 5,
    });
    expect(lastEventAgo(ago(3 * 86_400_000 + 5), now)).toEqual({
      unit: 'd',
      count: 3,
    });
  });

  it('reads a future stamp as 0 s and nothing as null', () => {
    expect(lastEventAgo(ago(-30_000), now)).toEqual({ unit: 's', count: 0 });
    expect(lastEventAgo(null, now)).toBeNull();
    expect(lastEventAgo('not a date', now)).toBeNull();
  });
});

describe('baseUrlHost and routedWorkspaceNames', () => {
  it('shows the host, or the raw text when it is not a URL', () => {
    expect(baseUrlHost('https://pbx.example.com:8088')).toBe(
      'pbx.example.com:8088'
    );
    expect(baseUrlHost('nope')).toBe('nope');
  });

  it('names each routed workspace once, skipping unknown ones', () => {
    expect(
      routedWorkspaceNames(
        [
          { accountId: WS_B },
          { accountId: WS_A },
          { accountId: WS_B },
          { accountId: 'unknown' },
          { accountId: null },
        ],
        workspaces
      )
    ).toEqual(['Mortgages', 'Taamul']);
  });
});

describe('extensionState', () => {
  it('maps registration onto the four states', () => {
    expect(extensionState(ext())).toEqual({
      state: 'registered',
      tone: 'green',
    });
    expect(extensionState(ext({ clientKind: 'sip' }))).toEqual({
      state: 'desk_phone',
      tone: 'grey',
    });
    expect(extensionState(ext({ registrationState: 'unregistered' }))).toEqual({
      state: 'offline',
      tone: 'muted',
    });
    expect(extensionState(ext({ registrationState: null }))).toEqual({
      state: 'offline',
      tone: 'muted',
    });
  });

  it('says Not mapped before anything else', () => {
    expect(
      extensionState(ext({ mapped: false, userId: null, clientKind: 'sip' }))
    ).toEqual({ state: 'unmapped', tone: 'brown' });
  });
});

describe('extension edits', () => {
  it('only edits rows in an administered workspace', () => {
    expect(canEditExtension(ext(), workspaces)).toBe(true);
    expect(canEditExtension(ext({ accountId: 'other' }), workspaces)).toBe(
      false
    );
  });

  it('keeps the person on a move only if they are staff there', () => {
    expect(
      workspaceChangePatch(ext({ userId: SARA }), WS_B, workspaces)
    ).toEqual({ accountId: WS_B, userId: SARA });
    expect(workspaceChangePatch(ext(), WS_B, workspaces)).toEqual({
      accountId: WS_B,
      userId: null,
    });
    expect(workspaceChangePatch(ext(), 'gone', workspaces)).toEqual({
      accountId: 'gone',
      userId: null,
    });
  });

  it('applies a patch optimistically', () => {
    const mapped = applyExtensionPatch(
      ext({ userId: null, personName: null, mapped: false }),
      { userId: SARA },
      workspaces
    );
    expect(mapped).toMatchObject({
      userId: SARA,
      personName: 'Sara',
      mapped: true,
    });
    expect(
      applyExtensionPatch(ext(), { userId: null }, workspaces)
    ).toMatchObject({ userId: null, personName: null, mapped: false });
    expect(
      applyExtensionPatch(
        ext(),
        { accountId: WS_B, userId: SARA, softphoneEnabled: true },
        workspaces
      )
    ).toMatchObject({
      accountId: WS_B,
      personName: 'S',
      softphoneEnabled: true,
      presenceMonitor: true,
    });
  });
});

describe('validateRoutes', () => {
  it('sends digits only, a trimmed name or null, and the workspace', () => {
    expect(
      validateRoutes([
        { didNumber: '+971 4 123-4567', nameOnPbx: ' Main ', accountId: WS_A },
        { didNumber: '٨٠٠١٢٣', nameOnPbx: '  ', accountId: WS_B },
      ])
    ).toEqual({
      ok: true,
      payload: {
        routes: [
          { didNumber: '97141234567', nameOnPbx: 'Main', accountId: WS_A },
          { didNumber: '800123', nameOnPbx: null, accountId: WS_B },
        ],
      },
    });
    expect(validateRoutes([])).toEqual({ ok: true, payload: { routes: [] } });
  });

  it('refuses a number listed twice, however it is written', () => {
    const r = validateRoutes([
      { didNumber: '+971 4 1234567', nameOnPbx: '', accountId: WS_A },
      { didNumber: '97141234567', nameOnPbx: '', accountId: WS_B },
    ]);
    expect(r).toEqual({
      ok: false,
      issues: [{}, { number: 'number_duplicate' }],
    });
  });

  it('names missing digits, letters, length and the workspace', () => {
    const r = validateRoutes([
      { didNumber: ' ', nameOnPbx: '', accountId: WS_A },
      { didNumber: '04 12ab', nameOnPbx: '', accountId: WS_A },
      {
        didNumber: '1'.repeat(21),
        nameOnPbx: 'x'.repeat(101),
        accountId: null,
      },
    ]);
    expect(r).toEqual({
      ok: false,
      issues: [
        { number: 'number_required' },
        { number: 'number_invalid' },
        {
          number: 'number_invalid',
          name: 'name_too_long',
          workspace: 'workspace_required',
        },
      ],
    });
  });
});

describe('validateBankNumbers', () => {
  it('needs 3 to 20 digits, once each, and a bank code', () => {
    expect(
      validateBankNumbers(
        [{ number: '+971 50 111 2222', bankCode: ' ADCB ' }],
        ['0501']
      )
    ).toEqual({
      ok: true,
      payload: {
        bankNumbers: [{ number: '971501112222', bankCode: 'ADCB' }],
        // The numbers the screen loaded: the route deletes only these.
        loaded: ['0501'],
      },
    });
    expect(
      validateBankNumbers(
        [
          { number: '12', bankCode: 'ENBD' },
          { number: '0501112222', bankCode: '' },
          { number: '050-111-2222', bankCode: 'x'.repeat(33) },
        ],
        []
      )
    ).toEqual({
      ok: false,
      issues: [
        { number: 'number_invalid' },
        { bankCode: 'bank_code_required' },
        { number: 'number_duplicate', bankCode: 'bank_code_required' },
      ],
    });
  });
});

describe('recording rules inputs', () => {
  it('reads retention: empty keeps, else 1 to 3650 whole days', () => {
    expect(parseRetentionDays('')).toEqual({ ok: true, value: null });
    expect(parseRetentionDays(' 90 ')).toEqual({ ok: true, value: 90 });
    for (const bad of ['0', '3651', '1.5', '-3', 'ten'])
      expect(parseRetentionDays(bad)).toEqual({ ok: false });
  });

  it('reads the missed-call due time: 1 to 1440 minutes', () => {
    expect(parseDueMinutes('30')).toBe(30);
    expect(parseDueMinutes('1440')).toBe(1440);
    for (const bad of ['', '0', '1441', '2.5'])
      expect(parseDueMinutes(bad)).toBeNull();
  });
});

describe('validateConnectionForm', () => {
  const draft = (over: Partial<ConnectionDraft> = {}): ConnectionDraft => ({
    label: 'Head office',
    edition: 'cloud',
    baseUrl: 'https://acme.ras.yeastar.com/some/path',
    clientId: 'client-1234',
    clientSecret: 'shh',
    sdkAccessId: '',
    sdkAccessKey: '',
    webhookSecret: '',
    clearSdk: false,
    clearWebhookSecret: false,
    ...over,
  });
  const stored = { hasClientSecret: true, hasSdkCredentials: false };

  it('sends the origin and omits secrets left empty', () => {
    expect(validateConnectionForm(draft({ clientSecret: '' }), stored)).toEqual(
      {
        ok: true,
        payload: {
          label: 'Head office',
          edition: 'cloud',
          baseUrl: 'https://acme.ras.yeastar.com',
          clientId: 'client-1234',
        },
      }
    );
  });

  it('needs https:// on Cloud but allows http:// on premises', () => {
    expect(
      validateConnectionForm(draft({ baseUrl: 'http://10.0.0.5' }), stored)
    ).toEqual({ ok: false, issues: { baseUrl: 'base_url_https' } });
    const onPrem = validateConnectionForm(
      draft({ edition: 'appliance', baseUrl: 'http://10.0.0.5:8088' }),
      stored
    );
    expect(onPrem.ok && onPrem.payload.baseUrl).toBe('http://10.0.0.5:8088');
    expect(
      validateConnectionForm(
        draft({ edition: 'software', baseUrl: 'ftp://x' }),
        stored
      )
    ).toEqual({ ok: false, issues: { baseUrl: 'base_url_invalid' } });
    expect(
      validateConnectionForm(draft({ baseUrl: 'https://u:p@x.com' }), stored)
    ).toEqual({ ok: false, issues: { baseUrl: 'base_url_credentials' } });
  });

  it('needs a 32-character webhook secret', () => {
    expect(
      validateConnectionForm(draft({ webhookSecret: 'x'.repeat(31) }), stored)
    ).toEqual({
      ok: false,
      issues: { webhookSecret: 'webhook_secret_length' },
    });
    const ok = validateConnectionForm(
      draft({ webhookSecret: 'x'.repeat(32) }),
      stored
    );
    expect(ok.ok && ok.payload.webhookSecret).toBe('x'.repeat(32));
  });

  it('keeps the stored Client ID when the field is left empty', () => {
    expect(validateConnectionForm(draft({ clientId: ' ' }), stored)).toEqual({
      ok: true,
      payload: {
        label: 'Head office',
        edition: 'cloud',
        baseUrl: 'https://acme.ras.yeastar.com',
        clientSecret: 'shh',
      },
    });
  });

  it('needs a Client Secret until one is stored, and a Client ID for a new connection', () => {
    expect(
      validateConnectionForm(draft({ clientSecret: '', clientId: ' ' }), null)
    ).toEqual({
      ok: false,
      issues: {
        clientId: 'client_id_required',
        clientSecret: 'client_secret_required',
      },
    });
  });

  it('needs both halves of a new SDK pair; remove sends null', () => {
    expect(
      validateConnectionForm(draft({ sdkAccessId: 'id' }), stored)
    ).toEqual({ ok: false, issues: { sdk: 'sdk_pair' } });
    const rotate = validateConnectionForm(draft({ sdkAccessKey: 'k2' }), {
      ...stored,
      hasSdkCredentials: true,
    });
    expect(rotate.ok && rotate.payload.sdkAccessKey).toBe('k2');
    const cleared = validateConnectionForm(
      draft({ clearSdk: true, clearWebhookSecret: true, sdkAccessId: 'id' }),
      stored
    );
    expect(cleared.ok && cleared.payload).toMatchObject({
      sdkAccessId: null,
      sdkAccessKey: null,
      webhookSecret: null,
    });
  });

  it('needs a label', () => {
    expect(validateConnectionForm(draft({ label: '  ' }), stored)).toEqual({
      ok: false,
      issues: { label: 'label_required' },
    });
  });
});

describe('retentionNeedsConfirm', () => {
  it('asks before a first or shorter period, never a longer one or none', () => {
    expect(retentionNeedsConfirm(null, 30)).toBe(true);
    expect(retentionNeedsConfirm(90, 30)).toBe(true);
    expect(retentionNeedsConfirm(30, 30)).toBe(false);
    expect(retentionNeedsConfirm(30, 90)).toBe(false);
    expect(retentionNeedsConfirm(30, null)).toBe(false);
    expect(retentionNeedsConfirm(null, null)).toBe(false);
  });
});

describe('the recording rules save (093)', () => {
  const AT = '2026-10-01T09:00:00Z';
  const rules = (
    retentionDays: number | null,
    retentionConfirmedAt: string | null
  ): RecordingRules => ({
    storeRecordings: false,
    announcementRequired: true,
    excludeBankNumbers: true,
    retentionDays,
    retentionConfirmedAt,
    missedCallDueMinutes: 30,
    mandatoryDisposition: false,
    missedCallWhatsappDraft: true,
  });

  it('counts a period nobody confirmed as none', () => {
    expect(enforcedRetention(rules(30, AT))).toBe(30);
    expect(enforcedRetention(rules(30, null))).toBeNull();
    expect(enforcedRetention(rules(null, null))).toBeNull();
  });

  it('sends the period only when it changed, or to start one not enforced yet', () => {
    expect(sendsRetention(rules(30, AT), 30)).toBe(false);
    expect(sendsRetention(rules(null, null), null)).toBe(false);
    expect(sendsRetention(rules(30, AT), 90)).toBe(true);
    expect(sendsRetention(rules(30, AT), null)).toBe(true);
    expect(sendsRetention(rules(null, null), 30)).toBe(true);
    expect(sendsRetention(rules(30, null), 30)).toBe(true);
  });

  it('never resends the loaded period, which another admin may have changed since', () => {
    // Loaded 30; another admin has since saved 3650; this one only
    // switches storing back on.
    const body = rulesBody({ ...rules(30, AT), storeRecordings: true }, 30, 45);
    expect(body).toEqual({
      storeRecordings: true,
      announcementRequired: true,
      excludeBankNumbers: true,
      mandatoryDisposition: false,
      missedCallWhatsappDraft: true,
      missedCallDueMinutes: 45,
    });
  });

  it('carries the confirmation only with the very period confirmed', () => {
    expect(rulesBody(rules(90, AT), 30, 30)).toMatchObject({
      retentionDays: 30,
    });
    expect(rulesBody(rules(90, AT), 30, 30)).not.toHaveProperty(
      'confirmRetentionDays'
    );
    expect(rulesBody(rules(90, AT), 30, 30, 20)).not.toHaveProperty(
      'confirmRetentionDays'
    );
    expect(rulesBody(rules(90, AT), 30, 30, 30)).toMatchObject({
      retentionDays: 30,
      confirmRetentionDays: 30,
    });
    expect(rulesBody(rules(30, null), 30, 30, 30)).toMatchObject({
      retentionDays: 30,
      confirmRetentionDays: 30,
    });
    const cleared = rulesBody(rules(30, AT), null, 30);
    expect(cleared.retentionDays).toBeNull();
    expect(cleared).not.toHaveProperty('confirmRetentionDays');
  });
});
