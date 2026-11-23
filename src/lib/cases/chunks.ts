/** An `.in()` list is part of the URL: 200 uuids make an 8 KB one. */
export const ID_CHUNK = 100;

export function idChunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK)
    out.push(ids.slice(i, i + ID_CHUNK));
  return out;
}
