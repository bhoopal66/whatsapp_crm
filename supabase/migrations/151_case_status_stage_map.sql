-- ============================================================
-- 151_case_status_stage_map.sql — an admin says which case stage a
-- Compass status means.
--
-- 137 moves a case to the stage of its bank's list whose name equals
-- the submission's `status` (`_` read as a space, case-insensitive).
-- Compass now reports its own names ("To Submit", "Returned to RO",
-- "Awaiting Customer Response", "Bank Review", …), which match no stage,
-- so cases stopped moving. This adds a per-account map from a status to
-- a stage, consulted before 137's name rule.
--
--  * case_status_key(text): the map's key — upper case, `_` read as a
--    space, blank runs collapsed, trimmed. More forgiving than 137's
--    name rule, which is kept byte-for-byte.
--  * case_status_stage_map (account, status_key) -> stage. Never a
--    final status (APPROVED / DECLINED / WITHDRAWN / CLOSED close the
--    case in 137 and are not mappable), never a pre-submission or final
--    stage. Read by owner/admin of the active account; written only
--    through the RPCs below.
--  * case_status_map_set / _delete / _overview / _apply (p_actor first,
--    service_role only, as 134's case_settings_set): the actor must be a
--    live owner/admin of their ACTIVE account, and that account is the
--    one acted on. The route authenticates the caller first.
--  * case_apply_submission_status: in the non-final branch only, the
--    map is looked up first; its stage is used when it is in that case's
--    bank list (and not pre-submission / final), otherwise 137's name
--    rule runs unchanged. The final branch, the history row (actor NULL,
--    role 'api'), signature, SECURITY DEFINER, search_path and grants are
--    137's.
--  * case_status_map_apply moves the account's open cases already
--    holding a status through case_apply_submission_status — the path a
--    Compass PATCH takes — so stage rules, history, SLA triggers and the
--    webhook outbox all hold. It only moves a case FORWARD: the resolved
--    stage must come later in that case's bank list than its current
--    stage, because a stored status may be older than a person's move.
--    A Compass PATCH is not forward-only: a fresh status is authoritative.
--  * case_status_target_stage(account, bank, status): the stage a
--    non-final status resolves to for one bank list (map, then 137's name
--    rule), the one rule case_apply_submission_status, the overview and
--    apply share.
--
-- SECURITY DEFINER over RLS-forced tables, so, as 122-137, this must be
-- applied by a superuser or BYPASSRLS role.
--
-- Re-runnable: IF NOT EXISTS, DROP ... IF EXISTS, CREATE OR REPLACE.
-- ============================================================

SET lock_timeout = '10s';

-- ---------- 1. The key ----------

CREATE OR REPLACE FUNCTION public.case_status_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT btrim(regexp_replace(replace(upper(p), '_', ' '), '[[:space:]]+', ' ', 'g'))
$$;

COMMENT ON FUNCTION public.case_status_key(text) IS
  'The status map''s key: upper case, _ read as a space, blank runs collapsed, trimmed. Migration 151.';

-- ---------- 2. The map ----------

CREATE TABLE IF NOT EXISTS public.case_status_stage_map (
  account_id   uuid        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  status_key   text        NOT NULL,
  status_label text        NOT NULL,
  stage        text        NOT NULL,
  source       text        NOT NULL,
  suggested_p  real        NULL,
  created_by   uuid        NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_status_stage_map_pkey PRIMARY KEY (account_id, status_key),
  CONSTRAINT case_status_stage_map_key_check
    CHECK (status_key = public.case_status_key(status_label) AND status_key <> ''),
  CONSTRAINT case_status_stage_map_label_check
    CHECK (char_length(status_label) BETWEEN 1 AND 64),
  CONSTRAINT case_status_stage_map_not_final_status
    CHECK (status_key NOT IN ('APPROVED', 'DECLINED', 'WITHDRAWN', 'CLOSED')),
  CONSTRAINT case_status_stage_map_stage_check
    CHECK (stage !~ '^[[:space:]]*$' AND char_length(stage) <= 100),
  CONSTRAINT case_status_stage_map_stage_not_presub
    CHECK (NOT public.case_stage_is_presub(stage)),
  CONSTRAINT case_status_stage_map_stage_not_final
    CHECK (stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')),
  CONSTRAINT case_status_stage_map_source_check
    CHECK (source IN ('admin', 'suggestion')),
  CONSTRAINT case_status_stage_map_p_check
    CHECK (suggested_p IS NULL OR (suggested_p >= 0 AND suggested_p <= 1))
);

COMMENT ON TABLE public.case_status_stage_map IS
  'Per-account map from a Compass submission status (status_key = case_status_key(status_label)) to a case stage, consulted by case_apply_submission_status before 137''s name rule. source: admin (typed) or suggestion (accepted, with suggested_p). Written only through case_status_map_set / case_status_map_delete. Migration 151.';

ALTER TABLE public.case_status_stage_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_status_stage_map FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS case_status_stage_map_select ON public.case_status_stage_map;
CREATE POLICY case_status_stage_map_select ON public.case_status_stage_map FOR SELECT TO authenticated
  USING (account_id = (SELECT public.current_account_id())
         AND public.is_account_member(account_id, 'admin'));

REVOKE ALL ON public.case_status_stage_map FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.case_status_stage_map TO authenticated, service_role;

-- ---------- 3. Helpers ----------

-- The actor's active account, when they are a live owner/admin there;
-- NOT_ALLOWED otherwise.
CREATE OR REPLACE FUNCTION public.case_status_map_account(p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid;
BEGIN
  SELECT p.account_id INTO v_acct FROM public.profiles p
   WHERE p.user_id = p_actor AND p.is_active AND p.deactivated_at IS NULL
   LIMIT 1;
  IF v_acct IS NULL
     OR coalesce(public.case_account_role(v_acct, p_actor), '') NOT IN ('super_admin', 'admin') THEN
    RAISE EXCEPTION 'NOT_ALLOWED: % may not change the case status map', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  RETURN v_acct;
END;
$$;

COMMENT ON FUNCTION public.case_status_map_account(uuid) IS
  'The actor''s active account if they are a live owner/admin there, else NOT_ALLOWED. Internal to the 151 RPCs. Migration 151.';

-- Every stage a status may be mapped to in the account: the default
-- list's, then the per-bank lists' others, never pre-submission or final.
CREATE OR REPLACE FUNCTION public.case_status_map_targets(p_account uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(t.stage ORDER BY t.rank, t.pos, t.stage), '{}')
    FROM (
      SELECT x.stage, min(x.rank) AS rank, min(x.pos) AS pos
        FROM (
          SELECT d.s AS stage, 0 AS rank, d.o::int AS pos
            FROM unnest(public.case_default_stages()) WITH ORDINALITY d(s, o)
          UNION ALL
          SELECT b.stage, 1, b.position FROM public.case_bank_stages b
           WHERE b.account_id = p_account
        ) x
       WHERE NOT public.case_stage_is_presub(x.stage)
         AND x.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')
       GROUP BY x.stage
    ) t
$$;

COMMENT ON FUNCTION public.case_status_map_targets(uuid) IS
  'The stages a status may be mapped to: default list order first, then other per-bank stages; never pre-submission or final. Migration 151.';

-- The stage a non-final status resolves to in (account, bank)'s list:
-- the account's mapped stage when that list has it, else 137's name rule
-- (the list's stage of the same name, `_` read as a space,
-- case-insensitive); never pre-submission or final; NULL when neither.
CREATE OR REPLACE FUNCTION public.case_status_target_stage(p_account uuid, p_bank text, p_status text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH l AS (SELECT public.case_stages_for_bank(p_account, p_bank) AS stages)
  SELECT coalesce(
    (SELECT m.stage
       FROM public.case_status_stage_map m, l
      WHERE m.account_id = p_account
        AND m.status_key = public.case_status_key(p_status)
        AND m.stage = ANY (l.stages)
        AND NOT public.case_stage_is_presub(m.stage)
        AND m.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')),
    (SELECT s.stage
       FROM l, unnest(l.stages) AS s(stage)
      WHERE upper(s.stage) = regexp_replace(replace(upper(btrim(coalesce(p_status, ''))), '_', ' '),
                                            '[[:space:]]+', ' ', 'g')
        AND NOT public.case_stage_is_presub(s.stage)
        AND s.stage NOT IN ('Approved', 'Declined', 'Withdrawn', 'Closed')
      LIMIT 1))
$$;

COMMENT ON FUNCTION public.case_status_target_stage(uuid, text, text) IS
  'The stage a non-final status resolves to in an (account, bank) list: the mapped stage when the list has it, else the same-named stage (137); never pre-submission or final; NULL when neither. Migration 151.';

-- ---------- 4. RPCs ----------

-- Maps p_status to p_stage in the actor's active account (upsert on the
-- key). Returns the stored row.
CREATE OR REPLACE FUNCTION public.case_status_map_set(p_actor uuid, p_status text, p_stage text,
  p_source text, p_suggested_p real)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.case_status_map_account(p_actor);
  v_key  text := public.case_status_key(p_status);
  m      public.case_status_stage_map%ROWTYPE;
BEGIN
  IF v_key IS NULL OR v_key = '' OR char_length(p_status) > 64 THEN
    RAISE EXCEPTION 'STATUS_INVALID: a status is 1-64 characters'
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  IF v_key IN ('APPROVED', 'DECLINED', 'WITHDRAWN', 'CLOSED') THEN
    RAISE EXCEPTION 'STATUS_FINAL: % closes the case and cannot be mapped', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_FINAL';
  END IF;
  IF p_stage IS NULL OR public.case_stage_is_presub(p_stage)
     OR p_stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RAISE EXCEPTION 'STAGE_NOT_ALLOWED: % is a pre-submission or final stage', p_stage
      USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_ALLOWED';
  END IF;
  IF NOT (p_stage = ANY (public.case_status_map_targets(v_acct))) THEN
    RAISE EXCEPTION 'STAGE_NOT_CONFIGURED: % is in none of the account''s stage lists', p_stage
      USING ERRCODE = 'check_violation', HINT = 'STAGE_NOT_CONFIGURED';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('admin', 'suggestion')
     OR (p_suggested_p IS NOT NULL AND NOT (p_suggested_p >= 0 AND p_suggested_p <= 1)) THEN
    RAISE EXCEPTION 'SETTING_INVALID: source is admin or suggestion, suggested_p is 0..1'
      USING ERRCODE = 'check_violation', HINT = 'SETTING_INVALID';
  END IF;
  INSERT INTO public.case_status_stage_map AS s
    (account_id, status_key, status_label, stage, source, suggested_p, created_by)
  VALUES (v_acct, v_key, p_status, p_stage, p_source, p_suggested_p, p_actor)
  ON CONFLICT (account_id, status_key) DO UPDATE
    SET status_label = EXCLUDED.status_label, stage = EXCLUDED.stage, source = EXCLUDED.source,
        suggested_p = EXCLUDED.suggested_p, updated_at = now()
  RETURNING * INTO m;
  RETURN jsonb_build_object('status_key', m.status_key, 'status_label', m.status_label,
    'stage', m.stage, 'source', m.source, 'suggested_p', m.suggested_p);
END;
$$;

COMMENT ON FUNCTION public.case_status_map_set(uuid, text, text, text, real) IS
  'Owner/admin of the actor''s active account maps a Compass status to a stage (upsert). Refuses NOT_ALLOWED, STATUS_INVALID, STATUS_FINAL, STAGE_NOT_ALLOWED, STAGE_NOT_CONFIGURED, SETTING_INVALID. Migration 151.';

-- Removes p_status's mapping; true when one existed.
CREATE OR REPLACE FUNCTION public.case_status_map_delete(p_actor uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct uuid := public.case_status_map_account(p_actor);
BEGIN
  DELETE FROM public.case_status_stage_map s
   WHERE s.account_id = v_acct AND s.status_key = public.case_status_key(p_status);
  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.case_status_map_delete(uuid, text) IS
  'Owner/admin of the actor''s active account removes a status mapping; true when one existed. Migration 151.';

-- The settings card's data:
--   stages:   allowed targets (case_status_map_targets)
--   mapped:   [{status_key, status_label, stage, source, suggested_p,
--               open_cases, unresolved_open_cases}] — unresolved_open_cases
--             counts the open cases holding the status that it moves
--             nowhere: their bank list has neither the mapped stage nor
--             a stage of the same name.
--   unmapped: [{status_key, sample_label, open_cases}] — statuses with no
--             map row, held by open cases whose bank list has no stage of
--             that name (counted per case). A mapped status is never
--             listed here: there is one mapping per status account-wide,
--             so offering it again would silently re-target it.
CREATE OR REPLACE FUNCTION public.case_status_map_overview(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct    uuid := public.case_status_map_account(p_actor);
  v_targets text[] := public.case_status_map_targets(v_acct);
  v_mapped  jsonb;
  v_unmap   jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'status_key', m.status_key, 'status_label', m.status_label, 'stage', m.stage,
           'source', m.source, 'suggested_p', m.suggested_p,
           'open_cases', o.open_cases, 'unresolved_open_cases', o.unresolved)
         ORDER BY m.status_key), '[]'::jsonb)
    INTO v_mapped
    FROM public.case_status_stage_map m
    CROSS JOIN LATERAL (
      SELECT count(*) AS open_cases,
             count(*) FILTER (WHERE public.case_status_target_stage(c.account_id, c.bank_code,
                                                                     g.submission_status) IS NULL) AS unresolved
        FROM public.cases c
        JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
       WHERE c.account_id = v_acct AND c.closed_at IS NULL
         AND public.case_status_key(g.submission_status) = m.status_key
    ) o
   WHERE m.account_id = v_acct;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'status_key', u.status_key, 'sample_label', u.sample_label, 'open_cases', u.open_cases)
         ORDER BY u.open_cases DESC, u.status_key), '[]'::jsonb)
    INTO v_unmap
    FROM (
      SELECT h.status_key, min(h.submission_status) AS sample_label, count(*) AS open_cases
        FROM (
          SELECT public.case_status_key(g.submission_status) AS status_key, g.submission_status,
                 c.account_id, c.bank_code
            FROM public.cases c
            JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
           WHERE c.account_id = v_acct AND c.closed_at IS NULL
             AND g.submission_status IS NOT NULL
        ) h
       WHERE h.status_key <> ''
         AND h.status_key NOT IN ('APPROVED', 'DECLINED', 'WITHDRAWN', 'CLOSED')
         -- a mapped status is listed under mapped, never here
         AND NOT EXISTS (SELECT 1 FROM public.case_status_stage_map m
                          WHERE m.account_id = v_acct AND m.status_key = h.status_key)
         -- 137's name rule leaves it unresolved for this case's list
         AND public.case_status_target_stage(h.account_id, h.bank_code, h.submission_status) IS NULL
       GROUP BY h.status_key
    ) u;

  RETURN jsonb_build_object('stages', to_jsonb(v_targets), 'mapped', v_mapped, 'unmapped', v_unmap);
END;
$$;

COMMENT ON FUNCTION public.case_status_map_overview(uuid) IS
  'Owner/admin of the actor''s active account: {stages, mapped, unmapped} for the status map settings card. Migration 151.';

-- Re-applies p_status to the open cases of the account whose group
-- currently holds it, through case_apply_submission_status, FORWARD ONLY:
-- a case moves only when the stage the status resolves to for its bank
-- list (case_status_target_stage) comes later in that list than the
-- case's current stage. The stored status may predate a person's later
-- move, so a case already at or past that stage, a case whose list
-- resolves the status to nothing, and a case whose current stage is not
-- in its list (no position to compare) are counted as unchanged. The
-- cases are locked first and each is re-read under its lock, so the
-- comparison sees the stage the move replaces and the case's current
-- status (one Compass changed meanwhile is skipped); the mapping row is
-- held FOR SHARE for the duration. A Compass PATCH stays authoritative
-- and is not forward-only.
CREATE OR REPLACE FUNCTION public.case_status_map_apply(p_actor uuid, p_status text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_acct  uuid := public.case_status_map_account(p_actor);
  v_key   text := public.case_status_key(p_status);
  r        record;
  v_status text;
  v_stage  text;
  v_stages text[];
  v_target text;
  v_moved  integer := 0;
  v_same   integer := 0;
BEGIN
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'STATUS_INVALID: a status is required'
      USING ERRCODE = 'check_violation', HINT = 'STATUS_INVALID';
  END IF;
  IF v_key IN ('APPROVED', 'DECLINED', 'WITHDRAWN', 'CLOSED') THEN
    RAISE EXCEPTION 'STATUS_FINAL: % closes the case and is not re-applied here', p_status
      USING ERRCODE = 'check_violation', HINT = 'STATUS_FINAL';
  END IF;
  -- Hold the mapping still while it is applied: a re-map committed in
  -- the middle of the loop would otherwise make case_apply_submission_status
  -- resolve a different stage than the one the forward check compared.
  PERFORM 1 FROM public.case_status_stage_map m
   WHERE m.account_id = v_acct AND m.status_key = v_key
     FOR SHARE;
  FOR r IN
    SELECT c.id AS case_id, g.id
      FROM public.cases c
      JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
     WHERE c.account_id = v_acct AND c.closed_at IS NULL
       AND public.case_status_key(g.submission_status) = v_key
     ORDER BY c.id
       FOR UPDATE OF c
  LOOP
    -- Re-read under the case lock, in a new statement: the loop's rows
    -- come from its opening snapshot, and Compass may have reported a
    -- newer status for this case since (sg_note_submission_status writes
    -- the group, then case_apply_submission_status moves the case). A
    -- case whose status no longer has this key is left alone, so a fresh
    -- Compass status is never overridden by a stale one. The group is
    -- read, not locked: the PATCH writes the group before the case, so
    -- locking it after the case could deadlock.
    SELECT g.submission_status, c.stage,
           public.case_stages_for_bank(c.account_id, c.bank_code),
           public.case_status_target_stage(c.account_id, c.bank_code, g.submission_status)
      INTO v_status, v_stage, v_stages, v_target
      FROM public.cases c
      JOIN public.submission_groups g ON g.id = c.group_id AND g.account_id = c.account_id
     WHERE c.id = r.case_id AND c.closed_at IS NULL;
    IF NOT FOUND OR public.case_status_key(v_status) IS DISTINCT FROM v_key THEN
      v_same := v_same + 1;
      CONTINUE;
    END IF;
    -- Forward only; a NULL position never compares true.
    IF array_position(v_stages, v_target) > array_position(v_stages, v_stage)
       AND public.case_apply_submission_status(r.id, v_status) THEN
      v_moved := v_moved + 1;
    ELSE
      v_same := v_same + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('moved', v_moved, 'unchanged', v_same);
END;
$$;

COMMENT ON FUNCTION public.case_status_map_apply(uuid, text) IS
  'Owner/admin of the actor''s active account: re-applies a status to the open cases holding it, through case_apply_submission_status, moving a case only forward in its bank list (a case at or past the resolved stage is unchanged); {moved, unchanged}. Migration 151.';

-- ---------- 5. case_apply_submission_status ----------

-- 137's case_apply_submission_status, plus the map lookup (151).
CREATE OR REPLACE FUNCTION public.case_apply_submission_status(p_group uuid, p_status text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c       public.cases%ROWTYPE;
  v_norm  text := upper(btrim(coalesce(p_status, '')));
  v_stage text;
BEGIN
  v_stage := CASE v_norm
               WHEN 'APPROVED'  THEN 'Approved'
               WHEN 'DECLINED'  THEN 'Declined'
               WHEN 'WITHDRAWN' THEN 'Withdrawn'
               WHEN 'CLOSED'    THEN 'Closed'
             END;
  IF v_stage IS NOT NULL THEN
    SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
    IF NOT FOUND OR c.closed_at IS NOT NULL THEN
      RETURN false;
    END IF;
    UPDATE public.cases x
       SET stage = v_stage,
           outcome = CASE WHEN v_stage = 'Closed' THEN x.outcome ELSE v_stage END,
           closed_at = now(),
           group_ended_at = coalesce(x.group_ended_at,
             (SELECT g.ended_at FROM public.submission_groups g
               WHERE g.id = c.group_id AND g.status = 'ENDED'))
     WHERE x.id = c.id;
    INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
    VALUES (c.id, c.account_id, c.stage, v_stage,
            CASE WHEN v_stage = 'Closed' THEN c.outcome ELSE v_stage END, NULL, 'api');
    RETURN true;
  END IF;

  -- 137: a non-final status names a stage.
  IF v_norm = '' THEN
    RETURN false;
  END IF;
  SELECT * INTO c FROM public.cases x WHERE x.group_id = p_group FOR UPDATE;
  IF NOT FOUND OR c.closed_at IS NOT NULL
     OR c.stage IN ('Approved', 'Declined', 'Withdrawn', 'Closed') THEN
    RETURN false;
  END IF;
  -- 151: the account's map first, when its stage is in this case's list,
  -- else 137's name rule.
  v_stage := public.case_status_target_stage(c.account_id, c.bank_code, p_status);
  IF v_stage IS NULL OR v_stage = c.stage THEN
    RETURN false;
  END IF;
  UPDATE public.cases x SET stage = v_stage WHERE x.id = c.id;
  INSERT INTO public.case_stage_history (case_id, account_id, from_stage, to_stage, outcome, actor_id, actor_role)
  VALUES (c.id, c.account_id, c.stage, v_stage, c.outcome, NULL, 'api');
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.case_apply_submission_status(uuid, text) IS
  'Applies a Compass submission status to its case as the API (actor NULL, role api): a final status closes it (122); another moves it to the account''s mapped stage when that is in the case''s bank list (151), else to the stage of the same name (137). Migration 151.';

-- ---------- 6. Privileges ----------

REVOKE ALL ON FUNCTION
  public.case_status_key(text),
  public.case_status_map_account(uuid),
  public.case_status_map_targets(uuid),
  public.case_status_target_stage(uuid, text, text),
  public.case_status_map_set(uuid, text, text, text, real),
  public.case_status_map_delete(uuid, text),
  public.case_status_map_overview(uuid),
  public.case_status_map_apply(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.case_status_key(text),
  public.case_status_map_set(uuid, text, text, text, real),
  public.case_status_map_delete(uuid, text),
  public.case_status_map_overview(uuid),
  public.case_status_map_apply(uuid, text)
  TO service_role;

RESET lock_timeout;
