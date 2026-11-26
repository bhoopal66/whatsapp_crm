/**
 * Reading a response body that somebody else chose the size of (a
 * WhatsApp attachment, a pasted link) without holding more than
 * `maxBytes` of it: refused on the declared size, then counted while
 * reading, because a host may lie about its Content-Length or send none.
 * What is counted is the DECODED stream, so a small compressed body that
 * unpacks into a huge one is cut off too.
 */

/** The largest file WhatsApp carries (a document). */
export const WHATSAPP_MAX_FILE_BYTES = 100 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(
    /** The declared size, or what had been read when it was cut off. */
    readonly bytes: number,
    readonly maxBytes: number
  ) {
    super(`Body of ${bytes} bytes exceeds the ${maxBytes}-byte limit`);
    this.name = 'BodyTooLargeError';
  }
}

/** The declared size; null when absent or of a compressed body. */
function declaredLength(response: Response): number | null {
  if (response.headers.get('content-encoding')) return null;
  const raw = response.headers.get('content-length');
  if (raw === null || raw.trim() === '') return null;
  const size = Number(raw);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

async function checkDeclared(
  response: Response,
  maxBytes: number
): Promise<number | null> {
  const declared = declaredLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(declared, maxBytes);
  }
  return declared;
}

/** The whole body, or `BodyTooLargeError` with the rest left unread. */
export async function readCapped(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  await checkDeclared(response, maxBytes);
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, total);
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(total, maxBytes);
    }
    chunks.push(value);
  }
}

/**
 * The body as a stream that errors past `maxBytes` (so the receiver sees
 * a broken transfer, never a file cut short), and its declared length.
 * Throws `BodyTooLargeError` when the declared size already says so.
 */
export async function streamCapped(
  response: Response,
  maxBytes: number
): Promise<{
  body: ReadableStream<Uint8Array> | null;
  contentLength: number | null;
}> {
  const contentLength = await checkDeclared(response, maxBytes);
  let total = 0;
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(total, maxBytes);
      controller.enqueue(chunk);
    },
  });
  return { body: response.body?.pipeThrough(limit) ?? null, contentLength };
}

/**
 * The signal for a response that is streamed on: the answer must start
 * within `headersMs` (call `started()` when it has), and the whole body,
 * which moves at the receiver's speed, may take `totalMs`.
 */
export function streamDeadline(
  headersMs: number,
  totalMs: number
): { signal: AbortSignal; started: () => void } {
  const first = new AbortController();
  const timer = setTimeout(
    () => first.abort(new DOMException('No answer in time', 'TimeoutError')),
    headersMs
  );
  return {
    signal: AbortSignal.any([first.signal, AbortSignal.timeout(totalMs)]),
    started: () => clearTimeout(timer),
  };
}
