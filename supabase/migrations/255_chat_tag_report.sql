-- ============================================================
-- 255_chat_tag_report.sql — the chat tag report (Reports → Chat tags),
-- a log of tag changes, and per-person report access.
--
--  * chat_tag_history: append-only. The chat_tag_history_log trigger
--    (AFTER INSERT, or UPDATE OF chat_tag_id / chat_sub_tag_id, on
--    conversations) writes one row whenever a chat's main tag or
--    sub-tag ends up different; it holds ids and a time only (no text,
--    no customer). It NEVER fails the write: any error becomes a
--    WARNING. Movement counts from the day 255 is applied
--    (chat_tag_history_since()). Rows cascade with their conversation.
--    No client grant; only definer functions read it; UPDATE and DELETE
--    are refused by a trigger (the conversation cascade excepted).
--  * report_access (account, user, report key): who may open a
--    report beyond its role rule. Only an owner writes it, through
--    report_access_set; report_access_list lists it for the owner;
--    report_my_access answers the caller's keys. Report keys:
--    'chat_tags'. A grant counts only while the person is live staff
--    (not a guest, not deactivated) of the workspace, and is deleted
--    when they are deactivated, turned guest or leave
--    (report_access_drop_on_profile), so reactivating restores nothing.
--  * Arrivals are changes of main tag in the period, a chat once per
--    tag, under its last sub-tag there; a sub-tag-only move is none.
--  * chat_tag_report(p_from, p_to, p_tz): owners always, or a person
--    with a live 'chat_tags' grant, in the caller's ACTIVE account.
--    SECURITY DEFINER: a grantee sees the workspace-wide counts even of
--    chats they cannot open, because the owner decided access is per
--    person, not by role. Aggregates only: never a chat's text, a
--    customer's name or a phone number. Company chats only (personal
--    chats, 191, are left out).
--
-- docs/chat-tag-report.md is the contract. Apply as a superuser or a
-- BYPASSRLS role (the tables are RLS-forced). Re-runnable: IF NOT
-- EXISTS, CREATE OR REPLACE, guarded constraints, DROP TRIGGER IF
-- EXISTS.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '255 must be applied by a superuser or BYPASSRLS role (its tables are RLS-forced)';
  END IF;
END $$;

-- ---------- 1. chat_tag_history ----------

CREATE TABLE IF NOT EXISTS public.chat_tag_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       uuid NOT NULL,
  conversation_id  uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  from_tag_id      uuid NULL,
  from_sub_tag_id  uuid NULL,
  to_tag_id        uuid NULL,
  to_sub_tag_id    uuid NULL,
  actor_id         uuid NULL,   -- auth.uid() of the writer; NULL = a system writer
  changed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_tag_history_account_time_idx
  ON public.chat_tag_history (account_id, changed_at);
CREATE INDEX IF NOT EXISTS chat_tag_history_conversation_idx
  ON public.chat_tag_history (conversation_id, to_tag_id);

ALTER TABLE public.chat_tag_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_tag_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_tag_history FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.chat_tag_history IS
  'Append-only log of chat tag changes (migration 255): ids and a time, never text. Written only by the chat_tag_history_log trigger, which never fails the conversations write.';

-- Append-only: no UPDATE; a DELETE only as the conversation cascade
-- (pg_trigger_depth() > 1 inside the FK's own trigger).
CREATE OR REPLACE FUNCTION public.chat_tag_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF tg_op = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN old;
  END IF;
  RAISE EXCEPTION 'chat_tag_history is append-only'
    USING ERRCODE = '42501', HINT = 'APPEND_ONLY';
END;
$$;

DROP TRIGGER IF EXISTS chat_tag_history_append_only ON public.chat_tag_history;
CREATE TRIGGER chat_tag_history_append_only
  BEFORE UPDATE OR DELETE ON public.chat_tag_history
  FOR EACH ROW EXECUTE FUNCTION public.chat_tag_history_append_only();

-- Trigger functions run as the table's writer; nobody calls them.
REVOKE ALL ON FUNCTION public.chat_tag_history_append_only() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_tag_history_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_from_tag uuid;
  v_from_sub uuid;
BEGIN
  BEGIN
    IF tg_op = 'UPDATE' THEN
      v_from_tag := old.chat_tag_id;
      v_from_sub := old.chat_sub_tag_id;
    END IF;
    IF (tg_op = 'INSERT' AND (new.chat_tag_id IS NOT NULL OR new.chat_sub_tag_id IS NOT NULL))
       OR (tg_op = 'UPDATE' AND (new.chat_tag_id IS DISTINCT FROM v_from_tag
                                 OR new.chat_sub_tag_id IS DISTINCT FROM v_from_sub)) THEN
      INSERT INTO public.chat_tag_history (
        account_id, conversation_id, from_tag_id, from_sub_tag_id,
        to_tag_id, to_sub_tag_id, actor_id)
      VALUES (new.account_id, new.id, v_from_tag, v_from_sub,
              new.chat_tag_id, new.chat_sub_tag_id, auth.uid());
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'chat_tag_history_log: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.chat_tag_history_log() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS chat_tag_history_log ON public.conversations;
CREATE TRIGGER chat_tag_history_log
  AFTER INSERT OR UPDATE OF chat_tag_id, chat_sub_tag_id ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.chat_tag_history_log();

-- When the log began: the first row, else now (nothing logged yet).
-- A one-row table records the apply time so an empty log still says
-- "from <the day 255 was applied>".
CREATE TABLE IF NOT EXISTS public.chat_tag_history_meta (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.chat_tag_history_meta (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.chat_tag_history_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_tag_history_meta FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_tag_history_meta FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.chat_tag_history_since()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT started_at FROM public.chat_tag_history_meta WHERE id $$;

-- Not the service role: verify-internal-chat-admin.sql pins which
-- chat_* functions it may execute.
REVOKE ALL ON FUNCTION public.chat_tag_history_since() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.chat_tag_history_since() TO authenticated;

-- ---------- 2. report_access ----------

CREATE TABLE IF NOT EXISTS public.report_access (
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,   -- auth user id
  report_key  text NOT NULL,
  granted_by  uuid NULL,       -- auth user id of the owner
  granted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT report_access_pkey PRIMARY KEY (account_id, user_id, report_key)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.report_access'::regclass
       AND conname = 'report_access_report_key_check') THEN
    ALTER TABLE public.report_access ADD CONSTRAINT report_access_report_key_check
      CHECK (report_key IN ('chat_tags'));
  END IF;
END $$;

ALTER TABLE public.report_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_access FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_access FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.report_access IS
  'Who may open a report beyond its role rule (migration 255). Written only by report_access_set (owner). A grant counts only while the person is live staff of the workspace.';

-- A grant ends when the person is deactivated, becomes a bank guest
-- or leaves the workspace, so reactivating them does not restore it.
-- Never fails the profiles write.
CREATE OR REPLACE FUNCTION public.report_access_drop_on_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    IF tg_op = 'DELETE' THEN
      DELETE FROM public.report_access
       WHERE account_id = old.account_id AND user_id = old.user_id;
      RETURN NULL;
    END IF;
    IF new.account_id IS DISTINCT FROM old.account_id
       OR new.user_id IS DISTINCT FROM old.user_id
       OR (new.deactivated_at IS NOT NULL AND old.deactivated_at IS NULL)
       OR (new.account_role = 'bank_guest' AND old.account_role IS DISTINCT FROM 'bank_guest') THEN
      DELETE FROM public.report_access
       WHERE account_id = old.account_id AND user_id = old.user_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'report_access_drop_on_profile: % (%)', SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.report_access_drop_on_profile() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS report_access_drop_on_profile ON public.profiles;
CREATE TRIGGER report_access_drop_on_profile
  AFTER UPDATE OF account_id, user_id, deactivated_at, account_role OR DELETE
  ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.report_access_drop_on_profile();

-- Is the caller an owner of their active account?
CREATE OR REPLACE FUNCTION public.report_caller_is_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.current_account_id() IS NOT NULL AND public.current_role_rank() = 5
$$;

-- May the caller open this report in their active account?
CREATE OR REPLACE FUNCTION public.report_can_open(p_report text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.report_caller_is_owner()
      OR (public.current_account_id() IS NOT NULL AND EXISTS (
            SELECT 1
              FROM public.report_access ra
              JOIN public.profiles p
                ON p.user_id = ra.user_id
               AND p.account_id = ra.account_id
             WHERE ra.account_id = public.current_account_id()
               AND ra.user_id = auth.uid()
               AND ra.report_key = p_report
               AND p.deactivated_at IS NULL
               AND p.account_role <> 'bank_guest'))
$$;

-- The caller's report keys (owner: all of them).
CREATE OR REPLACE FUNCTION public.report_my_access()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(k ORDER BY k), '{}'::text[])
    FROM unnest(ARRAY['chat_tags']::text[]) AS k
   WHERE public.report_can_open(k)
$$;

-- Owner only: the people with a grant for a report, and every live
-- staff member who could be given one.
CREATE OR REPLACE FUNCTION public.report_access_list(p_report text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
BEGIN
  IF NOT public.report_caller_is_owner() THEN
    RAISE EXCEPTION 'Only the owner manages report access'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_report IS NULL OR p_report NOT IN ('chat_tags') THEN
    RAISE EXCEPTION 'Unknown report' USING ERRCODE = '22023', HINT = 'BAD_REPORT';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id', p.user_id,
             'name', p.full_name,
             'role', p.account_role,
             'granted', ra.user_id IS NOT NULL,
             'granted_at', ra.granted_at)
           ORDER BY p.full_name, p.user_id)
      FROM public.profiles p
      LEFT JOIN public.report_access ra
        ON ra.account_id = p.account_id
       AND ra.user_id = p.user_id
       AND ra.report_key = p_report
     WHERE p.account_id = v_account
       AND p.deactivated_at IS NULL
       AND p.account_role NOT IN ('owner', 'bank_guest')), '[]'::jsonb);
END;
$$;

-- Owner only: the report's grant list becomes exactly p_users (live
-- staff of the workspace other than owners; anyone else is refused).
CREATE OR REPLACE FUNCTION public.report_access_set(p_report text, p_users uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_users   uuid[] := coalesce(p_users, '{}'::uuid[]);
  v_count   integer;
BEGIN
  IF NOT public.report_caller_is_owner() THEN
    RAISE EXCEPTION 'Only the owner manages report access'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_report IS NULL OR p_report NOT IN ('chat_tags') THEN
    RAISE EXCEPTION 'Unknown report' USING ERRCODE = '22023', HINT = 'BAD_REPORT';
  END IF;
  IF cardinality(v_users) > 500 THEN
    RAISE EXCEPTION 'Too many people' USING ERRCODE = '22023', HINT = 'BAD_USERS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_users) u(id)
     WHERE u.id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.user_id = u.id
          AND p.account_id = v_account
          AND p.deactivated_at IS NULL
          AND p.account_role NOT IN ('owner', 'bank_guest'))) THEN
    RAISE EXCEPTION 'Someone in the list is not live staff of this workspace'
      USING ERRCODE = '22023', HINT = 'BAD_USERS';
  END IF;

  DELETE FROM public.report_access
   WHERE account_id = v_account
     AND report_key = p_report
     AND NOT (user_id = ANY (v_users));
  INSERT INTO public.report_access (account_id, user_id, report_key, granted_by)
  SELECT DISTINCT v_account, u.id, p_report, auth.uid()
    FROM unnest(v_users) u(id)
  ON CONFLICT (account_id, user_id, report_key) DO NOTHING;

  SELECT count(*) INTO v_count FROM public.report_access
   WHERE account_id = v_account AND report_key = p_report;
  RETURN v_count;
END;
$$;

-- ---------- 3. chat_tag_report ----------

CREATE OR REPLACE FUNCTION public.chat_tag_report(
  p_from timestamptz,
  p_to   timestamptz,
  p_tz   text DEFAULT 'UTC'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid := public.current_account_id();
  v_tz      text := coalesce(nullif(p_tz, ''), 'UTC');
  v_since   timestamptz := public.chat_tag_history_since();
BEGIN
  IF v_account IS NULL OR NOT public.report_can_open('chat_tags') THEN
    RAISE EXCEPTION 'You do not have access to the chat tag report'
      USING ERRCODE = '42501', HINT = 'NOT_ALLOWED';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from
     OR p_to - p_from > interval '400 days' THEN
    RAISE EXCEPTION 'The period is not valid'
      USING ERRCODE = '22023', HINT = 'BAD_RANGE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN
    v_tz := 'UTC';
  END IF;

  RETURN (
    WITH chats AS (
      SELECT c.id, c.chat_tag_id, c.chat_sub_tag_id, c.assigned_agent_id,
             c.channel_id, coalesce(ct.lead_source, 'none') AS lead_source
        FROM public.conversations c
        JOIN public.contacts ct ON ct.id = c.contact_id
       WHERE c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND c.chat_tag_id IS NOT NULL
    ),
    moves AS (
      SELECT h.id, h.conversation_id, h.from_tag_id, h.to_tag_id,
             h.to_sub_tag_id, h.changed_at
        FROM public.chat_tag_history h
        JOIN public.conversations c ON c.id = h.conversation_id
       WHERE h.account_id = v_account
         AND c.account_id = v_account
         AND c.personal_owner_id IS NULL
         AND h.changed_at >= p_from
         AND h.changed_at <  p_to
         AND h.to_tag_id IS NOT NULL
    ),
    -- An arrival is a change of MAIN tag (a sub-tag-only move within the
    -- same main tag is not one). Each chat counts once per main tag,
    -- under the sub-tag it held at its last change at that tag in the
    -- period, so the sub-tag rows of a tag add up to its arrivals.
    arrived AS (
      SELECT DISTINCT ON (m.conversation_id, m.to_tag_id)
             m.conversation_id, m.to_tag_id,
             (SELECT m2.to_sub_tag_id FROM moves m2
               WHERE m2.conversation_id = m.conversation_id
                 AND m2.to_tag_id = m.to_tag_id
               ORDER BY m2.changed_at DESC, m2.id DESC LIMIT 1) AS to_sub_tag_id
        FROM moves m
       WHERE m.from_tag_id IS DISTINCT FROM m.to_tag_id
       ORDER BY m.conversation_id, m.to_tag_id
    )
    SELECT jsonb_build_object(
      'history_since', v_since,
      'tags', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', t.id, 'parent_id', t.parent_id, 'name', t.name,
                 'color', t.color, 'sub_tag_title', t.sub_tag_title,
                 'position', t.position)
               ORDER BY t.parent_id NULLS FIRST, t.position, t.name)
          FROM public.chat_tags t WHERE t.account_id = v_account), '[]'::jsonb),
      'current', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'sub_tag_id', s.chat_sub_tag_id, 'chats', s.n)
               ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, chat_sub_tag_id, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'by_agent', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.agent, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.assigned_agent_id AS agent,
                       (SELECT pr.full_name FROM public.profiles pr
                         WHERE pr.user_id = ch.assigned_agent_id
                           AND pr.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_number', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.channel, 'name', s.name, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT ch.chat_tag_id, ch.channel_id AS channel,
                       -- The label, else the company's own phone on a linked
                       -- device; Meta's waba_id is an account id, not a name.
                       (SELECT coalesce(nullif(w.label, ''),
                                        CASE WHEN w.provider <> 'meta' THEN w.waba_id END)
                          FROM public.whatsapp_config w
                         WHERE w.id = ch.channel_id AND w.account_id = v_account) AS name,
                       count(*) n
                  FROM chats ch GROUP BY 1, 2) s), '[]'::jsonb),
      'by_source', coalesce((
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.chat_tag_id,
                 'key', s.lead_source, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT chat_tag_id, lead_source, count(*) n
                  FROM chats GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals', coalesce((
        -- Chats that arrived at each main tag in the period, once per
        -- chat however often it came back (see `arrived`).
        SELECT jsonb_agg(jsonb_build_object('tag_id', s.to_tag_id,
                 'sub_tag_id', s.to_sub_tag_id, 'chats', s.n) ORDER BY s.n DESC)
          FROM (SELECT to_tag_id, to_sub_tag_id, count(*) n
                  FROM arrived GROUP BY 1, 2) s), '[]'::jsonb),
      'arrivals_daily', coalesce((
        SELECT jsonb_agg(jsonb_build_object('day', s.day, 'tag_id', s.to_tag_id,
                 'chats', s.n) ORDER BY s.day)
          FROM (SELECT to_char((changed_at AT TIME ZONE v_tz)::date, 'YYYY-MM-DD') AS day,
                       to_tag_id, count(DISTINCT conversation_id) n
                  FROM moves
                 WHERE from_tag_id IS DISTINCT FROM to_tag_id
                 GROUP BY 1, 2) s), '[]'::jsonb)
    )
  );
END;
$$;

-- ---------- 4. Grants ----------

REVOKE ALL ON FUNCTION public.report_caller_is_owner(), public.report_can_open(text),
  public.report_my_access(), public.report_access_list(text),
  public.report_access_set(text, uuid[]),
  public.chat_tag_report(timestamptz, timestamptz, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.report_caller_is_owner(), public.report_can_open(text),
  public.report_my_access(), public.report_access_list(text),
  public.report_access_set(text, uuid[]),
  public.chat_tag_report(timestamptz, timestamptz, text)
  TO authenticated;
