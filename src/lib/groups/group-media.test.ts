import { describe, expect, it } from 'vitest';

import { fileSizeLabel, groupMediaView, safeMediaUrl } from './group-media';

const LINK = 'https://s3.eu-central-1.wasabisys.com/in-files/1234/doc.pdf';

describe('groupMediaView', () => {
  it('turns a document into a card view with its name, size and link', () => {
    const v = groupMediaView(
      'document',
      {
        id: 'abc',
        link: LINK,
        mime_type: 'application/pdf',
        filename: 'Salary certificate.pdf',
        file_size: 245_760,
      },
      'Salary certificate.pdf'
    );
    expect(v).toEqual({
      kind: 'document',
      url: LINK,
      filename: 'Salary certificate.pdf',
      sizeLabel: '240 KB',
      // The body only repeated the file name: no caption under the card.
      caption: null,
      location: null,
    });
  });

  it('keeps a real caption', () => {
    const v = groupMediaView(
      'image',
      { link: LINK, filename: null },
      'My Emirates ID'
    );
    expect(v?.kind).toBe('image');
    expect(v?.caption).toBe('My Emirates ID');
  });

  it('has no url when the gateway gave no https link', () => {
    expect(
      groupMediaView('document', { filename: 'a.pdf' }, null)?.url
    ).toBeNull();
    expect(
      groupMediaView('document', { link: 'javascript:alert(1)' }, null)?.url
    ).toBeNull();
    expect(
      groupMediaView('document', { link: 'http://x.example/a.pdf' }, null)?.url
    ).toBeNull();
  });

  it('draws a location as a map link', () => {
    const v = groupMediaView(
      'location',
      { location: { latitude: 25.2, longitude: 55.27, name: 'Office' } },
      null
    );
    expect(v?.location).toEqual({
      label: 'Office',
      mapUrl: 'https://www.google.com/maps/search/?api=1&query=25.2,55.27',
    });
  });

  it('is null for text and for anything it does not draw', () => {
    expect(groupMediaView('text', null, 'Hello')).toBeNull();
    expect(groupMediaView('unsupported', { link: LINK }, null)).toBeNull();
    expect(groupMediaView(null, { link: LINK }, null)).toBeNull();
    expect(groupMediaView('location', { location: {} }, null)).toBeNull();
  });
});

describe('helpers', () => {
  it('labels sizes', () => {
    expect(fileSizeLabel(500)).toBe('500 B');
    expect(fileSizeLabel(2048)).toBe('2 KB');
    expect(fileSizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(fileSizeLabel(null)).toBeNull();
    expect(fileSizeLabel(0)).toBeNull();
  });

  it('accepts only https urls', () => {
    expect(safeMediaUrl(LINK)).toBe(LINK);
    expect(safeMediaUrl('  ')).toBeNull();
    expect(safeMediaUrl('data:text/html,hi')).toBeNull();
  });
});
