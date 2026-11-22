-- ============================================================
-- 251: Declined recycling
--
-- A list of customers whose case ended Declined / Withdrawn, or whose chat
-- carries a "declined-type" chat tag an admin picked, at least N days
-- ago, so people can start a campaign or file follow-up tasks. It only
-- reads and files tasks: nothing is ever sent from here.
--
--   recycle_settings           one row per workspace: days (1..730,
--                              default 90), the declined-type main chat
--                              tags, and the case outcomes that count.
--                              No row = the defaults. Read by team
--                              leaders and up; written only through
--                              recycle_settings_set (owner / admin).
--   recycle_candidates(...)    SECURITY INVOKER: contacts RLS (and the
--                              cases / conversations RLS) decide what the
--                              caller sees. One row per contact, for
--                              their latest ending. Always left out:
--                              opted out, do-not-contact, a case or
--                              lead still open (any bank), a customer
--                              message newer than the ending.
--   recycle_excluded_among     SECURITY DEFINER helper for the last two
--                              rules: "open case" and "newer inbound"
--                              must hold whatever the caller may see
--                              (another agent's lead still means the
--                              customer is active). It answers only for
--                              ids the caller passes and its own
--                              workspace's contacts.
--   recycle_create_tasks(...)  SECURITY INVOKER: one follow_up task per
--                              eligible contact, as the caller (source
--                              'chat'), assigned to the contact's owner
--                              when a live staff member, else the caller.
--                              source_ref recycle:<contact>:<date> makes
--                              a second run a no-op.
--
-- The chat "ended" date is the chat's last message: no timestamp of the
-- tag change is stored (docs/recycle.md).
--
-- Must be applied as a superuser or BYPASSRLS role (the helper reads
-- RLS-forced tables). Re-runnable.
-- ============================================================

SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION '251 must be applied by a superuser or BYPASSRLS role (recycle_excluded_among reads RLS tables)';
  END IF;
END $$;

-- ---------- 1. Settings ----------

CREATE TABLE IF NOT EXISTS public.recycle_settings (
  account_id    uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  days          integer NOT NULL DEFAULT 90,
  chat_tag_ids  uuid[] NOT NULL DEFAULT '{}',
  case_outcomes text[] NOT NULL DEFAULT ARRAY['Declined', 'Withdrawn']::text[],
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT recycle_settings_days_check CHECK (days BETWEEN 1 AND 730),
  CONSTRAINT recycle_settings_outcomes_check
    CHECK (case_outcomes <@ ARRAY['Declined', 'Withdrawn']::text[])
);

COMMENT ON TABLE public.recycle_settings IS
  'Declined-recycling settings per workspace (251). No row = defaults (90 days, no chat tags, Declined + Withdrawn). Written only by recycle_settings_set.';

ALTER TABLE public.recycle_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recycle_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.recycle_settings TO authenticated;

DROP POLICY IF EXISTS recycle_settings_select ON public.recycle_settings;
CREATE POLICY recycle_settings_select ON public.recycle_settings FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND (SELECT public.current_role_rank()) >= 3);

CREATE OR REPLACE FUNCTION public.recycle_settings_set(
  p_days          integer,
  p_chat_tag_ids  uuid[],
  p_case_outcomes text[]
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_acct uuid := public.current_account_id();
  v_tags uuid[] := coalesce(p_chat_tag_ids, '{}');
  v_outs text[] := coalesce(p_case_outcomes, ARRAY['Declined', 'Withdrawn']::text[]);
BEGIN
  IF v_acct IS NULL OR coalesce(public.current_role_rank(), 0) < 4 THEN
    RAISE EXCEPTION 'Only an owner or admin can change the recycling settings'
      USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 730 THEN
    RAISE EXCEPTION 'days must be between 1 and 730' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_outs <@ ARRAY['Declined', 'Withdrawn']::text[]) THEN
    RAISE EXCEPTION 'unknown case outcome' USING ERRCODE = '22023';
  END IF;
  -- Only main tags of this workspace.
  IF EXISTS (
    SELECT 1 FROM unnest(v_tags) x
     WHERE NOT EXISTS (SELECT 1 FROM public.chat_tags t
                        WHERE t.id = x AND t.account_id = v_acct AND t.parent_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'chat tags must be main tags of this workspace' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.recycle_settings AS s (account_id, days, chat_tag_ids, case_outcomes, updated_at, updated_by)
  VALUES (v_acct, p_days, v_tags, v_outs, now(), auth.uid())
  ON CONFLICT (account_id) DO UPDATE
    SET days = EXCLUDED.days, chat_tag_ids = EXCLUDED.chat_tag_ids,
        case_outcomes = EXCLUDED.case_outcomes, updated_at = now(), updated_by = auth.uid();
END
$$;

REVOKE ALL ON FUNCTION public.recycle_settings_set(integer, uuid[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recycle_settings_set(integer, uuid[], text[]) TO authenticated;

-- ---------- 2. Exclusion helper ----------

CREATE INDEX IF NOT EXISTS cases_account_ended_idx
  ON public.cases (account_id, closed_at)
  WHERE contact_id IS NOT NULL AND outcome IN ('Declined', 'Withdrawn');

CREATE OR REPLACE FUNCTION public.recycle_excluded_among(p_contact_ids uuid[], p_ended timestamptz[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT x.cid
    FROM unnest(p_contact_ids, p_ended) AS x(cid, ended)
   WHERE public.current_account_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.contacts ct
                  WHERE ct.id = x.cid AND ct.account_id = public.current_account_id())
     AND (
       -- Active again: a case or lead of any bank is still open.
       EXISTS (SELECT 1 FROM public.cases c
                WHERE c.account_id = public.current_account_id()
                  AND c.contact_id = x.cid AND c.closed_at IS NULL)
       -- Came back: the customer wrote after the ending.
       OR EXISTS (SELECT 1
                    FROM public.conversations cv
                    JOIN public.messages m ON m.conversation_id = cv.id
                   WHERE cv.account_id = public.current_account_id()
                     AND cv.contact_id = x.cid
                     AND m.sender_type = 'customer'
                     AND m.created_at > x.ended)
     )
$$;

COMMENT ON FUNCTION public.recycle_excluded_among(uuid[], timestamptz[]) IS
  'Of the given contacts (own workspace only): those with a case still open or a customer message newer than their ending (251). Returns only ids the caller passed.';

REVOKE ALL ON FUNCTION public.recycle_excluded_among(uuid[], timestamptz[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recycle_excluded_among(uuid[], timestamptz[]) TO authenticated;

-- ---------- 3. The list ----------

CREATE OR REPLACE FUNCTION public.recycle_candidates(
  p_days        integer DEFAULT NULL,
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0,
  p_search      text    DEFAULT NULL,
  p_contact_ids uuid[]  DEFAULT NULL
) RETURNS TABLE (
  contact_id        uuid,
  name              text,
  phone             text,
  owner_id          uuid,
  owner_name        text,
  source            text,
  case_id           uuid,
  conversation_id   uuid,
  bank_code         text,
  outcome           text,
  reason_code       text,
  chat_tag_name     text,
  ended_at          timestamptz,
  total_count       bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_acct  uuid := public.current_account_id();
  v_set   public.recycle_settings;
  v_days  integer;
  v_lim   integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_off   integer := greatest(coalesce(p_offset, 0), 0);
  v_term  text := nullif(btrim(coalesce(p_search, '')), '');
  v_dig   text;
  v_like  text;
BEGIN
  IF v_acct IS NULL OR coalesce(public.current_role_rank(), 0) < 3 THEN
    RETURN;
  END IF;
  SELECT * INTO v_set FROM public.recycle_settings s WHERE s.account_id = v_acct;
  v_days := coalesce(p_days, v_set.days, 90);
  IF v_days < 1 OR v_days > 730 THEN
    RAISE EXCEPTION 'days must be between 1 and 730' USING ERRCODE = '22023';
  END IF;
  IF v_term IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(lower(v_term), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_dig := nullif(regexp_replace(v_term, '\D', '', 'g'), '');
  END IF;

  RETURN QUERY
  WITH ends AS (
    SELECT c.contact_id AS cid, 'case'::text AS src, c.id AS case_id, NULL::uuid AS conv_id,
           c.bank_code, c.outcome, r.reason_code, NULL::text AS tag_name, c.closed_at AS ended
      FROM public.cases c
      LEFT JOIN public.case_outcome_reasons r ON r.case_id = c.id AND r.account_id = c.account_id
     WHERE c.account_id = v_acct AND c.contact_id IS NOT NULL
       AND c.outcome = ANY (coalesce(v_set.case_outcomes, ARRAY['Declined', 'Withdrawn']::text[]))
       AND c.closed_at IS NOT NULL
    UNION ALL
    SELECT cv.contact_id, 'chat', NULL::uuid, cv.id, NULL::text, NULL::text, NULL::text, t.name, cv.last_message_at
      FROM public.conversations cv
      JOIN public.chat_tags t ON t.id = cv.chat_tag_id AND t.account_id = cv.account_id
     WHERE cv.account_id = v_acct AND cv.personal_owner_id IS NULL
       AND cv.last_message_at IS NOT NULL
       AND cv.chat_tag_id = ANY (coalesce(v_set.chat_tag_ids, '{}'::uuid[]))
  ),
  -- The latest ending per customer decides: a newer one keeps them out.
  latest AS (
    SELECT DISTINCT ON (e.cid) e.*
      FROM ends e
     ORDER BY e.cid, e.ended DESC, e.src
  ),
  base AS MATERIALIZED (
    SELECT l.*, ct.name AS cname, ct.phone AS cphone, ct.user_id AS cowner
      FROM latest l
      JOIN public.contacts ct ON ct.id = l.cid AND ct.account_id = v_acct
     WHERE l.ended <= now() - make_interval(days => v_days)
       AND ct.opted_out_at IS NULL
       AND ct.do_not_contact_at IS NULL
       AND (p_contact_ids IS NULL OR l.cid = ANY (p_contact_ids))
       AND (v_term IS NULL
            OR lower(coalesce(ct.name, '')) LIKE v_like ESCAPE '\'
            OR (v_dig IS NOT NULL AND regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g') LIKE '%' || v_dig || '%'))
  ),
  gone AS MATERIALIZED (
    SELECT x AS cid
      FROM public.recycle_excluded_among(
             (SELECT array_agg(b.cid) FROM base b),
             (SELECT array_agg(b.ended) FROM base b)) x
  ),
  kept AS (
    SELECT b.* FROM base b WHERE NOT EXISTS (SELECT 1 FROM gone g WHERE g.cid = b.cid)
  )
  SELECT k.cid, k.cname, k.cphone, k.cowner, p.full_name, k.src, k.case_id, k.conv_id,
         k.bank_code, k.outcome, k.reason_code, k.tag_name, k.ended,
         count(*) OVER ()
    FROM kept k
    LEFT JOIN public.profiles p ON p.user_id = k.cowner AND p.account_id = v_acct
   ORDER BY k.ended DESC, k.cid
   LIMIT v_lim OFFSET v_off;
END
$$;

COMMENT ON FUNCTION public.recycle_candidates(integer, integer, integer, text, uuid[]) IS
  'Declined recycling (251): one row per contact the caller can see, for their latest declined/withdrawn case or declined-type chat that ended at least p_days ago (default: the workspace setting). Excludes opted-out, do-not-contact, open-case and came-back contacts. Team leader and up.';

REVOKE ALL ON FUNCTION public.recycle_candidates(integer, integer, integer, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recycle_candidates(integer, integer, integer, text, uuid[]) TO authenticated;

-- ---------- 4. Follow-up tasks ----------

CREATE OR REPLACE FUNCTION public.recycle_create_tasks(
  p_contact_ids uuid[],
  p_due_at      timestamptz DEFAULT NULL,
  p_days        integer     DEFAULT NULL
) RETURNS TABLE (created integer, already_filed integer, not_eligible integer)
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_acct   uuid := public.current_account_id();
  v_uid    uuid := auth.uid();
  v_ids    uuid[] := coalesce(p_contact_ids, '{}');
  r        record;
  v_assign uuid;
  v_n      integer;
  v_made   integer := 0;
  v_dup    integer := 0;
  v_seen   integer := 0;
BEGIN
  IF v_acct IS NULL OR v_uid IS NULL OR coalesce(public.current_role_rank(), 0) < 3 THEN
    RAISE EXCEPTION 'Only a team leader or above can file recycling tasks' USING ERRCODE = '42501';
  END IF;
  IF cardinality(v_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 contacts at a time' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT * FROM public.recycle_candidates(p_days, 1000, 0, NULL, v_ids)
  LOOP
    v_seen := v_seen + 1;
    v_assign := v_uid;
    IF r.owner_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.profiles p
          WHERE p.user_id = r.owner_id AND p.account_id = v_acct
            AND p.deactivated_at IS NULL
            AND p.account_role IN ('owner', 'admin', 'team_leader', 'agent')) THEN
      v_assign := r.owner_id;
    END IF;
    INSERT INTO public.tasks (account_id, kind, title, contact_id, conversation_id, assigned_to,
                              due_at, source, source_ref, created_by, meta)
    VALUES (v_acct, 'follow_up',
            left('Follow up: ' || coalesce(nullif(btrim(r.name), ''), r.phone, 'customer')
                 || ' (declined ' || to_char(r.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ')', 300),
            r.contact_id, r.conversation_id, v_assign, p_due_at, 'chat',
            'recycle:' || r.contact_id::text || ':' || to_char(r.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
            v_uid, jsonb_build_object('recycle', true))
    ON CONFLICT (account_id, source, source_ref) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_made := v_made + 1; ELSE v_dup := v_dup + 1; END IF;
  END LOOP;

  created := v_made;
  already_filed := v_dup;
  not_eligible := greatest(cardinality(v_ids) - v_seen, 0);
  RETURN NEXT;
END
$$;

COMMENT ON FUNCTION public.recycle_create_tasks(uuid[], timestamptz, integer) IS
  'Files one follow_up task per eligible contact (251) as the caller, source chat, source_ref recycle:<contact>:<ended date> so a rerun adds nothing. RLS and tasks_guard decide what is allowed.';

REVOKE ALL ON FUNCTION public.recycle_create_tasks(uuid[], timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recycle_create_tasks(uuid[], timestamptz, integer) TO authenticated;
