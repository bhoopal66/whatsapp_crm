import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

import en from '../../../../messages/en.json';
import ko from '../../../../messages/ko.json';
import {
  PBX_AUTH_BACKOFF_MINUTES,
  PBX_CONNECTION_REFRESH_MS,
  PBX_SILENCE_MINUTES,
  applyExtensionPatch,
  baseUrlHost,
  canEditExtension,
  connectionRefreshDue,
  connectionState,
  extensionState,
  lastEventAgo,
  parseDueMinutes,
  enforcedRetention,
  eventLinkHealth,
  lastBackfillView,
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

describe('eventLinkHealth', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const quiet = PBX_SILENCE_MINUTES * 60_000;

  it('says nothing has arrived when no event ever did', () => {
    expect(eventLinkHealth(null, now)).toEqual({
      state: 'none',
      tone: 'muted',
      ago: null,
    });
    expect(eventLinkHealth('not a date', now).state).toBe('none');
  });

  it('is live until the silence threshold, quiet from it on', () => {
    expect(eventLinkHealth(ago(5_000), now)).toEqual({
      state: 'live',
      tone: 'green',
      ago: { unit: 's', count: 5 },
    });
    expect(eventLinkHealth(ago(quiet - 1_000), now).state).toBe('live');
    expect(eventLinkHealth(ago(quiet), now)).toEqual({
      state: 'quiet',
      tone: 'amber',
      ago: { unit: 'min', count: PBX_SILENCE_MINUTES },
    });
    expect(eventLinkHealth(ago(3 * 86_400_000), now).state).toBe('quiet');
    // A future stamp (clock skew) is live, not quiet.
    expect(eventLinkHealth(ago(-60_000), now).state).toBe('live');
  });

  it('takes another threshold', () => {
    expect(eventLinkHealth(ago(120_000), now, 2).state).toBe('quiet');
    expect(eventLinkHealth(ago(119_000), now, 2).state).toBe('live');
  });
});

describe('lastBackfillView', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const at = new Date(now.getTime() - 2 * 3_600_000).toISOString();

  it('is null when the gateway never filled a gap', () => {
    expect(lastBackfillView(null, null, now)).toBeNull();
    expect(lastBackfillView('garbage', { ingested: 3 }, now)).toBeNull();
  });

  it('states when, and how many calls were added', () => {
    expect(
      lastBackfillView(at, { records: 5, ingested: 3, duplicates: 2 }, now)
    ).toEqual({ ago: { unit: 'h', count: 2 }, added: 3, failed: 0 });
    expect(lastBackfillView(at, { records: 0, ingested: 0 }, now)).toEqual({
      ago: { unit: 'h', count: 2 },
      added: 0,
      failed: 0,
    });
  });

  it('carries the calls it could not add', () => {
    expect(
      lastBackfillView(at, { records: 5, ingested: 0, failed: 5 }, now)
    ).toEqual({ ago: { unit: 'h', count: 2 }, added: 0, failed: 5 });
    expect(
      lastBackfillView(at, { records: 6, ingested: 4, failed: 2 }, now)
    ).toEqual({ ago: { unit: 'h', count: 2 }, added: 4, failed: 2 });
  });

  it('reads a malformed summary as nothing added', () => {
    for (const summary of [
      null,
      [],
      'x',
      { ingested: '3' },
      { ingested: -1 },
      { ingested: 1.5 },
    ]) {
      expect(lastBackfillView(at, summary, now)?.added).toBe(0);
    }
    for (const failed of ['2', -1, 1.5, null, undefined]) {
      expect(lastBackfillView(at, { failed }, now)?.failed).toBe(0);
    }
  });

  describe('as the Events card words it', () => {
    const translate = {
      en: createTranslator({
        locale: 'en',
        messages: en,
        namespace: 'Settings.phoneSystem.events',
      }),
      ko: createTranslator({
        locale: 'ko',
        messages: ko,
        namespace: 'Settings.phoneSystem.events',
      }),
    };
    const text = (locale: 'en' | 'ko', summary: unknown) => {
      const t = translate[locale];
      const view = lastBackfillView(at, summary, now)!;
      return t('backfill', {
        ago: t('ago', view.ago),
        count: view.added,
        failed: view.failed,
      });
    };
    const head = 'Last gap filled from call records: 2 h ago';

    it('says nothing was missing only when nothing was added or failed', () => {
      expect(text('en', { records: 0, ingested: 0, failed: 0 })).toBe(
        `${head} · nothing was missing`
      );
      expect(text('ko', { records: 0, ingested: 0 })).toContain(
        '누락된 통화 없음'
      );
    });

    it('states the calls added', () => {
      expect(text('en', { ingested: 1 })).toBe(`${head} · 1 call added`);
      expect(text('en', { ingested: 3, failed: 0 })).toBe(
        `${head} · 3 calls added`
      );
    });

    it('states the calls that could not be added, never "nothing was missing"', () => {
      expect(text('en', { records: 5, ingested: 0, failed: 5 })).toBe(
        `${head} · 5 calls could not be added`
      );
      expect(text('en', { records: 1, ingested: 0, failed: 1 })).toBe(
        `${head} · 1 call could not be added`
      );
      const ko5 = text('ko', { records: 5, ingested: 0, failed: 5 });
      expect(ko5).toContain('5');
      expect(ko5).toContain('실패');
      expect(ko5).not.toContain('누락된 통화 없음');
    });

    it('states both when some were added and some were not', () => {
      expect(text('en', { records: 6, ingested: 4, failed: 2 })).toBe(
        `${head} · 4 calls added · 2 calls could not be added`
      );
      const both = text('ko', { records: 6, ingested: 4, failed: 2 });
      expect(both).toContain('4');
      expect(both).toContain('2');
      expect(both).toContain('실패');
    });
  });
});

describe('connectionRefreshDue', () => {
  const t0 = Date.parse('2026-10-12T10:00:00Z');
  const due = (over: Partial<Parameters<typeof connectionRefreshDue>[0]>) =>
    connectionRefreshDue({ lastReadAt: t0, now: t0, visible: true, ...over });

  it('re-reads once the last read is a minute old, not before', () => {
    expect(PBX_CONNECTION_REFRESH_MS).toBe(60_000);
    expect(due({ now: t0 })).toBe(false);
    expect(due({ now: t0 + 59_999 })).toBe(false);
    expect(due({ now: t0 + 60_000 })).toBe(true);
    expect(due({ now: t0 + 15 * 60_000 })).toBe(true);
  });

  it('reads nothing while the page is hidden, however old the read is', () => {
    expect(due({ now: t0 + 15 * 60_000, visible: false })).toBe(false);
  });

  it('reads nothing while the connection form is open', () => {
    expect(due({ now: t0 + 15 * 60_000, formOpen: true })).toBe(false);
    expect(due({ now: t0 + 15 * 60_000, formOpen: false })).toBe(true);
  });

  it('counts a read stamped after now (the clock moved back) as due', () => {
    expect(due({ lastReadAt: t0 + 3_600_000, now: t0 })).toBe(true);
    expect(due({ lastReadAt: Number.NaN, now: t0 })).toBe(true);
  });

  it('takes another interval', () => {
    expect(due({ now: t0 + 29_000, everyMs: 30_000 })).toBe(false);
    expect(due({ now: t0 + 30_000, everyMs: 30_000 })).toBe(true);
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
