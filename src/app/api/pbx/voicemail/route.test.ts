import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '@/lib/pbx/__tests__/fake-db';

// The four /api/pbx/voicemail routes: list, audio, read, delete. The box
// is always the caller's own extension, and an id acts only once that
// box lists it.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  service: null as unknown,
  pbxApiFor: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Forbidden' }, { status: 403 })
  ),
}));
vi.mock('@/lib/pbx/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/admin')>()),
  pbxServiceDb: () => mocks.service,
}));
vi.mock('@/lib/pbx/connection', async (orig) => ({
  ...(await orig<typeof import('@/lib/pbx/connection')>()),
  pbxApiFor: mocks.pbxApiFor,
}));

import { PbxConnectionError } from '@/lib/pbx/connection';
import { YeastarError, type VoicemailMessage } from '@/lib/pbx/yeastar';
import { DELETE } from './[id]/route';
import { GET as audio } from './[id]/audio/route';
import { POST as read } from './[id]/read/route';
import { GET as list } from './route';

const A = '00000000-0000-4000-8000-00000000000a';
const PBX_URL =
  'https://pbx.example.com/api/download/vm-1.wav?access_token=SECRET-TOKEN';
let rls: FakeDb;

const box: VoicemailMessage[] = [
  {
    msgId: '1713840555-00000623',
    fileName: 'msg0000.wav',
    read: true,
    callerName: 'John',
    callerNumber: '0501234567',
    time: '2026/10/13 09:00:00',
    durationSeconds: 18,
  },
  {
    msgId: '1713840600-00000624',
    fileName: 'msg0001.mp3',
    read: false,
    callerName: '',
    callerNumber: '202',
    time: '2026/10/14 09:30:00',
    durationSeconds: 7,
  },
];
const OWN = box[1].msgId;

const listVoicemail = vi.fn();
const voicemailDownloadUrl = vi.fn();
const markVoicemailRead = vi.fn();
const deleteVoicemail = vi.fn();
const fetchMock = vi.fn();

function as(role: string, mapped = true) {
  rls = createFakeDb(
    {
      contacts: [
        { id: 'c-1', account_id: A, phone_normalized: '971501234567' },
      ],
    },
    {
      pbx_my_extension: () => ({
        data: mapped
          ? [
              {
                connection_id: 'conn-1',
                extension: '201',
                softphone_enabled: false,
              },
            ]
          : [],
        error: null,
      }),
    }
  );
  mocks.requireRole.mockImplementation(async (min: string) => {
    if (role === 'viewer' && min === 'agent') throw new Error('Forbidden');
    return { accountId: A, userId: 'user-1', role, supabase: rls.db };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.service = createFakeDb().db;
  listVoicemail.mockImplementation(async ({ number }: { number: string }) =>
    number === '201'
      ? { total: box.length, items: box }
      : { total: 0, items: [] }
  );
  voicemailDownloadUrl.mockResolvedValue(PBX_URL);
  markVoicemailRead.mockResolvedValue(undefined);
  deleteVoicemail.mockResolvedValue(undefined);
  mocks.pbxApiFor.mockResolvedValue({
    api: {
      listVoicemail,
      voicemailDownloadUrl,
      markVoicemailRead,
      deleteVoicemail,
    },
  });
  fetchMock.mockImplementation(
    async () =>
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '4' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  as('agent');
});
afterEach(() => vi.unstubAllGlobals());

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method = 'GET') =>
  new Request('https://crm.example.com/api/pbx/voicemail/x', { method });

const every = (id: string) => [
  () => audio(req(), params(id)),
  () => read(req('POST'), params(id)),
  () => DELETE(req('DELETE'), params(id)),
];

describe('voicemail routes: who', () => {
  it('need an agent', async () => {
    as('viewer');
    expect((await list()).status).toBe(403);
    for (const call of every(OWN)) expect((await call()).status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(listVoicemail).not.toHaveBeenCalled();
  });

  it('refuse a caller with no extension', async () => {
    as('agent', false);
    for (const call of [list, ...every(OWN)]) {
      const res = await call();
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('no_extension');
    }
    expect(listVoicemail).not.toHaveBeenCalled();
  });

  it('refuse an id the caller’s own box does not list', async () => {
    for (const id of ['1713840000-00009999', '../../x', '']) {
      for (const call of every(id)) {
        const res = await call();
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe('Voicemail not found');
      }
    }
    for (const c of listVoicemail.mock.calls)
      expect(c[0]).toMatchObject({ number: '201' });
    expect(voicemailDownloadUrl).not.toHaveBeenCalled();
    expect(markVoicemailRead).not.toHaveBeenCalled();
    expect(deleteVoicemail).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/pbx/voicemail', () => {
  it('lists the caller’s own box, newest first, with contacts', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.pbxApiFor).toHaveBeenCalledWith(mocks.service, 'conn-1');
    expect(listVoicemail).toHaveBeenCalledWith({
      number: '201',
      page: 1,
      pageSize: 100,
    });
    expect(await res.json()).toEqual({
      messages: [
        {
          id: OWN,
          callerNumber: '202',
          callerName: '',
          at: '2026-10-14T05:30:00.000Z',
          durationSeconds: 7,
          read: false,
          contactId: null,
        },
        {
          id: box[0].msgId,
          callerNumber: '0501234567',
          callerName: 'John',
          at: '2026-10-13T05:00:00.000Z',
          durationSeconds: 18,
          read: true,
          contactId: 'c-1',
        },
      ],
      unread: 1,
      total: 2,
    });
  });

  it('maps the phone system’s failures', async () => {
    listVoicemail.mockRejectedValueOnce(
      new YeastarError({ endpoint: 'vm/get', errcode: 10002, errmsg: 'X' })
    );
    expect((await list()).status).toBe(502);
    mocks.pbxApiFor.mockRejectedValueOnce(
      new PbxConnectionError('not_found', 'gone')
    );
    expect((await list()).status).toBe(503);
  });
});

describe('GET /api/pbx/voicemail/[id]/audio', () => {
  it('streams the bytes without exposing the PBX link', async () => {
    const res = await audio(req(), params(OWN));
    expect(res.status).toBe(200);
    expect(voicemailDownloadUrl).toHaveBeenCalledWith({ msgId: OWN });
    expect(fetchMock).toHaveBeenCalledWith(PBX_URL, expect.anything());
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-length')).toBe('4');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([82, 73, 70, 70]);
    const headerText = JSON.stringify([...res.headers.entries()]);
    expect(headerText).not.toContain('SECRET-TOKEN');
    expect(headerText).not.toContain('pbx.example.com');
    expect(markVoicemailRead).not.toHaveBeenCalled();
  });

  it('forwards Range and relays a 206 with its Content-Range', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([73, 70]), {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '2',
          'content-range': 'bytes 2-3/4',
        },
      })
    );
    const res = await audio(
      new Request('https://crm.example.com/x', {
        headers: { range: 'bytes=2-3' },
      }),
      params(OWN)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      PBX_URL,
      expect.objectContaining({
        redirect: 'error',
        headers: { Range: 'bytes=2-3' },
      })
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-3/4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('2');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('sends no Content-Length when upstream is content-encoded', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'content-length': '3',
          'content-encoding': 'gzip',
        },
      })
    );
    const res = await audio(req(), params(OWN));
    expect(res.status).toBe(200);
    expect(res.headers.has('content-length')).toBe(false);
  });

  it('answers 502 on a PBX error body, and never with the link', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      Response.json({ errcode: 10001, errmsg: 'FAILURE' })
    );
    fetchMock.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch ${PBX_URL} failed`));
    for (let i = 0; i < 3; i++) {
      const res = await audio(req(), params(OWN));
      expect(res.status).toBe(502);
      expect(await res.text()).not.toContain('SECRET-TOKEN');
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain('SECRET-TOKEN');
    errors.mockRestore();
  });
});

describe('POST /api/pbx/voicemail/[id]/read', () => {
  it('marks the caller’s own unread message read', async () => {
    const res = await read(req('POST'), params(OWN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markVoicemailRead).toHaveBeenCalledWith({ msgId: OWN });
  });

  it('leaves an already-read message alone', async () => {
    const res = await read(req('POST'), params(box[0].msgId));
    expect(res.status).toBe(200);
    expect(markVoicemailRead).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/pbx/voicemail/[id]', () => {
  it('deletes the caller’s own message', async () => {
    const res = await DELETE(req('DELETE'), params(OWN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(deleteVoicemail).toHaveBeenCalledWith({ msgId: OWN });
  });

  it('maps a PBX refusal', async () => {
    deleteVoicemail.mockRejectedValueOnce(
      new YeastarError({ endpoint: 'vm/delete', errcode: 10002, errmsg: 'X' })
    );
    expect((await DELETE(req('DELETE'), params(OWN))).status).toBe(502);
  });
});
