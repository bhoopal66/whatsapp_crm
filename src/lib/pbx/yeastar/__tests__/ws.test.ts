import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOPICS,
  HEARTBEAT,
  HEARTBEAT_INTERVAL_MS,
  isHeartbeatReply,
  nextBackoffMs,
  parseSubscribeReply,
  subscribeMessage,
  wsUrl,
} from '../ws';

describe('WebSocket framing', () => {
  it('subscribe frame matches the documented text', () => {
    expect(subscribeMessage([30011, 30012])).toBe(
      '{"topic_list":[30011,30012]}'
    );
    expect(DEFAULT_TOPICS).toEqual([30007, 30008, 30009, 30011, 30012]);
    expect(subscribeMessage(DEFAULT_TOPICS)).toBe(
      '{"topic_list":[30007,30008,30009,30011,30012]}'
    );
  });

  it('heartbeat is plain text, inside the 60 s idle timeout', () => {
    expect(HEARTBEAT).toBe('heartbeat');
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000);
    expect(isHeartbeatReply('heartbeat response')).toBe(true);
    expect(isHeartbeatReply('heartbeat response\n')).toBe(true);
    expect(isHeartbeatReply('heartbeat')).toBe(false);
    expect(isHeartbeatReply('{"errcode":0,"errmsg":"SUCCESS"}')).toBe(false);
  });

  it('parseSubscribeReply reads the ack and nothing else', () => {
    expect(
      parseSubscribeReply('{ "errcode": 0, "errmsg": "SUCCESS" }')
    ).toEqual({ ok: true, errcode: 0, errmsg: 'SUCCESS' });
    expect(
      parseSubscribeReply('{"errcode":10004,"errmsg":"INVALID PARAMETERS"}')
    ).toMatchObject({ ok: false, errcode: 10004 });
    expect(parseSubscribeReply('heartbeat response')).toBeNull();
    expect(parseSubscribeReply('{"type":30008,"msg":"{}"}')).toBeNull();
  });

  it('nextBackoffMs doubles, caps, and jitters within the upper half', () => {
    const low = () => 0;
    const high = () => 1;
    expect(nextBackoffMs(0, { random: low })).toBe(500);
    expect(nextBackoffMs(0, { random: high })).toBe(1_000);
    expect(nextBackoffMs(3, { random: high })).toBe(8_000);
    expect(nextBackoffMs(50, { random: low })).toBe(30_000);
    expect(nextBackoffMs(5_000, { random: high })).toBe(60_000);
    expect(nextBackoffMs(-1, { random: high })).toBe(1_000);
    expect(nextBackoffMs(Number.NaN, { random: high })).toBe(1_000);
    expect(nextBackoffMs(2, { baseMs: 100, maxMs: 250, random: high })).toBe(
      250
    );
    const v = nextBackoffMs(4);
    expect(v).toBeGreaterThanOrEqual(8_000);
    expect(v).toBeLessThanOrEqual(16_000);
  });

  it('wsUrl swaps the scheme and carries the token', () => {
    expect(
      wsUrl(
        'https://yeastardocs.example.yeastarcloud.com',
        'QJZDwxIAXBoVrUmeyLiHS3zQXrdynAmh'
      )
    ).toBe(
      'wss://yeastardocs.example.yeastarcloud.com/openapi/v1.0/subscribe?access_token=QJZDwxIAXBoVrUmeyLiHS3zQXrdynAmh'
    );
    expect(wsUrl('https://10.0.0.5:8088/', 'a+b/c')).toBe(
      'wss://10.0.0.5:8088/openapi/v1.0/subscribe?access_token=a%2Bb%2Fc'
    );
    expect(wsUrl('http://10.0.0.5', 't')).toBe(
      'ws://10.0.0.5/openapi/v1.0/subscribe?access_token=t'
    );
    expect(() => wsUrl('ftp://pbx', 't')).toThrow(TypeError);
  });
});
