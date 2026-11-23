import { describe, expect, it, vi } from 'vitest';

import { createUnsentTakes } from './unsent-takes';

describe('unsent voice notes', () => {
  it('are kept per chat, for the login that recorded them', () => {
    const s = createUnsentTakes<string>();
    s.claim('u');
    expect(s.put('u', 'a', 'take')).toBe(true);
    expect(s.get('u', 'a')).toBe('take');
    expect(s.get('u', 'b')).toBeNull();
    expect(s.get('other', 'a')).toBeNull();
    expect(s.get(null, 'a')).toBeNull();
    // A composer that mounts again for the same person keeps them.
    s.claim('u');
    expect(s.get('u', 'a')).toBe('take');
    s.remove('a');
    expect(s.get('u', 'a')).toBeNull();
  });

  it('are gone for the next login, and cannot be added to it', () => {
    const s = createUnsentTakes<string>();
    s.claim('u');
    s.put('u', 'a', 'take');
    s.claim('other');
    expect(s.get('u', 'a')).toBeNull();
    expect(s.get('other', 'a')).toBeNull();
    expect(s.put('u', 'a', 'late')).toBe(false);
    expect(s.get('other', 'a')).toBeNull();
    s.claim('u');
    expect(s.get('u', 'a')).toBeNull();
  });

  it('are not lost while nobody is known to be signed in', () => {
    const s = createUnsentTakes<string>();
    s.claim('u');
    s.put('u', 'a', 'take');
    s.claim(null);
    expect(s.get('u', 'a')).toBe('take');
    expect(s.put(null, 'a', 'x')).toBe(false);
  });

  it('tell the screen when they change, and only then', () => {
    const s = createUnsentTakes<string>();
    const listener = vi.fn();
    const off = s.subscribe(listener);
    s.claim('u');
    expect(listener).not.toHaveBeenCalled();
    s.put('u', 'a', 'take');
    s.remove('b');
    expect(listener).toHaveBeenCalledTimes(1);
    s.remove('a');
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    s.put('u', 'a', 'take');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
