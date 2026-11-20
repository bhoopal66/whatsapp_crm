-- ============================================================
-- 217_conversations_perf.sql — chat counts and thread reads stopped
-- timing out for agents and team leaders.
--
-- The problem. 191 left everyone below admin on a per-row call in the
-- conversations SELECT policy and in both messages policies:
--
--   (SELECT current_role_rank()) >= 4
--   OR CASE WHEN personal_owner_id IS NULL
--        THEN can_view_conversation(account_id, user_id, assigned_agent_id,
--                                   channel_id, send_channel_id)
--        ELSE can_view_personal_chat(account_id, personal_owner_id)
--      END
--
-- Both functions are SECURITY DEFINER with SET search_path, so they are
-- never inlined: every row costs several membership lookups (about
-- 0.5 ms). Two reads pay it for the whole workspace:
--
--   * The team chat sidebar's WhatsApp counts (useInboxCounts, a HEAD
--     count per row, re-read every minute on /chat) scan every
--     conversation of the workspace: 2.5 s for one agent on a copy of
--     production (5,097 chats), idle.
--   * Opening a thread (the inbox's 50-message page). The planner turns
--     the messages policy's EXISTS into "conversation_id IN (hashed
--     set of every visible conversation)", so a 50-row read builds that
--     set with the per-row call first: 2.7 s for the same agent.
--
-- Under load both passed the 8 s statement_timeout of `authenticated`:
-- from 13 to 20 November nginx logged HTTP 500 on 396 of the count
-- requests and on 51 thread reads.
--
-- The fix, without changing who sees what. For a caller below admin,
-- inside their own active account (the policies' leading account term),
-- the two functions reduce to set membership over sets computed once per
-- statement, as hashed subplans:
--
--   can_view_conversation (company chat), branch by branch:
--     is_account_member(account, 'admin')   -> the rank >= 4 term, kept
--     NOT is_account_member(account)        -> never true here:
--         current_account_id() is non-NULL only for an active, live,
--         non-guest row, which is_account_member(account) also requires
--     owner or assignee is the caller       \
--     team_leader+ and leads_teammate(       > user_id or assigned_agent_id
--       account, owner or assignee)         /  IN contact_visibility_people()
--     channel_id is a personal number of    -> channel_id IN
--       the caller or (team_leader+) of a       personal_number_visible_ids()
--       person in a team they lead
--   can_view_personal_chat (personal chat):
--     admin                                 -> the rank >= 4 term, kept
--     owner is the caller (a member)  \
--     team_leader+ and leads_teammate  >    personal_owner_id
--       (account, owner)              /     IN contact_visibility_people()
--
-- contact_visibility_people() (177) is the caller plus, for team_leader
-- and up, the members of the teams they lead in the active account;
-- personal_number_visible_ids() (190) is the active account's personal
-- numbers owned by one of those people. A NULL column is IN no set, as
-- the functions' COALESCE / IS NOT NULL guards make it false.
--
-- The tests are on the row's own columns, so an INSERT ... RETURNING of
-- a new chat still passes on its columns alone (177's note).
--
-- Checked on a copy of production (2026-11-20, 5,097 chats, 106,230
-- messages) before shipping, for every one of its 47 live members (the
-- owner, 2 admins, 6 team leaders, 38 agents including the coordinators
-- and both HR agents): each read below and the count and md5 of the
-- sorted visible conversation, message and reaction ids are identical
-- before and after. Timings in ms, before -> after:
--
--                              agent        team leader    worst below
--                              (4252b5ab)   (8222d380)     admin, after
--   chat sidebar "mine" count  2,445 -> 7   4,155 -> 8     13
--   thread page (50 + reacts)  2,797 -> 14  4,813 -> 13    14
--   inbox list page (30)         686 -> 5      48 -> 4     11
--   all visible chats          2,560 -> 7   3,811 -> 8     10
--   all visible messages       5,361 -> 54  9,635 -> 69    78
--
-- A coordinator (8f32671a): count 2,431 -> 8, inbox page 2,459 -> 10.
-- The home dashboard's RPCs read messages through these policies and
-- speed up with them, same rows (Asia/Dubai; leader / agent):
-- dashboard_response_time (14 d) 10,285 -> 58 / 5,586 -> 40;
-- dashboard_message_series 7 d 9,672 -> 29 / 5,242 -> 29, 30 d
-- 9,882 -> 47 / 5,246 -> 41, 90 d 10,046 -> 85 / 5,408 -> 63.
-- Owner and admins take the rank >= 4 term and are unchanged (2 ms
-- count, ~80 ms for all 106k messages).
--
-- Unchanged: can_view_conversation and can_view_personal_chat (still
-- used by conversations_update / _delete, conversations_insert,
-- message_reactions and others), the coordinator policies (133), and
-- the TS mirror in lib/auth/conversation-visibility.ts, because the rule
-- did not change. If either function changes, change these three
-- policies with it; verify-conversations-select-set-based.sql compares
-- them per person.
--
-- Apply in order, once: re-running 191 after this file puts the per-row
-- policies back (same rows, slow again). Re-runnable on its own:
-- DROP POLICY IF EXISTS / CREATE POLICY.
-- ============================================================

SET lock_timeout = '5s';

-- 191's conversations_select, set-based.
DROP POLICY IF EXISTS conversations_select ON public.conversations;
CREATE POLICY conversations_select ON public.conversations
  FOR SELECT
  USING (
    account_id = (SELECT public.current_account_id())
    AND (
      (SELECT public.current_role_rank()) >= 4
      OR CASE WHEN personal_owner_id IS NULL
           THEN user_id IN (SELECT public.contact_visibility_people())
             OR assigned_agent_id IN (SELECT public.contact_visibility_people())
             OR channel_id IN (SELECT public.personal_number_visible_ids())
           ELSE personal_owner_id IN (SELECT public.contact_visibility_people())
         END
    )
  );

-- 191's messages_select, set-based.
DROP POLICY IF EXISTS messages_select ON public.messages;
CREATE POLICY messages_select ON public.messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT public.current_account_id())
        AND (
          (SELECT public.current_role_rank()) >= 4
          OR CASE WHEN c.personal_owner_id IS NULL
               THEN c.user_id IN (SELECT public.contact_visibility_people())
                 OR c.assigned_agent_id IN (SELECT public.contact_visibility_people())
                 OR c.channel_id IN (SELECT public.personal_number_visible_ids())
               ELSE c.personal_owner_id IN (SELECT public.contact_visibility_people())
             END
        )
    )
  );

-- 191's messages_modify, set-based. FOR ALL, so it is a SELECT policy
-- too: left per-row, any read touching a message the caller cannot see
-- would still build the slow set.
DROP POLICY IF EXISTS messages_modify ON public.messages;
CREATE POLICY messages_modify ON public.messages
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND c.account_id = (SELECT public.current_account_id())
        AND (SELECT public.current_role_rank()) >= 2
        AND (
          (SELECT public.current_role_rank()) >= 4
          OR CASE WHEN c.personal_owner_id IS NULL
               THEN c.user_id IN (SELECT public.contact_visibility_people())
                 OR c.assigned_agent_id IN (SELECT public.contact_visibility_people())
                 OR c.channel_id IN (SELECT public.personal_number_visible_ids())
               ELSE c.personal_owner_id IN (SELECT public.contact_visibility_people())
             END
        )
    )
  );

RESET lock_timeout;
