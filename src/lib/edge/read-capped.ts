/**
 * Reading an inbound webhook body before its signature is checked, with
 * a ceiling: whoever can reach the URL chooses the size, so the body is
 * refused on its declared Content-Length and counted while it streams
 * (a sender may lie about the length or send none). `null` means too
 * large; the caller answers 413, never 429, and has read no more than
 * `maxBytes` (the stream is cancelled at the first chunk over it).
 */
export async function readTextCapped(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}
