# Funnel report

Reports → Funnel (`/reports/funnel`) shows how the company chats that
started in a period moved through the sales pipeline: from a new chat
to an approved case. It is read-only; nothing on it sends or changes
anything.

The numbers come from one database function, `funnel_report`
(migration 254), so the page and its CSV export always agree. Apply
254 before deploying the build; without it the page says the report
needs migration 254 (the API answers 503).

## Who can open it

Owners and admins of the active workspace. The page is guarded on the
server, the API routes call `requireRole('admin')`, and the function
itself refuses anyone else (`NOT_ALLOWED`). Team leaders, agents,
viewers and bank guests cannot open it.

## The stages

The report follows a **cohort**: the company chats that started in the
chosen period, followed to wherever they have got by now. A chat that
started last month and was approved today counts in last month's
report, not this month's.

| Stage           | Counts a chat in the cohort when…                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New chats**   | It is a company chat (not a personal number's chat) created in the period.                                                                                                                         |
| **Interested**  | Its main chat tag is the workspace's "Interested" tag now, or it ever arrived at that tag (see below), or its customer has a case (a case opens at Interested, so it implies it).                  |
| **Case opened** | Its customer has a case (a lead or a submitted case) opened at or after the chat began.                                                                                                            |
| **Submitted**   | One of those cases left the pre-submission stages: it has a submission group, or it moved into a stage that is not pre-submission, Withdrawn or Closed, or it has an Approved or Declined outcome. |
| **Approved**    | One of those cases has the outcome Approved.                                                                                                                                                       |

Beside the funnel, not in it:

|               | Counts a chat in the cohort when…             |
| ------------- | --------------------------------------------- |
| **Declined**  | One of those cases has the outcome Declined.  |
| **Withdrawn** | One of those cases has the outcome Withdrawn. |

Rules that apply to every stage:

- **The "Interested" tag is found by name.** It is the workspace's main
  chat tag (not a sub-tag) named "Interested", in any letter case; if
  there are several, the first in the tag list. If there is none, the
  page says so, and only chats whose customer has a case count as
  interested.
- **Tag history.** When the chat tag log of migration 255
  (`chat_tag_history`) is installed, a chat that was tagged Interested
  at any time counts, even if it has since moved to another tag.
  Without 255, only the chat's current tag is read.
- **A customer counts once per stage**, however many cases they have:
  a stage counts chats, and a customer has one company chat.
- **Cases count only from the chat's start.** A case opened before the
  chat began belongs to an earlier conversation and is left out.
- **Conversion** on the page is shown two ways for each stage: as a
  percentage of the stage above it and as a percentage of new chats.
  When the stage it is divided by is 0, no rate is shown.

## Filters

All filters default to "All". Each narrows the cohort:

- **Period**: Today, Yesterday, Last 7 days, Last 30 days (the default)
  or Last 90 days. Days are calendar days in the workspace's time zone
  (the one saved in Team activity settings), else the viewer's, else
  UTC: the same rule as the Team activity page. The daily chart uses
  the same zone.
- **Lead source**: the customer's lead source (ad, web form, broadcast,
  added by hand, import, Compass, other), or "No source recorded".
- **Agent**: the person the chat is assigned to.
- **Number**: the company WhatsApp number the chat is on.
- **Bank**: applies to the **case stages only** (case opened,
  submitted, approved, declined, withdrawn): a chat has no bank. With a
  bank chosen, New chats is unchanged, and a chat counts as interested
  through a case only if that case is with the chosen bank (the tag
  still counts on its own).

## Breakdowns

Under the funnel, the same stages are split by lead source, by agent,
by number and by bank. The bank table shows the case stages only, and
a customer counts once per bank.

## CSV export

"Download CSV" exports the report as shown, with the same period and
filters, as one table: a Total row, two conversion rows (percentage of
the previous stage, percentage of new chats), then one row per lead
source, agent, number and bank. Bank rows leave New chats and
Interested empty. Every cell is quoted, and a cell that a spreadsheet
would read as a formula is prefixed with an apostrophe.

The export (`GET /api/reports/funnel/export`) has the same access rule
and parameters as the page's data (`GET /api/reports/funnel`):
`range`, `lead_source`, `agent`, `bank`, `channel` and `tz`.

## Limits

- A period may be at most **400 days** long; the function refuses a
  longer one (`BAD_RANGE`). The page's presets stay well inside it.
- An unknown lead source is refused (`BAD_FILTER`); the API also
  refuses a malformed agent, number or bank code before asking the
  database.
