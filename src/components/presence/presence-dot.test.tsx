import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { PresenceDot as ChatDot } from '@/components/chat/presence-dot';
import { PresenceDot } from './presence-dot';

describe('presence dots', () => {
  it('draws Do not disturb as grey with a line, in both dots', () => {
    const app = renderToStaticMarkup(<PresenceDot status="dnd" label="DND" />);
    expect(app).toContain('bg-muted-foreground');
    expect(app.match(/<span/g)).toHaveLength(2);
    const chat = renderToStaticMarkup(<ChatDot state="dnd" />);
    expect(chat).toContain('bg-zinc-400');
    expect(chat.match(/<span/g)).toHaveLength(2);
  });

  it('draws a call red and leaves the app states as they were', () => {
    expect(renderToStaticMarkup(<PresenceDot status="on_call" />)).toContain(
      'bg-red-500'
    );
    expect(renderToStaticMarkup(<ChatDot state="on_call" />)).toContain(
      'bg-red-500'
    );
    expect(renderToStaticMarkup(<ChatDot state="away" />)).toContain(
      'border-white/50'
    );
    const online = renderToStaticMarkup(<PresenceDot status="online" />);
    expect(online).toContain('bg-emerald-500');
    expect(online.match(/<span/g)).toHaveLength(1);
  });
});
