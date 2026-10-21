import { describe, expect, it } from 'vitest';

import {
  decideContextMenu,
  genericGroups,
  isTouchContextMenu,
  resolveLink,
  tidySeparators,
  type ContextMenuEventFacts,
} from './resolve';

const PAGE = 'https://crm.example.com/inbox?c=1';

const plain: ContextMenuEventFacts = {
  shift: false,
  editable: false,
  nativeMarked: false,
  defaultPrevented: false,
};

describe('decideContextMenu', () => {
  it('opens the app menu on an ordinary target', () => {
    expect(decideContextMenu(plain)).toBe('app');
  });

  it('keeps the native menu with Shift, in a field, or when marked', () => {
    expect(decideContextMenu({ ...plain, shift: true })).toBe('native');
    expect(decideContextMenu({ ...plain, editable: true })).toBe('native');
    expect(decideContextMenu({ ...plain, nativeMarked: true })).toBe('native');
  });

  it('stands aside when a more specific handler already prevented it', () => {
    expect(decideContextMenu({ ...plain, defaultPrevented: true })).toBe(
      'elsewhere'
    );
    // Even in a field: the specific handler showed its own UI.
    expect(
      decideContextMenu({ ...plain, defaultPrevented: true, editable: true })
    ).toBe('elsewhere');
  });
});

describe('resolveLink', () => {
  it('resolves a relative href against the page, same origin', () => {
    expect(resolveLink('/contacts/abc?x=1#h', PAGE)).toEqual({
      url: 'https://crm.example.com/contacts/abc?x=1#h',
      sameOrigin: true,
      path: '/contacts/abc?x=1#h',
      openable: true,
    });
  });

  it('marks another origin as not same-origin but openable', () => {
    const link = resolveLink('https://example.org/a', PAGE);
    expect(link?.sameOrigin).toBe(false);
    expect(link?.openable).toBe(true);
  });

  it('makes other schemes copy-only', () => {
    const link = resolveLink('mailto:a@b.c', PAGE);
    expect(link?.openable).toBe(false);
    expect(link?.sameOrigin).toBe(false);
  });

  it('refuses javascript:, empty and unparsable values', () => {
    expect(resolveLink('javascript:alert(1)', PAGE)).toBeNull();
    expect(resolveLink('  JavaScript:void(0)', PAGE)).toBeNull();
    expect(resolveLink('', PAGE)).toBeNull();
    expect(resolveLink(null, PAGE)).toBeNull();
    expect(resolveLink('http://[', PAGE)).toBeNull();
  });
});

describe('genericGroups', () => {
  const none = { link: null, image: null, selectionText: '' };

  it('always ends with the page group', () => {
    expect(genericGroups(none)).toEqual([
      {
        id: 'page',
        actions: [
          'page.back',
          'page.forward',
          'page.reload',
          'page.copyLink',
          'page.toggleMode',
        ],
      },
    ]);
  });

  it('orders link, image, selection, page', () => {
    const groups = genericGroups({
      link: resolveLink('/a', PAGE),
      image: resolveLink('https://cdn.example.com/x.png', PAGE),
      selectionText: 'hello',
    });
    expect(groups.map((g) => g.id)).toEqual([
      'link',
      'image',
      'selection',
      'page',
    ]);
    expect(groups[0].actions).toEqual([
      'link.open',
      'link.openNewTab',
      'link.copy',
    ]);
    expect(groups[1].actions).toEqual(['image.openNewTab', 'image.copy']);
    expect(groups[2].actions).toEqual(['selection.copy']);
  });

  it('offers only copy for a non-http link', () => {
    const groups = genericGroups({
      ...none,
      link: resolveLink('tel:+971500000000', PAGE),
    });
    expect(groups[0]).toEqual({ id: 'link', actions: ['link.copy'] });
  });

  it('skips a data: image and a whitespace-only selection', () => {
    const groups = genericGroups({
      link: null,
      image: resolveLink('data:image/png;base64,AAAA', PAGE),
      selectionText: '  \n ',
    });
    expect(groups.map((g) => g.id)).toEqual(['page']);
  });
});

describe('tidySeparators', () => {
  const sep = (e: string) => e === '-';
  it('drops leading, trailing and doubled separators', () => {
    expect(tidySeparators(['-', 'a', '-', '-', 'b', '-'], sep)).toEqual([
      'a',
      '-',
      'b',
    ]);
    expect(tidySeparators(['-', '-'], sep)).toEqual([]);
  });
});

describe('isTouchContextMenu', () => {
  it('trusts the preceding pointerdown first', () => {
    expect(
      isTouchContextMenu({ lastPointerType: 'touch', firesTouchEvents: false })
    ).toBe(true);
    expect(
      isTouchContextMenu({ lastPointerType: 'mouse', firesTouchEvents: true })
    ).toBe(false);
  });

  it('falls back to sourceCapabilities, else not touch', () => {
    expect(
      isTouchContextMenu({ lastPointerType: null, firesTouchEvents: true })
    ).toBe(true);
    expect(
      isTouchContextMenu({ lastPointerType: null, firesTouchEvents: null })
    ).toBe(false);
  });
});
