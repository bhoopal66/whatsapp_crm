import { describe, expect, it, vi } from 'vitest';

import { createHoldToTalk } from './hold-to-talk';

/** A mic that flips on toggle, optionally after an open it awaits. */
function fakeMic(opts: { on?: boolean; open?: Promise<void> } = {}) {
  let on = opts.on ?? false;
  let opening = false;
  const toggleMic = vi.fn(async () => {
    if (opening) return; // the engine ignores a toggle during an open
    if (opts.open && !on) {
      opening = true;
      await opts.open;
      opening = false;
      on = true;
      return;
    }
    on = !on;
  });
  return {
    toggleMic,
    micOn: () => on,
    set: (v: boolean) => (on = v),
  };
}

describe('createHoldToTalk', () => {
  it('unmutes on press and mutes on release', async () => {
    const mic = fakeMic();
    const talk = createHoldToTalk(mic);
    talk.press();
    expect(talk.held()).toBe(true);
    await Promise.resolve();
    expect(mic.micOn()).toBe(true);
    await talk.release();
    expect(talk.held()).toBe(false);
    expect(mic.micOn()).toBe(false);
  });

  it('mutes after a slow open when the key came up during it', async () => {
    let opened = () => {};
    const open = new Promise<void>((r) => (opened = r));
    const mic = fakeMic({ open });
    const talk = createHoldToTalk(mic);
    talk.press();
    const released = talk.release();
    expect(mic.micOn()).toBe(false);
    opened();
    await released;
    expect(mic.micOn()).toBe(false);
  });

  it('leaves the mic alone when something else muted it first', async () => {
    const mic = fakeMic();
    const talk = createHoldToTalk(mic);
    talk.press();
    await Promise.resolve();
    mic.set(false); // M, or a moderator
    await talk.release();
    expect(mic.micOn()).toBe(false);
    expect(mic.toggleMic).toHaveBeenCalledTimes(1);
  });

  it('does not unmute when the open failed', async () => {
    const mic = {
      micOn: () => false,
      toggleMic: vi.fn(() => Promise.reject(new Error('denied'))),
    };
    const talk = createHoldToTalk(mic);
    talk.press();
    await talk.release();
    expect(mic.toggleMic).toHaveBeenCalledTimes(1);
  });

  it('keeps talking when pressed again before the release settled', async () => {
    let opened = () => {};
    const open = new Promise<void>((r) => (opened = r));
    const mic = fakeMic({ open });
    const talk = createHoldToTalk(mic);
    talk.press();
    const first = talk.release();
    talk.press();
    opened();
    await first;
    expect(mic.micOn()).toBe(true);
    await talk.release();
    expect(mic.micOn()).toBe(false);
  });
});
