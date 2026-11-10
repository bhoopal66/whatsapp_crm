import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  documentName,
  documentStatusView,
  documentUrl,
  documentView,
  folderView,
  formatDocumentSize,
  nasFolderPath,
  parseDocumentsResponse,
  parseDocumentsSummary,
} from './view';

describe('documentName', () => {
  it('prefers the NAS name, then the original name, then the caption', () => {
    expect(
      documentName({ nas_name: 'n.pdf', original_name: 'o.pdf', caption: 'c' })
    ).toBe('n.pdf');
    expect(
      documentName({ nas_name: null, original_name: 'o.pdf', caption: 'c' })
    ).toBe('o.pdf');
    expect(
      documentName({ nas_name: ' ', original_name: '', caption: 'c' })
    ).toBe('c');
    expect(documentName({})).toBeNull();
  });
});

describe('documentUrl', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.com');
    vi.stubEnv('SUPABASE_INTERNAL_URL', 'http://localhost:8000');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('passes a Storage URL through the public origin', () => {
    expect(
      documentUrl(
        'http://localhost:8000/storage/v1/object/public/chat-media/account-1/inbound/a.pdf'
      )
    ).toBe(
      'https://db.example.com/storage/v1/object/public/chat-media/account-1/inbound/a.pdf'
    );
  });

  it('offers no link for a gateway URL or nothing', () => {
    expect(documentUrl('https://gate.whapi.cloud/media/abc')).toBeNull();
    expect(documentUrl(null)).toBeNull();
    expect(documentUrl('')).toBeNull();
  });
});

describe('folderView', () => {
  it('is on the NAS only once the worker made the folder', () => {
    expect(
      folderView({ ref: 'TC-000001', created_at: 't', nas_created_at: null })
    ).toEqual({ ref: 'TC-000001', createdAt: 't', onNas: false });
    expect(
      folderView({ ref: 'TC-000001', created_at: 't', nas_created_at: 'u' })
        ?.onNas
    ).toBe(true);
    expect(folderView(null)).toBeNull();
  });

  it('names the NAS folder', () => {
    expect(nasFolderPath('TC-000123')).toBe('Customer Documents/TC-000123');
  });
});

describe('documentView', () => {
  const row = {
    id: 'd1',
    kind: 'image',
    mime: 'image/jpeg',
    original_name: null,
    caption: null,
    nas_name: null,
    media_url: null,
    received_at: '2026-11-01T10:00:00Z',
    status: 'pending',
    source: 'submission_group',
    size_bytes: null,
  };

  it('shapes a row, with no name and no size yet', () => {
    expect(documentView(row)).toEqual({
      id: 'd1',
      kind: 'image',
      name: null,
      mime: 'image/jpeg',
      sizeBytes: null,
      receivedAt: '2026-11-01T10:00:00Z',
      status: 'pending',
      source: 'submission_group',
      url: null,
    });
  });

  it('drops a row with an unknown kind or status', () => {
    expect(documentView({ ...row, kind: 'video' })).toBeNull();
    expect(documentView({ ...row, status: 'lost' })).toBeNull();
  });
});

describe('documentStatusView', () => {
  it('maps each status to its label key', () => {
    expect(documentStatusView('stored').key).toBe('saved');
    expect(documentStatusView('pending').key).toBe('saving');
    expect(documentStatusView('duplicate').key).toBe('duplicate');
    expect(documentStatusView('failed').key).toBe('failed');
  });
});

describe('formatDocumentSize', () => {
  it('is human readable, and null when unknown', () => {
    expect(formatDocumentSize(500)).toBe('500 B');
    expect(formatDocumentSize(1536)).toBe('1.5 KB');
    expect(formatDocumentSize(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatDocumentSize(null)).toBeNull();
  });
});

describe('response parsers', () => {
  it('reads the list and drops malformed entries', () => {
    expect(
      parseDocumentsResponse({
        folder: { ref: 'TC-1', createdAt: 't', onNas: true },
        documents: [
          { id: 'd', kind: 'document', status: 'failed', receivedAt: 't' },
          { id: 'x' },
        ],
      })?.documents.map((d) => d.id)
    ).toEqual(['d']);
    expect(parseDocumentsResponse({ error: 'x' })).toBeNull();
  });

  it('reads the summary', () => {
    expect(parseDocumentsSummary({ folder: null, count: 0 })).toEqual({
      folder: null,
      count: 0,
    });
    expect(
      parseDocumentsSummary({
        folder: { ref: 'TC-1', createdAt: 't', onNas: false },
        count: 4,
      })
    ).toEqual({
      folder: { ref: 'TC-1', createdAt: 't', onNas: false },
      count: 4,
    });
  });
});
