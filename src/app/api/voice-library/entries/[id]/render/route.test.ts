import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadTtsKey: vi.fn(),
  storeVoiceAudio: vi.fn(),
  voiceTtsLimited: vi.fn(),
  synthesizeSpeech: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/voice-library/server', () => ({
  loadTtsKey: mocks.loadTtsKey,
  storeVoiceAudio: mocks.storeVoiceAudio,
  voiceTtsLimited: mocks.voiceTtsLimited,
}));
vi.mock('@/lib/voice-library/tts', () => ({
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

import { POST } from './route';

const ACCOUNT = '11111111-2222-4333-8444-555555555555';
const ENTRY = '22222222-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';

function fakeClient(results: Record<string, unknown>) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) builder[m] = () => builder;
      builder.maybeSingle = () =>
        Promise.resolve({ data: results[table] ?? null, error: null });
      return builder;
    },
  };
}

function setup(
  entry: unknown = {
    id: ENTRY,
    language: 'en',
    script: 'Hello {name}, about {company}.',
    personalised: true,
    voice: 'nova',
  },
  conversation: unknown = {
    id: CONV,
    account_id: ACCOUNT,
    contact: { name: 'Aisha', company: null },
  }
) {
  mocks.requireRole.mockResolvedValue({
    supabase: fakeClient({
      voice_note_entries: entry,
      conversations: conversation,
    }),
    accountId: ACCOUNT,
    userId: 'user-1',
    role: 'agent',
  });
}

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/voice-library/entries/x/render', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ENTRY }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.voiceTtsLimited.mockReturnValue(null);
  mocks.loadTtsKey.mockResolvedValue({ ok: true, apiKey: 'sk-x' });
  mocks.synthesizeSpeech.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.storeVoiceAudio.mockResolvedValue('https://cdn/staged.ogg');
});

describe('POST /api/voice-library/entries/[id]/render', () => {
  it('speaks the filled script and stores it under staged/', async () => {
    setup();
    const res = await post({ conversation_id: CONV });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mediaUrl).toBe('https://cdn/staged.ogg');
    expect(body.path).toMatch(
      new RegExp(`^account-${ACCOUNT}/staged/\\d+-voice-note\\.ogg$`)
    );
    expect(mocks.synthesizeSpeech).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      apiKey: 'sk-x',
      text: 'Hello Aisha, about your company.',
      voice: 'nova',
      language: 'en',
    });
  });

  it('refuses a fixed entry and a chat the caller cannot see', async () => {
    setup({ id: ENTRY, language: 'en', script: null, personalised: false });
    expect((await post({ conversation_id: CONV })).status).toBe(404);
    setup(undefined, null);
    expect((await post({ conversation_id: CONV })).status).toBe(404);
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('names why AI speech is unavailable, without calling it', async () => {
    setup();
    mocks.loadTtsKey.mockResolvedValue({ ok: false, reason: 'no_openai_key' });
    const res = await post({ conversation_id: CONV });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('no_openai_key');
    expect(mocks.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('needs a conversation id', async () => {
    setup();
    expect((await post({})).status).toBe(400);
  });
});
