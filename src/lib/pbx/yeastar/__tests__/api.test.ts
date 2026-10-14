import { describe, it, expect } from 'vitest';
import * as barrel from '..';
import { YeastarError } from '../errors';
import {
  BASE,
  CALL_QUERY_OK,
  CDR_SEARCH_OK,
  DIAL_OK,
  DOWNLOAD_OK,
  EXTENSION_LIST_OK,
  endpointOf,
  setup,
} from './fixtures';

const OK = { errcode: 0, errmsg: 'SUCCESS', call_id: '1648627871.65' };

describe('call control', () => {
  it('dial: POST call/dial with the documented body, returns the call id', async () => {
    const { api, calls } = setup(() => DIAL_OK);
    const out = await api.dial({
      caller: '1005',
      callee: '5503301',
      dialPermission: '2002',
      autoAnswer: true,
    });
    expect(out).toEqual({ callId: '1650095575.872' });
    expect(calls).toHaveLength(1);
    expect(endpointOf(calls[0])).toBe('call/dial');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.searchParams.get('access_token')).toBe('main-token');
    expect(calls[0].body).toEqual({
      caller: '1005',
      callee: '5503301',
      dial_permission: '2002',
      auto_answer: 'yes',
    });
  });

  it('dial: optional fields are omitted, autoAnswer false is sent as "no"', async () => {
    const { api, calls } = setup(() => DIAL_OK);
    await api.dial({ caller: '1005', callee: '2000' });
    await api.dial({ caller: '1005', callee: '2000', autoAnswer: false });
    expect(calls[0].body).toEqual({ caller: '1005', callee: '2000' });
    expect(calls[1].body).toEqual({
      caller: '1005',
      callee: '2000',
      auto_answer: 'no',
    });
  });

  it('dial: a success without call_id is an invalid response', async () => {
    const { api } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await expect(api.dial({ caller: '1', callee: '2' })).rejects.toMatchObject({
      errcode: null,
      errmsg: 'INVALID RESPONSE',
      endpoint: 'call/dial',
    });
  });

  it('dial: a PBX failure surfaces as YeastarError', async () => {
    const { api } = setup(() => ({
      errcode: 70123,
      errmsg: 'API UNAVAILABLE',
    }));
    const err = await api
      .dial({ caller: '1', callee: '2' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YeastarError);
    expect(err).toMatchObject({ isFeatureDisabled: true });
  });

  it.each([
    ['hangup', 'call/hangup'],
    ['hold', 'call/hold'],
    ['unhold', 'call/unhold'],
    ['mute', 'call/mute'],
    ['unmute', 'call/unmute'],
  ] as const)('%s: POST %s with channel_id', async (method, endpoint) => {
    const { api, calls } = setup(() => OK);
    await expect(
      api[method]({ channelId: 'PJSIP/1005-00000023' })
    ).resolves.toBeUndefined();
    expect(endpointOf(calls[0])).toBe(endpoint);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ channel_id: 'PJSIP/1005-00000023' });
  });

  it('transfer: blind, attended start and attended complete bodies', async () => {
    const { api, calls } = setup(() => OK);
    await api.transfer({
      type: 'blind',
      channelId: 'PJSIP/2000-000000ae',
      number: '2008',
    });
    await api.transfer({
      type: 'attended',
      channelId: 'PJSIP/2005-000000a6',
      number: '5503301',
      dialPermission: '2005',
    });
    await api.transfer({
      type: 'attended',
      channelId: 'PJSIP/2005-000000a6',
      attendedOperate: 'complete',
    });
    expect(calls.map(endpointOf)).toEqual(Array(3).fill('call/transfer'));
    expect(calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(calls.map((c) => c.body)).toEqual([
      { type: 'blind', channel_id: 'PJSIP/2000-000000ae', number: '2008' },
      {
        type: 'attended',
        channel_id: 'PJSIP/2005-000000a6',
        number: '5503301',
        dial_permission: '2005',
      },
      {
        type: 'attended',
        channel_id: 'PJSIP/2005-000000a6',
        attended_operate: 'complete',
      },
    ]);
  });
});

describe('queryCalls', () => {
  it('sends exactly one selector as a GET query', async () => {
    const { api, calls } = setup(() => CALL_QUERY_OK);
    await api.queryCalls({ callId: '1650012665.266' });
    await api.queryCalls({ type: 'inbound' });
    await api.queryCalls({ extension: '2000' });
    expect(calls.every((c) => endpointOf(c) === 'call/query')).toBe(true);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.body === undefined)).toBe(true);
    const params = calls.map((c) => {
      const p = Object.fromEntries(c.url.searchParams);
      delete p.access_token;
      return p;
    });
    expect(params).toEqual([
      { call_id: '1650012665.266' },
      { type: 'inbound' },
      { extension: '2000' },
    ]);
  });

  it('refuses zero or several selectors without calling the PBX', async () => {
    const { api, calls } = setup(() => CALL_QUERY_OK);
    const bad = [{}, { callId: '1', extension: '2000' }] as never[];
    for (const q of bad) {
      await expect(api.queryCalls(q)).rejects.toBeInstanceOf(TypeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('normalises extension and outbound members from the docs example', async () => {
    const { api } = setup(() => CALL_QUERY_OK);
    expect(await api.queryCalls({ callId: '1650012665.266' })).toEqual([
      {
        callId: '1650012665.266',
        members: [
          {
            kind: 'extension',
            channelId: 'PJSIP/2000-0000008a',
            status: 'ANSWERED',
            number: '2000',
          },
          {
            kind: 'outbound',
            channelId: 'PJSIP/trunk-test-peer-trunking-endpoint-0000008b',
            status: 'ANSWER',
            from: '2000',
            to: '1003',
            trunkName: 'test-peer-trunking',
          },
        ],
      },
    ]);
  });

  it('normalises an inbound member, keeps a real call_path, drops legs without a channel', async () => {
    const { api } = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      data: [
        {
          call_id: '1650012700.1',
          members: [
            {
              inbound: {
                from: '0501234567',
                to: '6400',
                trunk_name: 'etisalat',
                channel_id: 'PJSIP/trunk-etisalat-endpoint-00000001',
                member_status: 'RING',
                call_path: '6400',
              },
            },
            { extension: { number: '2000', member_status: 'RING' } },
          ],
        },
        { members: [] },
      ],
    }));
    expect(await api.queryCalls({ type: 'inbound' })).toEqual([
      {
        callId: '1650012700.1',
        members: [
          {
            kind: 'inbound',
            channelId: 'PJSIP/trunk-etisalat-endpoint-00000001',
            status: 'RING',
            callPath: '6400',
            from: '0501234567',
            to: '6400',
            trunkName: 'etisalat',
          },
        ],
      },
    ]);
  });

  it('no calls in progress: data may be absent or empty', async () => {
    const absent = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    expect(await absent.api.queryCalls({ extension: '2000' })).toEqual([]);
    const empty = setup(() => ({ errcode: 0, errmsg: 'SUCCESS', data: [] }));
    expect(await empty.api.queryCalls({ extension: '2000' })).toEqual([]);
  });
});

describe('listExtensions', () => {
  it('GETs extension/list with page and page_size and parses the docs example', async () => {
    const { api, calls } = setup(() => EXTENSION_LIST_OK);
    const out = await api.listExtensions({ page: 1, pageSize: 4 });
    expect(endpointOf(calls[0])).toBe('extension/list');
    expect(calls[0].method).toBe('GET');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      page: '1',
      page_size: '4',
      access_token: 'main-token',
    });
    expect(out.total).toBe(12);
    expect(out.items).toHaveLength(4);
    expect(out.items[0]).toEqual({
      id: 238,
      number: '2000',
      callerIdName: 'Leo Ball',
      email: 'leo@sample.com',
      presenceStatus: 'available',
      online: {
        sipPhone: true,
        linkusDesktop: false,
        linkusMobile: false,
        linkusWeb: false,
      },
    });
  });

  it('reads SIP state from status_list, never from the top-level status', async () => {
    const { api } = setup(() => EXTENSION_LIST_OK);
    const { items } = await api.listExtensions();
    // 2000: top-level status 0, status_list[0].status 1 -> online.
    expect(items[0].online.sipPhone).toBe(true);
    expect(items.slice(1).map((e) => e.online.sipPhone)).toEqual([
      false,
      false,
      false,
    ]);
    const lonely = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      total_number: 1,
      data: [
        {
          number: '2010',
          caller_id_name: 'X',
          online_status: {
            sip_phone: { status: 1, status_list: [{ status: 0, ip: 'a:1' }] },
          },
        },
      ],
    }));
    expect((await lonely.api.listExtensions()).items[0].online.sipPhone).toBe(
      false
    );
  });

  it('flags each Linkus client from its own status', async () => {
    const { api } = setup(() => EXTENSION_LIST_OK);
    const { items } = await api.listExtensions();
    expect(items.map((e) => e.online)).toEqual([
      {
        sipPhone: true,
        linkusDesktop: false,
        linkusMobile: false,
        linkusWeb: false,
      },
      {
        sipPhone: false,
        linkusDesktop: true,
        linkusMobile: false,
        linkusWeb: false,
      },
      {
        sipPhone: false,
        linkusDesktop: false,
        linkusMobile: true,
        linkusWeb: false,
      },
      {
        sipPhone: false,
        linkusDesktop: false,
        linkusMobile: false,
        linkusWeb: true,
      },
    ]);
    expect(items.map((e) => e.presenceStatus)).toEqual([
      'available',
      'away',
      'business_trip',
      'do_not_disturb',
    ]);
  });

  it('omits empty optional fields, skips rows without a number, requires total_number', async () => {
    const { api } = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      total_number: 2,
      data: [
        { number: '2020', caller_id_name: 'No Mail', email_addr: '' },
        { caller_id_name: 'Ghost' },
        'junk',
      ],
    }));
    const out = await api.listExtensions();
    expect(out.items).toEqual([
      {
        number: '2020',
        callerIdName: 'No Mail',
        online: {
          sipPhone: false,
          linkusDesktop: false,
          linkusMobile: false,
          linkusWeb: false,
        },
      },
    ]);
    const missing = setup(() => ({ errcode: 0, errmsg: 'SUCCESS', data: [] }));
    await expect(missing.api.listExtensions()).rejects.toMatchObject({
      errmsg: 'INVALID RESPONSE',
    });
  });
});

describe('findExtension', () => {
  const ext = (id: unknown, number: string) => ({
    id,
    number,
    caller_id_name: number,
    online_status: {},
  });

  it('GETs extension/search for the number and returns the exact match with its id', async () => {
    const { api, calls } = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      total_number: 3,
      data: [ext(301, '1200'), ext(302, '2000'), ext(238, '200')],
    }));
    const out = await api.findExtension('200');
    expect(out).toMatchObject({ id: 238, number: '200' });
    expect(calls).toHaveLength(1);
    expect(endpointOf(calls[0])).toBe('extension/search');
    expect(calls[0].method).toBe('GET');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      search_value: '200',
      page: '1',
      page_size: '100',
      access_token: 'main-token',
    });
  });

  it('pages on until the exact number, and answers null when it is absent', async () => {
    const page = (n: string) => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      total_number: 150,
      data:
        n === '1'
          ? Array.from({ length: 100 }, (_, i) => ext(i + 1, `20${i}0`))
          : [ext('7', '20'), ext(777, '20')],
    });
    const { api, calls } = setup((c) => page(c.url.searchParams.get('page')!));
    // A non-integer id is no id: the second row on page 2 is the match.
    expect(await api.findExtension('20')).toMatchObject({ id: 777 });
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual([
      '1',
      '2',
    ]);
    const none = setup((c) => page(c.url.searchParams.get('page')!));
    expect(await none.api.findExtension('999')).toBeNull();
    expect(none.calls).toHaveLength(2);
    const empty = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    expect(await empty.api.findExtension('201')).toBeNull();
  });
});

describe('setPresence', () => {
  it('POSTs extension/update with the PBX id and presence_status only', async () => {
    const { api, calls } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await api.setPresence({ id: 238, status: 'do_not_disturb' });
    expect(endpointOf(calls[0])).toBe('extension/update');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      id: 238,
      presence_status: 'do_not_disturb',
    });
  });

  it('lets a PBX refusal through as YeastarError', async () => {
    const { api } = setup(() => ({ errcode: 10002, errmsg: 'FAILURE' }));
    await expect(
      api.setPresence({ id: 238, status: 'away' })
    ).rejects.toBeInstanceOf(YeastarError);
  });
});

describe('searchCdr', () => {
  const startTime = new Date('2025-12-19T10:40:00.000Z');
  const endTime = new Date('2025-12-19T10:45:00.999Z');

  it('sends the window as Unix seconds, with paging', async () => {
    const { api, calls } = setup(() => CDR_SEARCH_OK);
    await api.searchCdr({ startTime, endTime, page: 2, pageSize: 500 });
    expect(endpointOf(calls[0])).toBe('cdr/search');
    expect(calls[0].method).toBe('GET');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      start_time: '1766140800',
      end_time: '1766141100',
      page: '2',
      page_size: '500',
      access_token: 'main-token',
    });
  });

  it('omits paging when not given and returns total and the raw records', async () => {
    const { api, calls } = setup(() => CDR_SEARCH_OK);
    const out = await api.searchCdr({ startTime, endTime });
    expect(calls[0].url.searchParams.has('page')).toBe(false);
    expect(calls[0].url.searchParams.has('page_size')).toBe(false);
    expect(out.total).toBe(3);
    expect(out.records).toEqual(CDR_SEARCH_OK.data);
    // New and legacy rows both survive untouched.
    expect(out.records[0]).toHaveProperty('new_id', '66CD1EAE-AF80033C');
    expect(out.records[2]).toMatchObject({
      id: 2710,
      reason: 'src hangup    ',
    });
  });

  it('rejects out-of-range input before calling the PBX', async () => {
    const { api, calls } = setup(() => CDR_SEARCH_OK);
    await expect(
      api.searchCdr({ startTime: new Date('nope'), endTime })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      api.searchCdr({ startTime, endTime, pageSize: 10_001 })
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      api.searchCdr({ startTime, endTime, page: 0 })
    ).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
    await api.searchCdr({ startTime, endTime, pageSize: 10_000 });
    expect(calls).toHaveLength(1);
  });
});

describe('recordingDownloadUrl', () => {
  const route = (c: { url: URL }) =>
    c.url.pathname.endsWith('/recording/download')
      ? DOWNLOAD_OK
      : { errcode: 0 };

  it('asks by id, then returns base + path with one slash and the token', async () => {
    const { api, calls } = setup(route);
    const url = await api.recordingDownloadUrl({ id: 1727 });
    expect(endpointOf(calls[0])).toBe('recording/download');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.searchParams.get('id')).toBe('1727');
    expect(calls[0].url.searchParams.has('file')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(url).toBe(
      `${BASE}/api/download/Recording-X.7.0.6-1-download-20220412175901-M8zB66xYUNTNMr2D.wav?access_token=main-token`
    );
    expect(url.replace('https://', '')).not.toContain('//');
  });

  it('asks by file name, and a base URL with a trailing slash still gives one slash', async () => {
    const { api, calls } = setup(route, `${BASE}/`);
    const url = await api.recordingDownloadUrl({ file: 'a.wav' });
    expect(calls[0].url.searchParams.get('file')).toBe('a.wav');
    expect(url.startsWith(`${BASE}/api/download/`)).toBe(true);
    expect(url.replace('https://', '')).not.toContain('//');
  });

  it('needs exactly one of id or file, and a download path in the answer', async () => {
    const { api, calls } = setup(route);
    for (const ref of [{}, { id: 1, file: 'a.wav' }] as never[]) {
      await expect(api.recordingDownloadUrl(ref)).rejects.toBeInstanceOf(
        TypeError
      );
    }
    expect(calls).toHaveLength(0);
    const bare = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      file: 'a.wav',
    }));
    await expect(
      bare.api.recordingDownloadUrl({ id: 1 })
    ).rejects.toMatchObject({
      errmsg: 'INVALID RESPONSE',
    });
  });
});

describe('testConnection', () => {
  it('lists one extension and reports the total', async () => {
    const { api, calls } = setup(() => EXTENSION_LIST_OK);
    await expect(api.testConnection()).resolves.toEqual({
      ok: true,
      extensionCount: 12,
    });
    expect(endpointOf(calls[0])).toBe('extension/list');
    expect(calls[0].url.searchParams.get('page')).toBe('1');
    expect(calls[0].url.searchParams.get('page_size')).toBe('1');
  });

  it('lets a PBX refusal through as YeastarError', async () => {
    const { api } = setup(() => ({
      errcode: 70656,
      errmsg: 'API FUNCTION IS NOT ENABLED',
    }));
    await expect(api.testConnection()).rejects.toMatchObject({
      isFeatureDisabled: true,
    });
  });
});

describe('barrel', () => {
  it('exposes the public runtime surface', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'CDR_MAX_PAGE_SIZE',
        'DEFAULT_PBX_TIME_ZONE',
        'DEFAULT_TOPICS',
        'HEARTBEAT',
        'HEARTBEAT_INTERVAL_MS',
        'MemoryTokenCache',
        'YEASTAR_EVENT',
        'YeastarError',
        'cdrRecordToCallEnd',
        'createSdkSignature',
        'createTokenManager',
        'createYeastarApi',
        'createYeastarClient',
        'dedupeByUid',
        'isHeartbeatReply',
        'isMissedCallEnd',
        'nextBackoffMs',
        'parsePbxTime',
        'parseSubscribeReply',
        'parseYeastarEvent',
        'remoteParty',
        'ringingExtensions',
        'subscribeMessage',
        'verifyYeastarWebhookSignature',
        'wsUrl',
      ].sort()
    );
  });
});

describe('voicemail', () => {
  // The docs' vm/get example (a group box; an extension's has no
  // group_voicemail_read_status), plus an unread message and junk.
  const VM_LIST_OK = {
    errcode: 0,
    errmsg: 'SUCCESS',
    total_number: 3,
    data: [
      {
        msg_id: '1713840555-00000623',
        file_name: 'msg0000.wav',
        is_read: 1,
        duration: 18,
        size: 290604,
        group_voicemail_read_status: null,
        name: 'John(Customer Example)',
        time: '2024/04/23 10:49:15',
        number: '5503301',
        uid: '20260120102710672A5',
      },
      {
        msg_id: '1713840600-00000624',
        file_name: 'msg0001.wav',
        is_read: 0,
        duration: 7,
        name: '',
        time: '2024/04/23 11:00:00',
        number: '0501234567',
      },
      { file_name: 'no-id.wav' },
    ],
  };

  it('lists one extension’s box with page and page_size', async () => {
    const { api, calls } = setup(() => VM_LIST_OK);
    const list = await api.listVoicemail({
      number: '201',
      page: 1,
      pageSize: 100,
    });
    expect(endpointOf(calls[0])).toBe('vm/get');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.searchParams.get('number')).toBe('201');
    expect(calls[0].url.searchParams.get('page')).toBe('1');
    expect(calls[0].url.searchParams.get('page_size')).toBe('100');
    expect(list.total).toBe(3);
    expect(list.items).toEqual([
      {
        msgId: '1713840555-00000623',
        fileName: 'msg0000.wav',
        read: true,
        callerName: 'John(Customer Example)',
        callerNumber: '5503301',
        time: '2024/04/23 10:49:15',
        durationSeconds: 18,
      },
      {
        msgId: '1713840600-00000624',
        fileName: 'msg0001.wav',
        read: false,
        callerName: '',
        callerNumber: '0501234567',
        time: '2024/04/23 11:00:00',
        durationSeconds: 7,
      },
    ]);
  });

  it('reads an empty box with no data or total', async () => {
    const { api } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await expect(api.listVoicemail({ number: '201' })).resolves.toEqual({
      total: 0,
      items: [],
    });
  });

  it('downloads by msg_id: base + path + token', async () => {
    const { api, calls } = setup(() => ({
      errcode: 0,
      errmsg: 'SUCCESS',
      file: 'PBX-Voicemail-download-1.wav',
      download_resource_url: '/api/download/PBX-Voicemail-download-1.wav',
    }));
    const url = await api.voicemailDownloadUrl({
      msgId: '1713033769-00000619',
    });
    expect(endpointOf(calls[0])).toBe('vm/download');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.searchParams.get('msg_id')).toBe('1713033769-00000619');
    expect(url).toBe(
      `${BASE}/api/download/PBX-Voicemail-download-1.wav?access_token=main-token`
    );
  });

  it('needs a download path in the answer', async () => {
    const { api } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await expect(
      api.voicemailDownloadUrl({ msgId: 'm-1' })
    ).rejects.toMatchObject({ errmsg: 'INVALID RESPONSE' });
  });

  it('marks read with POST vm/update { id, vm_status: 1 }', async () => {
    const { api, calls } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await api.markVoicemailRead({ msgId: 'm-1' });
    expect(endpointOf(calls[0])).toBe('vm/update');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ id: 'm-1', vm_status: 1 });
  });

  it('deletes with GET vm/delete?id=', async () => {
    const { api, calls } = setup(() => ({ errcode: 0, errmsg: 'SUCCESS' }));
    await api.deleteVoicemail({ msgId: 'm-1' });
    expect(endpointOf(calls[0])).toBe('vm/delete');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.searchParams.get('id')).toBe('m-1');
  });

  it('refuses an empty id or number before calling the PBX', async () => {
    const { api, calls } = setup(() => ({ errcode: 0 }));
    await expect(api.listVoicemail({ number: '' })).rejects.toBeInstanceOf(
      TypeError
    );
    for (const call of [
      api.voicemailDownloadUrl,
      api.markVoicemailRead,
      api.deleteVoicemail,
    ])
      await expect(call({ msgId: '' })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('lets a PBX refusal through as YeastarError', async () => {
    const { api } = setup(() => ({ errcode: 10002, errmsg: 'FAILURE' }));
    await expect(api.deleteVoicemail({ msgId: 'm-1' })).rejects.toBeInstanceOf(
      YeastarError
    );
  });
});
