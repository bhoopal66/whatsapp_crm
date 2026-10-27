import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { serverSupabaseUrl } from '@/lib/supabase/urls';

// Lazy, shared service-role client for the Taamul sales-app webhook:
// its tables (migration 139) grant nothing to a session.
let client: SupabaseClient | null = null;

export function taamulSalesDb(): SupabaseClient {
  client ??= createClient(
    serverSupabaseUrl(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  return client;
}
