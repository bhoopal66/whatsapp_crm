// Where the customer page links back to. The team list (/team-contacts)
// re-exports the contacts screen with a `teamView` flag, so it opens a
// customer with `?from=team`; back and delete then return there instead
// of to the personal list.

/** `?from=` value the team list puts on a customer link. */
export const FROM_TEAM = 'team';

/** True for the raw `from` query value of a team-list click. */
export const isFromTeam = (from: string | string[] | undefined): boolean =>
  from === FROM_TEAM;

/** The list a customer page returns to. */
export const contactsListPath = (team: boolean): string =>
  team ? '/team-contacts' : '/contacts';

/** A customer's page, remembering which list it was opened from. */
export const customerPath = (id: string, team: boolean): string =>
  team ? `/contacts/${id}?from=${FROM_TEAM}` : `/contacts/${id}`;
