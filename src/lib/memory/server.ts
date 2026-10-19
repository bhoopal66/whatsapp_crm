/**
 * Server-only wiring for CRM memory (module 019b, migration 129): the store on the service-role client. Routes check
 * the caller first and pass the caller as the user / actor; the memory_* functions decide every permission.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/groups/server';
import { MemoryStore, type MemoryStoreOptions } from './store';

export function memoryStore(
  opts: MemoryStoreOptions = {},
  admin: SupabaseClient = supabaseAdmin()
): MemoryStore {
  return new MemoryStore(admin, opts);
}
