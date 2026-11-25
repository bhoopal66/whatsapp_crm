import { describe, expect, it } from 'vitest';

import { AnswerOrder } from './answer-order';

describe('AnswerOrder', () => {
  it('drops an older answer that lands after a newer one', () => {
    const o = new AnswerOrder();
    const a = o.start();
    const b = o.start();
    expect(o.accept(b)).toBe(true);
    expect(o.accept(a)).toBe(false);
    expect(o.isStale(a)).toBe(true);
    expect(o.accept(o.start())).toBe(true);
  });

  it('keeps an older answer when the newer read never answered', () => {
    const o = new AnswerOrder();
    const a = o.start();
    o.start();
    expect(o.accept(a)).toBe(true);
  });
});
