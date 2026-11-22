# Track E (round 6): page shell, menu, Ctrl+K, phone bar

Branch `claude/track-e-shell`, built on `74c8abf`. No migration.

## CHANGELOG entry

### Changed: page shell, menu, command bar, phone layout
- One title per page: the top bar's title is the only heading; screens keep
  their description as a plain intro line. Entity titles (a case's customer,
  a contact's name) and meeting-room headings are unchanged.
- No text below 12px (`text-[9|10|11px]` became `text-xs`).
- Shared loading, empty and error states (`components/dashboard/`) on the
  contacts, broadcasts, automations, flows, journeys, groups, submission
  groups, banks, calls, meetings and notifications screens. The Flows
  builder shows step names ("Send message 2") instead of node keys, and
  both list screens explain "Flow or Automation?".
- Menu: groups fold (remembered per person on this device), HR is one item
  with tabs, Team inbox / Team contacts became a Mine / Team switch,
  My activity sits under My worklist, and people with several workspaces
  get a switcher in the sidebar footer.
- Ctrl/Cmd+K command bar: jump to a screen, find a customer or chat, run
  common actions; `g i`, `g w`, `g c`, `g k` and `?` shortcuts.
- Phone: bottom bar (Inbox, Worklist, Contacts, Team chat, More), drawer
  with focus trap, one "Chat actions" menu in the inbox thread header, and
  the timeline first on the customer page.

## CLAUDE.md paragraph (shell rules)

**Shell (menu, command bar, phone bar).** `nav-items.ts` is the one list of
screens: the sidebar, the Ctrl+K bar (`lib/command`) and the phone bottom
bar (`MOBILE_TAB_HREFS`) all filter it through `isNavItemVisible`, so a new
screen is added there once and each role guard stays in its module layout.
`/team-inbox` and `/team-contacts` are not nav rows; they are the Team side
of `TeamViewSwitch` (`TEAM_VIEW_ITEMS`, `canUseTeamView`). HR is one row
(`/hr`) over `HR_TABS`. The `reports` group is an empty slot: a Reports
track pushes items into it. Group fold state is localStorage (try/catch),
and the group holding the current page never folds. The drawer is a dialog
on a phone (focus in, Tab wrapped by `trapTabTarget`, Escape, focus back);
the thread header's action buttons stay mounted when the Chat actions menu
is closed because their dialogs live inside them. The page title is the
top bar's `<h1>` only.

## Defaults chosen
- Ctrl+K: contact search needs 2+ characters, 250 ms debounce. Add contact
  and New meeting link to the list screens (no URL entry point exists).
- Phone bar shows only the tabs the person's role may open; hidden for bank
  guests and while the profile loads.
- Fold state key per user id; unheaded home group never folds.
- Chat actions menu appears below the thread's `@lg` container width.
- Dashboard greeting still renders a second `<h1>` (not an identical title).

## Merge needs
- Track F adds its report screens as items in `NAV_GROUPS` group `reports`
  (`Sidebar.groups.reports` text exists) and a title in `page-title.ts`.
- ko.json strings (HrTabs, TeamViewSwitch, CommandBar, MobileNav, States,
  new Sidebar keys) are machine-written: have a Korean reader check them.
- `Sidebar.groups.hr`, `Sidebar.teamInbox`, `Sidebar.teamContacts` and
  many page `title` keys are now unused; left in place for key parity.

## Gate results
- `npm run lint`: 0 errors, 31 warnings (the baseline).
- `npm run typecheck`: clean.
- `npm test`: 1148 files, 16,154 tests passed.
- `npm run build` with the CI dummy env: exit 0.

## Not done / not verified
- Nothing was clicked through in a browser: 375px layout, the full-bleed
  HR pages under the new tab bar, the Chat actions strip and the bottom bar
  are checked by typecheck and tests only.
- `command-bar.tsx`, `mobile-tab-bar.tsx` and the thread header have no
  render tests (no DOM in the test env); the logic is in `lib/` and tested.
- Status-by-colour-only sweep was not done repo-wide, only where touched.
- The closed phone drawer's links are still reachable by Tab (off-screen).
