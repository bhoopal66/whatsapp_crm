import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import { GroupsUnsupportedError } from '@/lib/whatsapp/groups';

const loadChannels = vi.fn();
vi.mock('@/lib/whatsapp/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/channels')>()),
  loadChannels: (...args: unknown[]) => loadChannels(...args),
}));

import { GroupHttpError, loadGroupChannel } from './server';

const company = {
  id: 'ch-1',
  provider: 'openwa',
  accessToken: 'k',
  phoneNumberId: 's',
  isPersonal: false,
} as WhatsAppChannel;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  loadChannels.mockReset();
});

describe('loadGroupChannel', () => {
  it('accepts a company OpenWA number', async () => {
    loadChannels.mockResolvedValue([company]);
    await expect(loadGroupChannel('a1', 'ch-1')).resolves.toBe(company);
  });

  it('refuses a personal OpenWA number', async () => {
    loadChannels.mockResolvedValue([{ ...company, isPersonal: true }]);
    await expect(loadGroupChannel('a1', 'ch-1')).rejects.toBeInstanceOf(
      GroupsUnsupportedError
    );
  });

  it('answers 409 number_removed when the number is gone', async () => {
    loadChannels.mockResolvedValue([]);
    const err = await loadGroupChannel('a1', 'ch-1').catch((e) => e);
    expect(err).toBeInstanceOf(GroupHttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('number_removed');
  });
});
