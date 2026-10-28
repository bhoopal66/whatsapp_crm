import { describe, expect, it } from 'vitest';

import {
  BOARD_DEAL_SELECT,
  DEAL_CARD_ASSIGNEE_FIELDS,
  DEAL_CARD_CONTACT_FIELDS,
} from './board-deal';

describe('BOARD_DEAL_SELECT', () => {
  it('embeds exactly the contact and assignee fields the board types allow', () => {
    // The types are built from the field arrays; the select must fetch
    // the same fields, or a typed field arrives undefined.
    expect(BOARD_DEAL_SELECT).toBe(
      `*, contact:contacts(${DEAL_CARD_CONTACT_FIELDS.join(', ')}), ` +
        `assignee:profiles!deals_assigned_to_fkey(${DEAL_CARD_ASSIGNEE_FIELDS.join(', ')})`
    );
  });

  it('never embeds a whole contact or profile row', () => {
    expect(BOARD_DEAL_SELECT).not.toMatch(/\(\s*\*\s*\)/);
    expect(BOARD_DEAL_SELECT.startsWith('*, ')).toBe(true);
  });
});
