import type { EventColor } from '../validate';
import type { FeedItem } from '../feed';

/**
 * The left rail's layer toggles. "Workspace meetings" does not filter
 * anything: it widens the feed request (includeWorkspaceMeetings=1),
 * and what comes back is shown under the Meetings layer. "Invitations"
 * is every event someone else organises, including a workspace-visible
 * one I was not invited to (myResponse null).
 */
export const LAYER_KEYS = [
  'mine',
  'invitations',
  'meetings',
  'workspaceMeetings',
  'tasks',
] as const;
export type LayerKey = (typeof LAYER_KEYS)[number];
export type Layers = Record<LayerKey, boolean>;

export const DEFAULT_LAYERS: Layers = {
  mine: true,
  invitations: true,
  meetings: true,
  workspaceMeetings: false,
  tasks: true,
};

/** The dot beside each toggle. */
export const LAYER_COLORS: Record<LayerKey, EventColor> = {
  mine: 'blue',
  invitations: 'violet',
  meetings: 'teal',
  workspaceMeetings: 'slate',
  tasks: 'amber',
};

/** Which layer an item belongs to. */
export function itemLayer(
  item: FeedItem
): Exclude<LayerKey, 'workspaceMeetings'> {
  switch (item.kind) {
    case 'meeting':
      return 'meetings';
    case 'task':
      return 'tasks';
    default:
      // Someone else's event, whether or not I was invited to it.
      return item.myResponse === 'organizer' ? 'mine' : 'invitations';
  }
}

export function filterByLayers(
  items: readonly FeedItem[],
  layers: Layers
): FeedItem[] {
  return items.filter((item) => layers[itemLayer(item)]);
}

/** Per viewer: two people sharing a browser keep their own choice. */
export function layersStorageKey(userId: string): string {
  return `calendar.layers.v1:${userId}`;
}

/** Tolerant: anything unreadable falls back to the defaults, key by key. */
export function parseLayers(raw: string | null | undefined): Layers {
  const out: Layers = { ...DEFAULT_LAYERS };
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return out;
  }
  for (const key of LAYER_KEYS) {
    const v = (parsed as Record<string, unknown>)[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

export function serialiseLayers(layers: Layers): string {
  const out: Partial<Layers> = {};
  for (const key of LAYER_KEYS) out[key] = layers[key];
  return JSON.stringify(out);
}
