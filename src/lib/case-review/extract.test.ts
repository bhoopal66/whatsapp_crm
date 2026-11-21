import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { extractReviewText } from './extract';

async function pdf(lines: string[], pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([600, 800]);
    lines.forEach((l, i) =>
      page.drawText(l, { x: 40, y: 760 - i * 16, size: 11, font })
    );
  }
  return doc.save();
}

describe('extractReviewText', () => {
  it('reads a text-layer PDF', async () => {
    const out = await extractReviewText(
      await pdf([
        'TRADE LICENCE',
        'Kite General Trading LLC',
        'Licence number 1234567, valid until 2027-03-14',
      ]),
      'application/pdf'
    );
    expect(out.ok && out.text).toContain('Kite General Trading LLC');
  });

  it('takes a page with almost no text for a scan', async () => {
    expect(await extractReviewText(await pdf([]), 'application/pdf')).toEqual({
      ok: false,
      reason: 'scanned',
    });
  });

  it('refuses images and over-long files without reading them', async () => {
    expect(
      await extractReviewText(new Uint8Array([0xff, 0xd8]), 'image/jpeg')
    ).toEqual({ ok: false, reason: 'image' });
    expect(
      await extractReviewText(
        await pdf(['x'.repeat(60)], 31),
        'application/pdf'
      )
    ).toEqual({ ok: false, reason: 'too_large' });
    expect(
      await extractReviewText(new Uint8Array([1, 2, 3]), 'application/pdf')
    ).toEqual({ ok: false, reason: 'unreadable' });
  });
});
