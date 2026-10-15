import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { iceUrlPort, meetingIceServers, usableIceServers } from './turn';
import { MEETING_ICE_SERVERS } from './types';

const CF_ANSWER = {
  iceServers: [
    {
      urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'],
    },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp',
        'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'u',
      credential: 'c',
    },
  ],
};

describe('iceUrlPort', () => {
  it('reads the explicit port, else null', () => {
    expect(iceUrlPort('turn:turn.cloudflare.com:53?transport=udp')).toBe('53');
    expect(iceUrlPort('stun:stun.cloudflare.com:3478')).toBe('3478');
    expect(iceUrlPort('turns:[2001:db8::1]:443?transport=tcp')).toBe('443');
    expect(iceUrlPort('stun:stun.cloudflare.com')).toBeNull();
    expect(iceUrlPort('turn:host53.example')).toBeNull();
  });
});

describe('usableIceServers', () => {
  it('drops every URL on port 53 and keeps the credentials', () => {
    expect(usableIceServers(CF_ANSWER.iceServers)).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      {
        urls: [
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'u',
        credential: 'c',
      },
    ]);
  });

  it('drops an entry left with no URL and malformed entries', () => {
    expect(
      usableIceServers([
        { urls: 'turn:x.example:53' },
        { urls: 7 },
        null,
        { urls: 'stun:y.example' },
      ])
    ).toEqual([{ urls: ['stun:y.example'] }]);
    expect(usableIceServers(undefined)).toEqual([]);
  });
});

describe('meetingIceServers', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('CLOUDFLARE_TURN_KEY_ID', 'key-1');
    vi.stubEnv('CLOUDFLARE_TURN_KEY_API_TOKEN', 'tok-secret');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('asks Cloudflare for 6 h credentials with the bearer token', async () => {
    fetchMock.mockResolvedValue(Response.json(CF_ANSWER, { status: 201 }));
    const servers = await meetingIceServers();
    expect(servers).toHaveLength(2);
    expect(JSON.stringify(servers)).not.toMatch(/:53[?"]/);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key-1/credentials/generate-ice-servers'
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-secret');
    expect(JSON.parse(init.body)).toEqual({ ttl: 21600 });
  });

  it('is STUN only, without a request, when the key is not configured', async () => {
    vi.stubEnv('CLOUDFLARE_TURN_KEY_API_TOKEN', '');
    expect(await meetingIceServers()).toEqual(MEETING_ICE_SERVERS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to STUN on a refusal, a timeout or an empty answer, logging no secret', async () => {
    fetchMock.mockResolvedValueOnce(new Response('no', { status: 401 }));
    expect(await meetingIceServers()).toEqual(MEETING_ICE_SERVERS);
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('t'), { name: 'TimeoutError' })
    );
    expect(await meetingIceServers()).toEqual(MEETING_ICE_SERVERS);
    fetchMock.mockResolvedValueOnce(
      Response.json({ iceServers: [] }, { status: 201 })
    );
    expect(await meetingIceServers()).toEqual(MEETING_ICE_SERVERS);
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[] } }).mock.calls
    );
    expect(logged).not.toContain('tok-secret');
  });
});
