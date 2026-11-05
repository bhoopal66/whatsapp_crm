import { describe, expect, it, vi } from 'vitest';

import {
  absoluteCssUrls,
  copyPageStyles,
  createPopoutHolder,
  POPOUT_DEFAULT_SIZE,
  readPopoutSize,
  tileReporter,
  writePopoutSize,
} from './popout';

describe('readPopoutSize', () => {
  it('round-trips a saved size', () => {
    const size = { width: 512, height: 288 };
    expect(readPopoutSize(writePopoutSize(size))).toEqual(size);
  });

  it.each([
    [null],
    [''],
    ['not json'],
    ['null'],
    ['[]'],
    ['{"width":"420","height":320}'],
    ['{"width":420}'],
  ])('falls back to the default on %s', (raw) => {
    expect(readPopoutSize(raw)).toEqual(POPOUT_DEFAULT_SIZE);
  });

  it('never gives requestWindow a value it would throw on', () => {
    expect(readPopoutSize('{"width":-5,"height":0}')).toEqual({
      width: 160,
      height: 160,
    });
    expect(readPopoutSize('{"width":1e12,"height":300.6}')).toEqual({
      width: 4096,
      height: 301,
    });
  });
});

describe('tileReporter', () => {
  it('has exactly one reporter in every state', () => {
    expect(tileReporter(true, false)).toBe('room');
    expect(tileReporter(true, true)).toBe('room');
    expect(tileReporter(false, true)).toBe('popout');
    expect(tileReporter(false, false)).toBe('float');
  });
});

describe('absoluteCssUrls', () => {
  const base = 'https://crm.test/_next/static/css/app.css';

  it('resolves relative urls against the sheet they came from', () => {
    expect(absoluteCssUrls('src: url(../media/a.woff2)', base)).toBe(
      'src: url("https://crm.test/_next/static/media/a.woff2")'
    );
    expect(absoluteCssUrls('src: url("/fonts/b.woff2")', base)).toBe(
      'src: url("https://crm.test/fonts/b.woff2")'
    );
  });

  it('leaves absolute urls, data urls and fragments alone', () => {
    for (const css of [
      'url("https://cdn.test/a.png")',
      'url(data:image/png;base64,AAAA)',
      'url("#clip")',
      'url(//cdn.test/a.png)',
    ]) {
      expect(absoluteCssUrls(css, base)).toBe(css);
    }
  });
});

describe('copyPageStyles', () => {
  const target = () => {
    const added: Record<string, unknown>[] = [];
    return {
      added,
      doc: {
        createElement: (tag: string) => ({ tag }),
        head: { appendChild: (el: Record<string, unknown>) => added.push(el) },
      } as unknown as Document,
    };
  };

  it('copies rules in order and links a sheet that hides them', () => {
    const { added, doc } = target();
    const from = {
      baseURI: 'https://crm.test/inbox',
      styleSheets: [
        { href: null, cssRules: [{ cssText: 'a { color: red; }' }] },
        {
          href: 'https://cdn.test/x.css',
          media: { mediaText: 'print' },
          get cssRules() {
            throw new Error('SecurityError');
          },
        },
        { href: null, cssRules: [{ cssText: 'b { top: 0; }' }] },
        {
          href: null,
          get cssRules() {
            throw new Error('SecurityError');
          },
        },
      ],
    } as unknown as Document;

    copyPageStyles(from, doc);

    expect(added).toEqual([
      { tag: 'style', textContent: 'a { color: red; }' },
      {
        tag: 'link',
        rel: 'stylesheet',
        href: 'https://cdn.test/x.css',
        media: 'print',
      },
      { tag: 'style', textContent: 'b { top: 0; }' },
    ]);
  });
});

describe('createPopoutHolder', () => {
  const fakeWindow = () => {
    let onHide: (() => void) | undefined;
    return {
      close: vi.fn(),
      addEventListener: (_: string, fn: () => void) => {
        onHide = fn;
      },
      hide: () => onHide?.(),
    };
  };
  type Fake = ReturnType<typeof fakeWindow>;
  const holderFor = (request: () => Promise<Fake>) => {
    const onChange = vi.fn();
    const prepare = vi.fn();
    const holder = createPopoutHolder({
      request: request as unknown as () => Promise<Window>,
      prepare,
      onChange,
    });
    return { holder, onChange, prepare };
  };

  it('asks for the window inside the click, before any await', () => {
    const request = vi.fn(() => Promise.resolve(fakeWindow()));
    void holderFor(request).holder.open();
    expect(request).toHaveBeenCalledOnce();
  });

  it('prepares the window before anyone renders into it', async () => {
    const win = fakeWindow();
    const { holder, onChange, prepare } = holderFor(async () => win);
    await holder.open();
    expect(prepare).toHaveBeenCalledWith(win);
    expect(onChange).toHaveBeenLastCalledWith(win);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(
      onChange.mock.invocationCallOrder[0]
    );
  });

  it('holds one window however often it is opened', async () => {
    const request = vi.fn(async () => fakeWindow());
    const { holder } = holderFor(request);
    await Promise.all([holder.open(), holder.open()]);
    await holder.open();
    expect(request).toHaveBeenCalledOnce();
  });

  it('notices the person closing it, and can open again', async () => {
    const first = fakeWindow();
    const request = vi.fn(async () => first);
    const { holder, onChange } = holderFor(request);
    await holder.open();
    first.hide();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(first.close).not.toHaveBeenCalled();
    await holder.open();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('closes the window once, with one change', async () => {
    const win = fakeWindow();
    win.close.mockImplementation(() => win.hide());
    const { holder, onChange } = holderFor(async () => win);
    await holder.open();
    onChange.mockClear();
    holder.close();
    holder.close();
    expect(win.close).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shuts a window that arrives after the call ended', async () => {
    const win = fakeWindow();
    let arrive: (win: Fake) => void = () => {};
    const { holder, onChange, prepare } = holderFor(
      () => new Promise<Fake>((resolve) => (arrive = resolve))
    );
    const opening = holder.open();
    holder.close();
    arrive(win);
    await opening;
    expect(win.close).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('passes a refusal on, and stays usable', async () => {
    const request = vi
      .fn<() => Promise<Fake>>()
      .mockRejectedValueOnce(new Error('NotAllowedError'))
      .mockResolvedValueOnce(fakeWindow());
    const { holder, onChange } = holderFor(request);
    await expect(holder.open()).rejects.toThrow('NotAllowedError');
    await holder.open();
    expect(onChange).toHaveBeenCalledOnce();
  });
});
