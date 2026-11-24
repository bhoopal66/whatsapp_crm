import { describe, expect, it } from 'vitest';

import { micProblem } from '@/lib/media/take-recorder';

import { RELOAD_GAP_MS, isChunkLoadError, takeReload } from './stale-build';
import {
  fieldHasText,
  holdUnsaved,
  textOnPage,
  unsavedInMemory,
  type FieldLike,
} from './unsaved';

const named = (name: string, message = '') =>
  Object.assign(new Error(message), { name });

describe('isChunkLoadError', () => {
  it.each([
    named('ChunkLoadError', 'anything'),
    // Turbopack's words, should a wrapper lose the name.
    new Error(
      'Failed to load chunk /_next/static/chunks/0ab.js from runtime for chunk x'
    ),
    new Error('Loading chunk 12 failed.\n(missing: https://x/12.js)'),
    new Error('Loading CSS chunk app failed.'),
    new TypeError('Failed to fetch dynamically imported module: https://x/a'),
    new TypeError('error loading dynamically imported module: https://x/a'),
    new TypeError('Importing a module script failed.'),
  ])('knows %s', (err) => {
    expect(isChunkLoadError(err)).toBe(true);
  });

  it.each([
    new TypeError('Failed to fetch'),
    new Error('Cannot read properties of undefined'),
    'ChunkLoadError',
    null,
    undefined,
  ])('leaves %s to the ordinary error screen', (err) => {
    expect(isChunkLoadError(err)).toBe(false);
  });

  it('gives the voice recorder its own words', () => {
    expect(micProblem(named('ChunkLoadError'))).toBe('outdated');
    expect(micProblem(named('NotAllowedError'))).toBe('blocked');
  });
});

describe('takeReload', () => {
  const store = () => {
    const held = new Map<string, string>();
    return {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
    };
  };

  it('is taken once per window', () => {
    const s = store();
    expect(takeReload(s, 1_000)).toBe(true);
    expect(takeReload(s, 1_001)).toBe(false);
    expect(takeReload(s, 1_000 + RELOAD_GAP_MS - 1)).toBe(false);
    expect(takeReload(s, 1_000 + RELOAD_GAP_MS)).toBe(true);
  });

  it('is never taken without storage that keeps it', () => {
    expect(takeReload(null, 1)).toBe(false);
    expect(takeReload({ getItem: () => null, setItem: () => {} }, 1)).toBe(
      false
    );
    expect(
      takeReload(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('denied');
          },
        },
        1
      )
    ).toBe(false);
  });
});

describe('what a reload would lose', () => {
  const field = (over: Partial<FieldLike>): FieldLike => ({
    tagName: 'INPUT',
    type: 'text',
    value: 'hello',
    closest: () => null,
    ...over,
  });

  it.each([
    [
      'a composer with text',
      field({ tagName: 'TEXTAREA', type: undefined }),
      true,
    ],
    ['an empty composer', field({ tagName: 'TEXTAREA', value: '  ' }), false],
    ['a form field', field({ type: 'email' }), true],
    [
      'an editor',
      field({ tagName: 'DIV', value: undefined, textContent: 'x' }),
      true,
    ],
    ['a search box', field({ type: 'search' }), false],
    ['a checkbox', field({ type: 'checkbox', value: 'on' }), false],
    ['a read-only field', field({ readOnly: true }), false],
    ["a widget's mirror", field({ closest: () => ({}) }), false],
  ])('%s', (_what, el, expected) => {
    expect(fieldHasText(el)).toBe(expected);
    expect(textOnPage({ querySelectorAll: () => [el] })).toBe(expected);
  });

  it('asks what is parked off the page', () => {
    let parked = false;
    const stop = holdUnsaved(() => parked);
    expect(unsavedInMemory()).toBe(false);
    parked = true;
    expect(unsavedInMemory()).toBe(true);
    stop();
    expect(unsavedInMemory()).toBe(false);
  });
});
