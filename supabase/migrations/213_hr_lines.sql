-- ============================================================
-- 213_hr_lines.sql — HR lines: numbers whose new chats open as
-- recruiter conversations.
--
-- Port of package release 029b. In the package, HR_LINE_IDS (env)
-- names the WhatsApp numbers that are HR lines, and
-- HR_AUTO_CREATE_RECRUITER=1 makes an unknown number writing to one of
-- them open a recruiter conversation at the first stage. In wacrm both
-- are per-workspace DATA, not env: one install serves many workspaces,
-- each with its own numbers (whatsapp_config rows, personal ones of 190
-- included: most HR chats are on personal numbers), and an admin must
-- be able to change the list from Settings without a rebuild or a
-- restart.
--
--   1. Tables: hr_lines (one row per number that is an HR line; the
--      composite FK to whatsapp_config(id, account_id) of 062 keeps it
--      in the number's own account and drops it with the number) and
--      hr_line_settings (one row per account; no row = off). RLS enabled
--      AND forced, no policies, no client grants: every access is a
--      function below.
--   2. OFF BY DEFAULT. No settings row, or auto_open_recruiter false,
--      opens nothing; the list alone changes no behaviour.
--   3. hr_lines_get() / hr_lines_set(ids, auto_open, expected) — the caller's
--      ACTIVE account (current_account_id()). Reading needs an HR role
--      (owner/admin, or an hr_team_members row in either inbox, 200's
--      hr_role); writing is owner/admin only. A set replaces the whole
--      list and the switch in one call; an id that is not a number of
--      the account refuses the call and writes nothing. Saves are
--      compare-and-set: get returns the settings row's updated_at (null
--      with no row yet), and set refuses STALE, writing nothing, unless
--      `expected` still equals it (NULL = no row yet), so one admin's
--      save never silently undoes another's.
--   4. hr_auto_open_recruiter(conversation, channel) — service role
--      only, for the inbound pipeline. It answers 'off' with one indexed
--      read when the account's switch is off, so every inbound on a
--      workspace that never turned this on costs one probe. Otherwise it
--      opens a recruiter row at cv_review exactly as 200's hr_open does
--      (created_by NULL, an 'open' history row with actor NULL, the
--      account's rules seeded), unless the chat already has an HR row,
--      open or closed: a person's earlier decision is never overridden,
--      or unless the chat ever used a number that is not an HR line.
--      The package keeps a conversation per line; wacrm keeps ONE company
--      conversation per contact across every number (046), so a sales
--      customer who writes to an HR line would otherwise turn their
--      long-standing chat into a Recruitment chat for good (rule tasks
--      for the sales agent, maybe the cv_received message). Only a chat
--      whose every message came through one of the workspace's HR lines
--      opens; a message with no channel_id counts as another number. A
--      brand-new chat passes (its one message is on the line), and a
--      personal chat only ever carries its own number.
--      Answers: off | not_found | not_hr_line | exists | other_numbers |
--      opened.
--   5. Opening writes an 'open' history row into the recruiter inbox, so
--      203's hr_automsg_on_history may queue the cv_received automated
--      message. That row still passes every automated-message guard of
--      203 (trigger switch off by default, kill switch, opt-out, consent,
--      daily cap; a personal chat is held/cancelled by 203 itself).
--
-- Refusals: RAISE … USING HINT = NOT_ALLOWED (42501) | INVALID (22023) |
-- STALE (22023), through 200's hr_refuse.
-- Apply after 200 (and 203). Re-runnable. No BEGIN/COMMIT. Must be
-- applied by a superuser or BYPASSRLS role (the refusal below runs
-- before any DDL).
-- ============================================================

-- The two tables are RLS-forced with no policies, so the SECURITY
-- DEFINER functions below read and write them only when owned by a role
-- that bypasses RLS. Owned by any other role, the switch would read as
-- off forever and every save would silently write nothing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '213 must be applied by a superuser or BYPASSRLS role (the HR line functions read RLS-forced tables)';
  END IF;
END $$;

SET lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.hr_lines (
  channel_id  uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NULL,
  CONSTRAINT hr_lines_channel_fkey FOREIGN KEY (channel_id, account_id)
    REFERENCES public.whatsapp_config (id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS hr_lines_account_idx ON public.hr_lines (account_id);

CREATE TABLE IF NOT EXISTS public.hr_line_settings (
  account_id          uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  auto_open_recruiter boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NULL
);

-- ------------------------------------------------------------
-- 2. RLS, grants (every access is a function)
-- ------------------------------------------------------------

ALTER TABLE public.hr_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_line_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_lines         FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hr_line_settings FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.hr_lines, public.hr_line_settings
  FROM PUBLIC, anon, authenticated, service_role;

-- ------------------------------------------------------------
-- 3. Functions
-- ------------------------------------------------------------

-- The shape both caller-facing functions return.
CREATE OR REPLACE FUNCTION public.hr_lines_json(p_account uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'auto_open_recruiter',
      COALESCE((SELECT s.auto_open_recruiter FROM hr_line_settings s
                 WHERE s.account_id = p_account), false),
    'channel_ids',
      COALESCE((SELECT jsonb_agg(l.channel_id ORDER BY l.channel_id) FROM hr_lines l
                 WHERE l.account_id = p_account), '[]'::jsonb),
    -- The save version hr_lines_set compares; JSON null with no row yet.
    'updated_at',
      (SELECT s.updated_at FROM hr_line_settings s WHERE s.account_id = p_account))
$$;

CREATE OR REPLACE FUNCTION public.hr_lines_get()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid := current_account_id();
BEGIN
  IF v_account IS NULL
     OR (hr_role(v_account, v_uid, 'recruiter') IS NULL
         AND hr_role(v_account, v_uid, 'dept') IS NULL) THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'you may not read the HR lines');
  END IF;
  RETURN hr_lines_json(v_account);
END;
$$;

-- A test database may still hold the first, two-argument version.
DROP FUNCTION IF EXISTS public.hr_lines_set(uuid[], boolean);

CREATE OR REPLACE FUNCTION public.hr_lines_set(p_channel_ids uuid[], p_auto_open boolean,
                                               p_expected timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid := current_account_id();
  v_ids uuid[] := COALESCE(p_channel_ids, '{}'::uuid[]);
  v_current timestamptz;
BEGIN
  IF v_account IS NULL OR hr_role(v_account, v_uid, 'recruiter') IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an owner or admin may change the HR lines');
  END IF;
  IF p_auto_open IS NULL THEN
    PERFORM hr_refuse('INVALID', 'auto_open is true or false');
  END IF;
  IF array_position(v_ids, NULL) IS NOT NULL OR EXISTS (
       SELECT 1 FROM unnest(v_ids) AS x(id)
        WHERE NOT EXISTS (SELECT 1 FROM whatsapp_config w
                           WHERE w.id = x.id AND w.account_id = v_account)) THEN
    PERFORM hr_refuse('INVALID', 'every HR line must be a WhatsApp number of this workspace');
  END IF;

  -- The settings row first: its row lock serialises two admins saving at
  -- once, and its updated_at is the version the caller loaded. A save
  -- made against anything older is refused before any write, so admin
  -- A's save never silently undoes admin B's.
  SELECT s.updated_at INTO v_current
    FROM hr_line_settings s WHERE s.account_id = v_account
     FOR UPDATE;
  IF v_current IS DISTINCT FROM p_expected THEN
    PERFORM hr_refuse('STALE', 'the HR lines changed since they were loaded');
  END IF;

  -- clock_timestamp(), not now(): two saves in one transaction still get
  -- two versions.
  IF v_current IS NULL THEN
    INSERT INTO hr_line_settings (account_id, auto_open_recruiter, updated_at, updated_by)
    VALUES (v_account, p_auto_open, clock_timestamp(), v_uid)
    ON CONFLICT (account_id) DO NOTHING;
    IF NOT FOUND THEN  -- a racing first save won
      PERFORM hr_refuse('STALE', 'the HR lines changed since they were loaded');
    END IF;
  ELSE
    UPDATE hr_line_settings s
       SET auto_open_recruiter = p_auto_open,
           updated_at = clock_timestamp(),
           updated_by = v_uid
     WHERE s.account_id = v_account;
  END IF;

  DELETE FROM hr_lines l
   WHERE l.account_id = v_account AND NOT (l.channel_id = ANY (v_ids));
  INSERT INTO hr_lines (channel_id, account_id, created_by)
  SELECT DISTINCT x.id, v_account, v_uid FROM unnest(v_ids) AS x(id)
  ON CONFLICT (channel_id) DO NOTHING;

  RETURN hr_lines_json(v_account);
END;
$$;

-- Service role only (the inbound pipeline). Never raises for a normal
-- answer; see the header for the order of the checks.
CREATE OR REPLACE FUNCTION public.hr_auto_open_recruiter(p_conversation_id uuid, p_channel_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_on boolean;
BEGIN
  -- One indexed read: the chat (PK) and its account's switch (PK).
  SELECT c.account_id, COALESCE(s.auto_open_recruiter, false)
    INTO v_account, v_on
    FROM conversations c
    LEFT JOIN hr_line_settings s ON s.account_id = c.account_id
   WHERE c.id = p_conversation_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT v_on THEN RETURN 'off'; END IF;

  IF p_channel_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM hr_lines l
        WHERE l.channel_id = p_channel_id AND l.account_id = v_account) THEN
    RETURN 'not_hr_line';
  END IF;

  IF EXISTS (SELECT 1 FROM hr_conversations x WHERE x.conversation_id = p_conversation_id) THEN
    RETURN 'exists';
  END IF;

  -- One conversation per contact across every number (046): a chat that
  -- ever carried a message on another number, or on no recorded number,
  -- is someone else's (a sales customer, say) and is never turned into
  -- a Recruitment chat. Opens only a chat that has only used HR lines.
  IF EXISTS (
       SELECT 1 FROM messages m
        WHERE m.conversation_id = p_conversation_id
          AND (m.channel_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM hr_lines l
                  WHERE l.channel_id = m.channel_id AND l.account_id = v_account))) THEN
    RETURN 'other_numbers';
  END IF;

  PERFORM hr_seed_rules(v_account);

  INSERT INTO hr_conversations (conversation_id, account_id, inbox, stage_key,
                                last_inbound_at, last_outbound_at, created_by)
  VALUES (p_conversation_id, v_account, 'recruiter', 'cv_review',
          (SELECT max(m.created_at) FROM messages m
            WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'customer'),
          (SELECT max(m.created_at) FROM messages m
            WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'agent'),
          NULL)
  ON CONFLICT (conversation_id) DO NOTHING;

  IF NOT FOUND THEN RETURN 'exists'; END IF;  -- a racing open won

  INSERT INTO hr_stage_history (conversation_id, account_id, event, from_stage, to_stage,
                                from_inbox, to_inbox, actor)
  VALUES (p_conversation_id, v_account, 'open', NULL, 'cv_review', NULL, 'recruiter', NULL);
  -- As in hr_open: a message committed between the reads above and the
  -- insert was stamped by nobody (its trigger found no row): read again.
  UPDATE hr_conversations x
     SET last_inbound_at = GREATEST(x.last_inbound_at,
           (SELECT max(m.created_at) FROM messages m
             WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'customer')),
         last_outbound_at = GREATEST(x.last_outbound_at,
           (SELECT max(m.created_at) FROM messages m
             WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'agent'))
   WHERE x.conversation_id = p_conversation_id;

  RETURN 'opened';
END;
$$;

REVOKE ALL ON FUNCTION
  public.hr_lines_json(uuid),
  public.hr_lines_get(),
  public.hr_lines_set(uuid[], boolean, timestamptz),
  public.hr_auto_open_recruiter(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.hr_lines_get(),
  public.hr_lines_set(uuid[], boolean, timestamptz)
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.hr_auto_open_recruiter(uuid, uuid) TO service_role;
