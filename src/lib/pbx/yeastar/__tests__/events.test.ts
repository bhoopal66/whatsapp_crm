import { describe, expect, it } from 'vitest';
import {
  isMissedCallEnd,
  parsePbxTime,
  parseYeastarEvent,
  remoteParty,
  ringingExtensions,
  type CallEndEvent,
  type CallStateEvent,
} from '../events';

// The docs' examples (Cloud Edition developer guide). Most print `msg` as
// "{"extension":...}": a quoted string with unescaped inner quotes, which
// is not valid JSON. Each fixture keeps the doc's inner text and is sent
// both ways: properly escaped as a JSON string, and as a nested object.
const MSG_30007 =
  '{"extension":"2010","kind":"Mobile","status":"Registered","registered_ip":"223.104.45.163"}';
const MSG_30007B =
  '{"extension":"2008","kind":"Web","status":"Unregistered","registered_ip":"192.168.5.53"}';
const MSG_30008 = '{"extension":"2002","status":"Ringing"}';
const MSG_30009 = '{"extension":"2005","status":"business_trip"}';
const MSG_30011 = `
     {
         "call_id":"1648801160.110",
         "members":
          [
            {"extension":
               {
                  "number":"2002",
                  "channel_id":"PJSIP/2002-0000004f",
                  "member_status":"ANSWERED",
                  "call_path":" "
                 }
              },
              {"outbound":
                {
                   "from":"2002",
                   "to":"5503301",
                   "trunk_name":"peer-to-41",
                   "channel_id":"PJSIP/trunk-peer-to-41-endpoint-00000050",
                   "member_status":"ANSWER",
                   "call_path":" "
                 }
               }
           ]
        }`;
// 30012 is printed as a real object, valid JSON as shipped.
const EVENT_30012 = {
  type: 30012,
  sn: '3631A2124XXX',
  msg: {
    call_id: '1780625997.105',
    time_start: '2026-06-05 10:19:57',
    call_from: '1002',
    call_to: '1000',
    call_duration: 15,
    talk_duration: 10,
    src_trunk_name: '',
    dst_trunk_name: '',
    pin_code: '',
    status: 'ANSWERED',
    type: 'Internal',
    recording: '',
    did_number: '',
    did_name: '',
    agent_ring_time: 0,
    uid: '202606051019574F506',
    call_note_id: '20260605101957-AACE5',
    enb_call_note: 2,
    is_display: 1,
  },
};

const frame = (type: number, msg: string, asString: boolean) =>
  JSON.stringify({
    type,
    sn: '3631A2124XXX',
    msg: asString ? msg : JSON.parse(msg),
  });

const ok = (input: string | object) => {
  const r = parseYeastarEvent(input);
  if (!r.ok) throw new Error(r.error);
  return r.event;
};

describe.each([
  ['msg as a JSON string', true],
  ['msg as an object', false],
])('parseYeastarEvent, %s', (_label, asString) => {
  it('30007 registration, kind as client', () => {
    expect(ok(frame(30007, MSG_30007, asString))).toEqual({
      kind: 'registration',
      type: 30007,
      sn: '3631A2124XXX',
      extension: '2010',
      status: 'registered',
      client: 'mobile',
      registeredIp: '223.104.45.163',
    });
    expect(ok(frame(30007, MSG_30007B, asString))).toMatchObject({
      status: 'unregistered',
      client: 'web',
    });
    const pad = MSG_30007.replace('Mobile', 'Pad');
    expect(ok(frame(30007, pad, asString))).toMatchObject({ client: 'pad' });
    const later = MSG_30007.replace('Mobile', 'Watch');
    expect(ok(frame(30007, later, asString))).toMatchObject({
      client: 'other',
    });
  });

  it('30008 extension call state', () => {
    expect(ok(frame(30008, MSG_30008, asString))).toEqual({
      kind: 'extension_call_state',
      type: 30008,
      sn: '3631A2124XXX',
      extension: '2002',
      status: 'ringing',
    });
  });

  it('30009 presence', () => {
    expect(ok(frame(30009, MSG_30009, asString))).toEqual({
      kind: 'presence',
      type: 30009,
      sn: '3631A2124XXX',
      extension: '2005',
      presence: 'business_trip',
    });
  });

  it('30011 call state: members normalised, a blank call_path is none', () => {
    expect(ok(frame(30011, MSG_30011, asString))).toEqual({
      kind: 'call_state',
      type: 30011,
      sn: '3631A2124XXX',
      callId: '1648801160.110',
      members: [
        {
          kind: 'extension',
          number: '2002',
          channelId: 'PJSIP/2002-0000004f',
          status: 'ANSWERED',
        },
        {
          kind: 'outbound',
          from: '2002',
          to: '5503301',
          trunkName: 'peer-to-41',
          channelId: 'PJSIP/trunk-peer-to-41-endpoint-00000050',
          status: 'ANSWER',
        },
      ],
    });
  });

  it('30012 call end', () => {
    const msg = JSON.stringify(EVENT_30012.msg);
    const event = ok(frame(30012, msg, asString)) as CallEndEvent;
    expect(event).toEqual({
      kind: 'call_end',
      type: 30012,
      sn: '3631A2124XXX',
      callId: '1780625997.105',
      uid: '202606051019574F506',
      direction: 'internal',
      from: '1002',
      to: '1000',
      startedAt: '2026-06-05T06:19:57.000Z',
      startedAtRaw: '2026-06-05 10:19:57',
      callSeconds: 15,
      talkSeconds: 10,
      status: 'ANSWERED',
      raw: EVENT_30012.msg,
    });
  });
});

describe('parseYeastarEvent edges', () => {
  it('accepts the 30012 doc example as an object and a string-typed type', () => {
    expect(ok(EVENT_30012)).toMatchObject({
      kind: 'call_end',
      uid: '202606051019574F506',
    });
    expect(ok({ ...EVENT_30012, type: '30012' })).toMatchObject({
      kind: 'call_end',
    });
  });

  it('keeps an undocumented event type as unknown', () => {
    const raw = { type: 30022, msg: '{"x":1}' };
    expect(ok(raw)).toEqual({ kind: 'unknown', type: 30022, raw });
  });

  it('recognises the webhook connectivity test', () => {
    expect(
      ok('{"event":"test","message":"This is a webhook connectivity test."}')
    ).toEqual({
      kind: 'webhook_test',
      message: 'This is a webhook connectivity test.',
    });
  });

  it.each([
    ['heartbeat reply', 'heartbeat response'],
    ['truncated JSON', '{"type":30008,'],
    ['an array', '[]'],
    ['null', 'null'],
    ['the subscribe ack', '{"errcode":0,"errmsg":"SUCCESS"}'],
    ['no type', { msg: MSG_30008 }],
    [
      'msg not JSON (the docs printed verbatim)',
      '{"type":30008,"msg":"{"extension":"2002"}"}',
    ],
    ['msg string that is not JSON', { type: 30008, msg: '{"extension":' }],
    ['msg missing', { type: 30008 }],
    ['extension missing', { type: 30008, msg: { status: 'Idle' } }],
    [
      'undocumented status',
      { type: 30008, msg: { extension: '2002', status: 'Away' } },
    ],
    [
      'undocumented presence',
      { type: 30009, msg: { extension: '2002', status: 'gone' } },
    ],
    [
      'undocumented registration',
      { type: 30007, msg: { extension: '2002', kind: 'Sip', status: 'Maybe' } },
    ],
    ['30011 without call_id', { type: 30011, msg: { members: [] } }],
    [
      '30012 without uid',
      { type: 30012, msg: { ...EVENT_30012.msg, uid: '' } },
    ],
    [
      '30012 without call_id',
      { type: 30012, msg: { ...EVENT_30012.msg, call_id: undefined } },
    ],
  ])('%s → ok:false', (_label, input) => {
    const r = parseYeastarEvent(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual(expect.any(String));
  });

  it('never throws on input the types forbid', () => {
    for (const bad of [null, undefined, 42, true]) {
      expect(parseYeastarEvent(bad as unknown as string).ok).toBe(false);
    }
  });

  it('30012: unknown type is a null direction, status upper-cased, optional fields kept', () => {
    const event = ok({
      type: 30012,
      msg: {
        ...EVENT_30012.msg,
        type: 'Transfer',
        status: 'no answer',
        recording: '20260605-1780625997.105-1002-1000.wav',
        did_number: '043001234',
        did_name: 'Sales',
      },
    }) as CallEndEvent;
    expect(event).toMatchObject({
      direction: null,
      status: 'NO ANSWER',
      recordingFile: '20260605-1780625997.105-1002-1000.wav',
      didNumber: '043001234',
      didName: 'Sales',
    });
    expect(event.sn).toBeUndefined();
  });
});

describe('parsePbxTime', () => {
  it('Unix seconds need no zone', () => {
    expect(parsePbxTime(1766112007)).toBe('2025-12-19T02:40:07.000Z');
    expect(parsePbxTime('1766112007')).toBe('2025-12-19T02:40:07.000Z');
  });
  it('display strings are wall time in the PBX zone', () => {
    expect(
      parsePbxTime('2025/12/19 10:40:07', { pbxTimeZone: 'Asia/Shanghai' })
    ).toBe('2025-12-19T02:40:07.000Z');
    expect(
      parsePbxTime('05/30/2022 14:53:41', { pbxTimeZone: 'Asia/Shanghai' })
    ).toBe('2022-05-30T06:53:41.000Z');
    expect(parsePbxTime('2025/12/19 10:40:07 PM')).toBe(
      '2025-12-19T18:40:07.000Z'
    );
    expect(parsePbxTime('2025/12/19 12:05:00 AM')).toBe(
      '2025-12-18T20:05:00.000Z'
    );
    expect(
      parsePbxTime('2026-07-01 12:00:00', { pbxTimeZone: 'Europe/London' })
    ).toBe('2026-07-01T11:00:00.000Z');
  });
  it('day-first only when configured', () => {
    expect(parsePbxTime('05/06/2026 10:00:00')).toBe(
      '2026-05-06T06:00:00.000Z'
    );
    expect(parsePbxTime('05/06/2026 10:00:00', { dateOrder: 'DMY' })).toBe(
      '2026-06-05T06:00:00.000Z'
    );
  });
  it.each([
    ['30/05/2022 14:53:41'],
    ['2026-02-30 10:00:00'],
    ['2026-06-05 24:00:00'],
    ['2026-06-05 13:00:00 PM'],
    ['soon'],
    [''],
    [null],
    [-5],
  ])('%s → null', (v) => expect(parsePbxTime(v)).toBeNull());
  it('an invalid zone is null, not a throw', () => {
    expect(
      parsePbxTime('2026-06-05 10:19:57', { pbxTimeZone: 'Mars/Olympus' })
    ).toBeNull();
  });
});

describe('call helpers', () => {
  const call = (members: CallStateEvent['members']): CallStateEvent => ({
    kind: 'call_state',
    type: 30011,
    callId: '1',
    members,
  });
  const inbound = {
    kind: 'inbound' as const,
    from: '0501234567',
    to: '6400',
    channelId: 'PJSIP/t-1',
    status: 'ANSWERED',
  };

  it('ringingExtensions: extension members in ALERT or RING, once each', () => {
    const c = call([
      inbound,
      { kind: 'extension', number: '2001', channelId: 'a', status: 'RING' },
      { kind: 'extension', number: '2002', channelId: 'b', status: 'ALERT' },
      { kind: 'extension', number: '2001', channelId: 'c', status: 'RING' },
      { kind: 'extension', number: '2003', channelId: 'd', status: 'ANSWER' },
    ]);
    expect(ringingExtensions(c)).toEqual(['2001', '2002']);
  });

  it('remoteParty: the inbound caller first, else the outbound callee', () => {
    const outbound = {
      kind: 'outbound' as const,
      from: '2002',
      to: '5503301',
      channelId: 'o',
      status: 'ANSWER',
    };
    expect(remoteParty(call([outbound, inbound]))).toBe('0501234567');
    expect(remoteParty(call([outbound]))).toBe('5503301');
    expect(
      remoteParty(
        call([
          { kind: 'extension', number: '2001', channelId: 'a', status: 'RING' },
        ])
      )
    ).toBeNull();
  });

  it('isMissedCallEnd: inbound and not answered', () => {
    const end = ok(EVENT_30012) as CallEndEvent;
    for (const status of ['NO ANSWER', 'BUSY', 'ABANDONED', 'VOICEMAIL']) {
      expect(isMissedCallEnd({ ...end, direction: 'inbound', status })).toBe(
        true
      );
      expect(isMissedCallEnd({ ...end, direction: 'outbound', status })).toBe(
        false
      );
    }
    expect(
      isMissedCallEnd({ ...end, direction: 'inbound', status: 'ANSWERED' })
    ).toBe(false);
    expect(
      isMissedCallEnd({ ...end, direction: null, status: 'NO ANSWER' })
    ).toBe(false);
  });
});
