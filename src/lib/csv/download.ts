// ============================================================
// Browser side of the report exports: fetch the CSV, then save it
// under the name the server chose. Fetching (rather than a bare
// <a href download>) lets a refusal or a failure show as a message
// instead of saving a JSON error as a .csv.
// ============================================================

/** The file name in a `Content-Disposition: attachment; filename="…"`. */
export function fileNameFromDisposition(
  header: string | null,
  fallback = 'export.csv'
): string {
  const match = header?.match(/filename="([^"]+)"/i);
  const name = match?.[1]?.trim();
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : fallback;
}

/** Fetch `url` and save it. Throws when the server does not answer 200. */
export async function downloadCsv(url: string): Promise<void> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const blob = await res.blob();
  const name = fileNameFromDisposition(res.headers.get('Content-Disposition'));
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the save before revoking.
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }
}
