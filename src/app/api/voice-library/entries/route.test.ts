import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadTtsKey: vi.fn(),
  storeVoiceAudio: vi.fn(),
  removeVoiceAudio: vi.fn(),
  voiceTtsLimited: vi.fn(),
  synthesizeSpeech: vi.fn(),
  insertResult: { data: null as unknown, error: null as unknown },
  inserted: [] as unknown[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => adminClient,
}));
vi.mock('@/lib/voice-library/server', () => ({
  loadTtsKey: mocks.loadTtsKey,
  storeVoiceAudio: mocks.storeVoiceAudio,
  removeVoiceAudio: mocks.removeVoiceAudio,
  voiceTtsLimited: mocks.voiceTtsLimited,
}));
vi.mock('@/lib/voice-library/tts', () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

import { POST } from './route';

const ACCOUNT = '11111111-2222-4333-8444-555555555555';

// The caller's own client: the route must not write with it (242 gives
// `authenticated` no INSERT on entries and no write in voice-library/).
const callerClient = {
  from() {
    throw new Error('caller client used for a library write');
  },
};

const adminClient = {
  from() {
    const b: Record<string, unknown> = {};
    b.insert = (row: unknown) => {
      mocks.inserted.push(row);
      return b;
    };
    b.select = () => b;
    b.single = () => Promise.resolve(mocks.insertResult);
    return b;
  },
};

const ogg = () =>
  new Blob([
    new TextEncoder().encode(
      'OggS' + '\0'.repeat(24) + 'OpusHead' + '\0'.repeat(20)
    ),
  ]);

function post(fields: Record<string, string | Blob>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return POST(
    new Request('http://localhost/api/voice-library/entries', {
      method: 'POST',
      body: form,
    })
  );
}

const base = { subject: 'builtin:welcome', language: 'hi', title: 'Hi' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted = [];
  mocks.insertResult = { data: { id: 'row' }, error: null };
  mocks.requireRole.mockResolvedValue({
    supabase: callerClient,
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
  mocks.voiceTtsLimited.mockReturnValue(null);
  mocks.loadTtsKey.mockResolvedValue({ ok: true, apiKey: 'sk-x' });
  mocks.storeVoiceAudio.mockResolvedValue('https://cdn/v.ogg');
  mocks.synthesizeSpeech.mockResolvedValue(new Uint8Array([1]));
});

describe('POST /api/voice-library/entries', () => {
  it('stores a recording in the library folder and inserts the row, both as the service role', async () => {
    const res = await post({ ...base, source: 'recording', file: ogg() });
    expect(res.status).toBe(201);
    const [db, path] = mocks.storeVoiceAudio.mock.calls[0];
    expect(db).toBe(adminClient);
    expect(path).toMatch(
      new RegExp(`^account-${ACCOUNT}/voice-library/[0-9a-f-]{36}\\.ogg$`)
    );
    expect(mocks.inserted[0]).toMatchObject({
      account_id: ACCOUNT,
      builtin_subject: 'welcome',
      language: 'hi',
      source: 'recording',
      storage_path: path,
      media_url: 'https://cdn/v.ogg',
      created_by: 'user-1',
      personalised: false,
    });
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('writes nothing when the role check refuses', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await post({ ...base, source: 'recording', file: ogg() });
    expect(res.status).toBe(403);
    expect(mocks.storeVoiceAudio).not.toHaveBeenCalled();
    expect(mocks.inserted).toHaveLength(0);
  });

  it('refuses a file that is not Ogg/Opus', async () => {
    const res = await post({
      ...base,
      source: 'recording',
      file: new Blob(['ID3 not ogg at all, long enough to sniff ok']),
    });
    expect(res.status).toBe(400);
    expect(mocks.storeVoiceAudio).not.toHaveBeenCalled();
  });

  it('removes the stored audio when the row is refused', async () => {
    mocks.insertResult = {
      data: null,
      error: { code: '42501', message: 'rls' },
    };
    const res = await post({ ...base, source: 'recording', file: ogg() });
    expect(res.status).toBe(500);
    expect(mocks.removeVoiceAudio).toHaveBeenCalledTimes(1);
    expect(mocks.removeVoiceAudio).toHaveBeenCalledWith(
      mocks.storeVoiceAudio.mock.calls[0][1]
    );
  });

  it('speaks a fixed script once; stores no audio for a personalised one', async () => {
    await post({ ...base, source: 'tts', script: 'Welcome', voice: 'onyx' });
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.inserted[0]).toMatchObject({ source: 'tts', voice: 'onyx' });

    await post({
      ...base,
      source: 'tts',
      script: 'Welcome {name}',
      personalised: 'true',
    });
    expect(mocks.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.inserted[1]).toMatchObject({
      personalised: true,
      storage_path: null,
      media_url: null,
    });
  });

  it('gives the reason when AI speech is unavailable', async () => {
    mocks.loadTtsKey.mockResolvedValue({ ok: false, reason: 'no_openai_key' });
    const res = await post({ ...base, source: 'tts', script: 'Welcome' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_openai_key');
    expect(mocks.inserted).toHaveLength(0);
  });
});
