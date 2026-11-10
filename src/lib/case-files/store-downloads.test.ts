import { describe, expect, it, vi } from 'vitest';

import {
  CaseFilesRefusedError,
  CaseFilesStore,
  CaseFilesStoreError,
  type CaseFilesDb,
} from './store';

const NOW = new Date('2026-11-10T08:00:00.000Z');

function storeWith(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(async () => ({ data: null, error: null, ...result }));
  return { rpc, store: new CaseFilesStore({ rpc } as unknown as CaseFilesDb) };
}

describe('CaseFilesStore download wrappers (182)', () => {
  it('records a file download', async () => {
    const { rpc, store } = storeWith({
      data: [{ download_id: 'd-1', customer_document_id: 'doc-1' }],
    });
    expect(await store.recordFileDownload('u-1', 'f-1', NOW)).toEqual({
      downloadId: 'd-1',
      customerDocumentId: 'doc-1',
    });
    expect(rpc).toHaveBeenCalledWith('case_file_download_record', {
      p_actor: 'u-1',
      p_file: 'f-1',
      p_now: NOW.toISOString(),
    });
  });

  it('records a build download', async () => {
    const { rpc, store } = storeWith({
      data: [
        {
          download_id: 'd-2',
          object_path: 'cases/c/b.pdf',
          sha256: 'ff',
          version: 4,
        },
      ],
    });
    expect(await store.recordBuildDownload('u-1', 'c-1', NOW)).toEqual({
      downloadId: 'd-2',
      objectPath: 'cases/c/b.pdf',
      sha256: 'ff',
      version: 4,
    });
    expect(rpc).toHaveBeenCalledWith('case_build_download_record', {
      p_actor: 'u-1',
      p_case: 'c-1',
      p_now: NOW.toISOString(),
    });
  });

  it('marks a download issued', async () => {
    const { rpc, store } = storeWith({});
    await store.markDownloadIssued('d-1');
    expect(rpc).toHaveBeenCalledWith('case_file_download_issued', {
      p_download_id: 'd-1',
    });
  });

  it('maps hints to refusals and an empty answer to a store error', async () => {
    await expect(
      storeWith({
        error: { hint: 'BUILD_STALE', code: '23514' },
      }).store.recordBuildDownload('u-1', 'c-1', NOW)
    ).rejects.toEqual(new CaseFilesRefusedError('BUILD_STALE'));
    await expect(
      storeWith({
        error: { hint: 'FILE_NOT_FOUND', code: 'P0002' },
      }).store.recordFileDownload('u-1', 'f-1', NOW)
    ).rejects.toBeInstanceOf(CaseFilesRefusedError);
    await expect(
      storeWith({ data: [] }).store.recordFileDownload('u-1', 'f-1', NOW)
    ).rejects.toBeInstanceOf(CaseFilesStoreError);
  });
});
