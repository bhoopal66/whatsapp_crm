import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HomeGreeting } from './home-greeting';

describe('HomeGreeting', () => {
  it('is an intro line, not a second main heading', () => {
    const html = renderToStaticMarkup(
      <HomeGreeting text="Good morning, Sara" />
    );
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).toContain('Good morning, Sara');
  });

  it('keeps the heading look', () => {
    const html = renderToStaticMarkup(<HomeGreeting text="Hi" />);
    expect(html).toContain('text-2xl font-bold');
  });
});
