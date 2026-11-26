export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export function apiKeyStatus(key: {
  revoked_at: string | null;
  expires_at: string | null;
}): ApiKeyStatus {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now())
    return 'expired';
  return 'active';
}
