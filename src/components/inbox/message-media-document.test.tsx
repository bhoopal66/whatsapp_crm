import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@/types';
import { MediaDocumentBubble } from './message-media';

const t = ((k: string) => k) as unknown as Parameters<
  typeof MediaDocumentBubble
>[0]['t'];

function doc(content_text: string): Message {
  return {
    id: 'm1',
    content_type: 'document',
    content_text,
    media_url:
      'https://x/storage/v1/object/public/chat-media/a/1700000000000-contract.pdf',
    created_at: '2026-11-25T10:00:00Z',
  } as Message;
}

describe('MediaDocumentBubble', () => {
  it('shows the file name on the chip and the caption in full below', () => {
    const caption = 'Please sign this and send it back before Friday evening';
    const html = renderToStaticMarkup(
      <MediaDocumentBubble
        message={doc(caption)}
        t={t}
        trailing={<i id="x" />}
      />
    );
    expect(html).toContain('contract.pdf');
    expect(html).toContain(`<span dir="auto">${caption}</span><i id="x">`);
    expect(html).not.toContain('class="truncate">Please');
  });

  it('shows only the chip when content_text is the file name', () => {
    const html = renderToStaticMarkup(
      <MediaDocumentBubble message={doc('contract.pdf')} t={t} />
    );
    expect(html).toContain('contract.pdf');
    expect(html).not.toContain('dir="auto"');
  });
});
