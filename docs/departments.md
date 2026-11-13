# Departments

A department says which part of the company a person works in. Each member
of a workspace has exactly one: **Sales** (the default), **HR**, **IT** or
**Accounts**. Departments change two things, both switchable per workspace.

## Own inbox

When a department has **Own inbox** on, chats owned by or assigned to its
people leave the main and Team inbox and appear in a separate department
inbox (for HR, the "HR inbox"), which only owners and admins can open.

- A chat belongs to a department by its **assignee** if it has one, else by
  its **owner** (the contact's owner). The assignee wins.
- The department's own people still see their own chats in their normal
  inbox, as for any agent.
- A **team leader** in the department (below admin) also keeps the
  department's chats in their Team inbox, so an HR team leader follows
  her HR team's chats there. Which chats she gets is still the team
  leader rule: her own and her team members'. Make sure the people are
  on her team in Settings -> Teams.
- The split is a list filter in the app. Row-level security is unchanged,
  so it is not a privacy wall by itself.
- Moving a person to another department, or switching Own inbox, re-files
  their existing chats.

## Restricted from sales areas

When **Restricted** is on, the department's people cannot open: pipelines,
cases, broadcasts, automations, Team contacts (everyone's contacts),
groups, and Compass / OpenDesk. A team leader among them still opens the
**Team inbox**, which shows only their own and their team's chats. They keep their own chats, their
own Contacts list (only the contacts they own or chat with, as for any
agent; it is where they add a number and message it) and the customer page
of a chat they can see. The **New chat** button in their inbox starts a
chat with a new number without leaving it. Enforced by the dashboard
layouts and API guards.

**Owners and admins are never restricted**, whatever their department.

## Defaults

With nothing saved: HR has Own inbox and Restricted on; Sales, IT and
Accounts have both off.

## Setting it up

1. Settings -> Members: pick each person's department.
2. Settings -> Departments: set the two switches per department (owner or
   admin only).

Requires migration `192_departments.sql`.
