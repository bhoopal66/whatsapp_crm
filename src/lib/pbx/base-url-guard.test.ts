import { describe, expect, it } from 'vitest';

import { isAllowedPbxBaseUrl, pbxAllowedHosts } from './base-url-guard';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

describe('isAllowedPbxBaseUrl', () => {
  it('allows a public PBX', async () => {
    expect(
      await isAllowedPbxBaseUrl('https://pbx.example.com', {
        allowedHosts: new Set(),
        resolve: publicDns,
      })
    ).toBe(true);
  });

  it('refuses internal and metadata addresses', async () => {
    for (const u of [
      'http://169.254.169.254',
      'http://127.0.0.1:8000',
      'http://10.0.0.5',
      'http://localhost:3000',
      'http://supabase.internal',
      'http://[::ffff:127.0.0.1]',
      'ftp://pbx.example.com',
      'not a url',
    ])
      expect(await isAllowedPbxBaseUrl(u, { allowedHosts: new Set() }), u).toBe(
        false
      );
  });

  it('allows a LAN PBX the operator listed', async () => {
    const allowedHosts = pbxAllowedHosts(
      ' 192.168.1.20 , pbx.office.local:8088'
    );
    expect(
      await isAllowedPbxBaseUrl('http://192.168.1.20', { allowedHosts })
    ).toBe(true);
    expect(
      await isAllowedPbxBaseUrl('https://pbx.office.local:8088', {
        allowedHosts,
      })
    ).toBe(true);
    expect(
      await isAllowedPbxBaseUrl('http://192.168.1.21', { allowedHosts })
    ).toBe(false);
  });
});
