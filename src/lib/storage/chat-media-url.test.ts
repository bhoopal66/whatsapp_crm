import { describe, expect, it } from 'vitest';

import {
  chatMediaDisplayUrl,
  chatMediaObjectPath,
  chatMediaProxyPath,
  isSafeChatMediaPath,
} from './chat-media-url';

const PATH = 'account-a1/inbound/wamid-1-passport scan.jpg';
const PUBLIC = `https://crm.example.com/supabase/storage/v1/object/public/chat-media/account-a1/inbound/wamid-1-passport%20scan.jpg`;

describe('chatMediaObjectPath', () => {
  it('reads the path of a stored link on any origin', () => {
    expect(chatMediaObjectPath(PUBLIC)).toBe(PATH);
    expect(
      chatMediaObjectPath(
        'http://kong:8000/storage/v1/object/sign/chat-media/account-a1/x.ogg?token=abc'
      )
    ).toBe('account-a1/x.ogg');
    expect(chatMediaObjectPath(chatMediaProxyPath(PATH))).toBe(PATH);
  });

  it('ignores other links and refuses unsafe paths', () => {
    expect(chatMediaObjectPath('/api/whatsapp/media/123')).toBeNull();
    expect(
      chatMediaObjectPath(
        'https://x/storage/v1/object/public/avatars/account-a1/me.png'
      )
    ).toBeNull();
    expect(chatMediaObjectPath('blob:https://crm/abc')).toBeNull();
    expect(chatMediaObjectPath('')).toBeNull();
    expect(chatMediaObjectPath(null)).toBeNull();
    expect(
      chatMediaObjectPath(
        'https://x/storage/v1/object/public/chat-media/account-a1/%2E%2E/account-b2/x.jpg'
      )
    ).toBeNull();
    expect(
      chatMediaObjectPath('https://x/storage/v1/object/public/chat-media/a//b')
    ).toBeNull();
    expect(
      chatMediaObjectPath(
        'https://x/storage/v1/object/public/chat-media/a/%E0%A4%A'
      )
    ).toBeNull();
  });
});

describe('chatMediaDisplayUrl', () => {
  it('sends our attachments through the app route, leaves the rest', () => {
    expect(chatMediaDisplayUrl(PUBLIC)).toBe(
      '/api/media/chat/account-a1/inbound/wamid-1-passport%20scan.jpg'
    );
    expect(chatMediaDisplayUrl('/api/whatsapp/media/9')).toBe(
      '/api/whatsapp/media/9'
    );
    expect(chatMediaDisplayUrl(undefined)).toBeUndefined();
    expect(chatMediaDisplayUrl(null)).toBeNull();
  });
});

describe('isSafeChatMediaPath', () => {
  it('allows opaque names, refuses traversal and control characters', () => {
    expect(isSafeChatMediaPath('account-a1/وثيقة.pdf')).toBe(true);
    expect(isSafeChatMediaPath('account-a1/../x')).toBe(false);
    expect(isSafeChatMediaPath('account-a1/x\u0000')).toBe(false);
    expect(isSafeChatMediaPath('account-a1\\x')).toBe(false);
    expect(isSafeChatMediaPath('')).toBe(false);
  });
});
