import { describe, expect, it } from 'vitest';

import {
  findRegisteredItems,
  registerContextMenuItems,
  type ContextMenuEntry,
} from './registry';

// The node test environment has no DOM; the registry only walks
// `parentElement`, so a plain object stands in for an element.
const fakeElement = (parent: Element | null = null) =>
  ({ parentElement: parent }) as unknown as Element;

const items = (id: string): ContextMenuEntry[] => [
  { id, label: id, onSelect: () => {} },
];

describe('registerContextMenuItems', () => {
  it('serves the items to a right-click on the element or a child', () => {
    const el = fakeElement();
    const child = fakeElement(el);
    const unregister = registerContextMenuItems(el, () => items('open'));
    expect(findRegisteredItems(child).map((e) => 'id' in e && e.id)).toEqual([
      'open',
    ]);
    unregister();
    expect(findRegisteredItems(child)).toEqual([]);
  });

  it('a stale unregister leaves a newer registration in place', () => {
    const el = fakeElement();
    const stale = registerContextMenuItems(el, () => items('old'));
    registerContextMenuItems(el, () => items('new'));
    stale();
    expect(findRegisteredItems(el).map((e) => 'id' in e && e.id)).toEqual([
      'new',
    ]);
  });
});
