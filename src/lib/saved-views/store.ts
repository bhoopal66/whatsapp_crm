import type { SupabaseClient } from '@supabase/supabase-js';
import {
  toSavedView,
  type SavedView,
  type SavedViewRow,
  type ViewScreen,
} from './types';

const COLS = 'id, screen, name, shared, owner_user_id, filters, updated_at';

/** Every personal view of this person plus the workspace's shared ones
 *  (RLS decides which rows come back). */
export async function listViews(
  supabase: SupabaseClient,
  screen: ViewScreen
): Promise<SavedView[]> {
  const { data, error } = await supabase
    .from('saved_views')
    .select(COLS)
    .eq('screen', screen)
    .order('name', { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as SavedViewRow[])
    .map(toSavedView)
    .filter((v): v is SavedView => v !== null);
}

export async function createView(
  supabase: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    screen: ViewScreen;
    name: string;
    filters: Record<string, unknown>;
    shared: boolean;
  }
): Promise<SavedView> {
  const { data, error } = await supabase
    .from('saved_views')
    .insert({
      account_id: args.accountId,
      owner_user_id: args.userId,
      screen: args.screen,
      name: args.name,
      filters: args.filters,
      shared: args.shared,
    })
    .select(COLS)
    .single();
  if (error) throw new Error(error.message);
  const view = toSavedView(data as SavedViewRow);
  if (!view) throw new Error('view not saved');
  return view;
}

export async function updateView(
  supabase: SupabaseClient,
  id: string,
  patch: {
    name?: string;
    filters?: Record<string, unknown>;
    shared?: boolean;
  }
): Promise<void> {
  const { data, error } = await supabase
    .from('saved_views')
    .update(patch)
    .eq('id', id)
    .select('id');
  if (error) throw new Error(error.message);
  // RLS filters rows out silently: no row back means not allowed.
  if (!data || data.length === 0) throw new Error('not allowed');
}

export async function deleteView(
  supabase: SupabaseClient,
  id: string
): Promise<void> {
  const { data, error } = await supabase
    .from('saved_views')
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('not allowed');
}
