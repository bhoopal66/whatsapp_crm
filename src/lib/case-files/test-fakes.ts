/**
 * In-memory fakes of the service-role client and storage for the
 * case-files tests. Every RPC and storage call is recorded in order.
 */
import type { CaseFilesStorage } from './bytes';
import type { CaseFilesDb } from './store';

type Reply = { data: unknown; error: unknown };
export type RpcHandler = (args: Record<string, unknown>) => Reply;

export interface FakeAdmin {
  admin: CaseFilesDb;
  calls: { fn: string; args: Record<string, unknown> }[];
  rpcNames: () => string[];
}

/** `tables[table][id]` answers `from(table).select().eq('id', id).maybeSingle()`. */
export function fakeAdmin(
  handlers: Record<string, RpcHandler | RpcHandler[]>,
  tables: Record<string, Record<string, unknown>> = {}
): FakeAdmin {
  const calls: FakeAdmin['calls'] = [];
  const queues = new Map<string, RpcHandler[]>();
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    calls.push({ fn, args });
    const h = handlers[fn];
    if (Array.isArray(h)) {
      const q = queues.get(fn) ?? [...h];
      queues.set(fn, q);
      const next = q.length > 1 ? q.shift()! : q[0];
      return next(args);
    }
    if (!h) throw new Error(`unexpected rpc ${fn}`);
    return h(args);
  };
  const from = (table: string) => {
    const eqs: Record<string, unknown> = {};
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        eqs[k] = v;
        return b;
      },
      order: () => b,
      maybeSingle: async () => ({
        data: tables[table]?.[String(eqs.id)] ?? null,
        error: null,
      }),
    };
    return b;
  };
  return {
    admin: { rpc, from } as unknown as CaseFilesDb,
    calls,
    rpcNames: () => calls.map((c) => c.fn),
  };
}

export interface FakeStorage {
  storage: CaseFilesStorage;
  uploads: { bucket: string; path: string; options: unknown }[];
  downloads: { bucket: string; path: string }[];
}

export function fakeStorage(opts: {
  uploadError?: unknown;
  objects?: Record<string, Uint8Array>;
  /** What a download answers instead of 'not found'. */
  downloadError?: unknown;
}): FakeStorage {
  const uploads: FakeStorage['uploads'] = [];
  const downloads: FakeStorage['downloads'] = [];
  const storage: CaseFilesStorage = {
    from: (bucket) => ({
      upload: async (path, _body, options) => {
        uploads.push({ bucket, path, options });
        return { data: null, error: opts.uploadError ?? null };
      },
      download: async (path) => {
        downloads.push({ bucket, path });
        const bytes = opts.objects?.[`${bucket}/${path}`];
        return bytes
          ? { data: new Blob([bytes as BlobPart]), error: null }
          : {
              data: null,
              error: opts.downloadError ?? {
                message: 'Object not found',
                status: 400,
                statusCode: '404',
              },
            };
      },
    }),
  };
  return { storage, uploads, downloads };
}

export const ok =
  (data: unknown): RpcHandler =>
  () => ({ data, error: null });
export const refuse =
  (hint: string, code = 'P0001'): RpcHandler =>
  () => ({ data: null, error: { message: 'x', hint, code } });
