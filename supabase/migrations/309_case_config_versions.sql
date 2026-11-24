-- ============================================================
-- 309_case_config_versions.sql
--
-- Three case settings were saved over whatever another admin had saved
-- meanwhile: a bank's stage list, a bank + product's file spec, and the
-- approval of a customer wording (an owner could approve text they never
-- read). Each gets an overload that also takes what the page had loaded
-- and refuses (STAGES_CHANGED, SPEC_CHANGED, TEMPLATE_CHANGED) when it is
-- no longer what is stored.
--
-- Overloads without defaults, on purpose: PostgREST picks by argument
-- names, so the running build keeps calling the old ones, and the old
-- bodies stay in their own files (122, 181, 183), so re-applying one of
-- those undoes nothing here. Each overload takes the lock, compares, then
-- calls the old function in the same transaction.
--
-- The stage overload also answers which Compass statuses (151) and
-- deadline rules (124) point to a stage the new list drops; it saves
-- nothing until the caller confirms (p_confirm).
-- ============================================================

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.case_bank_stages_set(
  p_actor uuid, p_account uuid, p_bank_code text, p_stages text[],
  p_expected text[], p_confirm boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_old      text[];
  v_new      text[] := CASE WHEN coalesce(cardinality(p_stages), 0) = 0
                            THEN public.case_default_stages() ELSE p_stages END;
  v_dropped  text[];
  v_mappings jsonb;
  v_sla      jsonb;
  v_count    integer;
BEGIN
  IF coalesce(public.case_account_role(p_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure stages of workspace %', p_actor, p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- The lock of the 4-argument function, taken before the comparison.
  PERFORM 1 FROM public.case_banks b WHERE b.account_id = p_account AND b.code = p_bank_code FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank % is not a bank of this workspace', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'BANK_UNKNOWN';
  END IF;
  v_old := public.case_stages_for_bank(p_account, p_bank_code);
  IF p_expected IS NOT NULL AND v_old IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'bank %: the stage list was changed meanwhile', p_bank_code
      USING ERRCODE = 'check_violation', HINT = 'STAGES_CHANGED';
  END IF;
  SELECT coalesce(array_agg(s), '{}') INTO v_dropped FROM unnest(v_old) s WHERE NOT (s = ANY (v_new));
  SELECT coalesce(jsonb_agg(jsonb_build_object('status', m.status_label, 'stage', m.stage) ORDER BY m.status_key), '[]')
    INTO v_mappings
    FROM public.case_status_stage_map m
   WHERE m.account_id = p_account AND m.stage = ANY (v_dropped);
  SELECT coalesce(jsonb_agg(jsonb_build_object('stage', l.stage, 'timer', l.timer) ORDER BY l.stage, l.timer), '[]')
    INTO v_sla
    FROM public.case_sla_config l
   WHERE l.account_id = p_account AND l.bank_code = p_bank_code AND l.stage = ANY (v_dropped);
  IF p_confirm IS NOT TRUE AND (v_mappings <> '[]' OR v_sla <> '[]') THEN
    RETURN jsonb_build_object('saved', false, 'mappings', v_mappings, 'sla', v_sla);
  END IF;
  v_count := public.case_bank_stages_set(p_actor, p_account, p_bank_code, p_stages);
  RETURN jsonb_build_object('saved', true, 'count', v_count, 'mappings', v_mappings, 'sla', v_sla);
END;
$function$;

CREATE OR REPLACE FUNCTION public.case_file_spec_set(
  p_actor uuid, p_bank_code text, p_product text, p_rows jsonb, p_expected jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_account uuid;
  v_stored  jsonb;
BEGIN
  SELECT p.account_id INTO v_account FROM public.profiles p
   WHERE p.user_id = p_actor AND p.is_active AND p.deactivated_at IS NULL;
  IF v_account IS NULL OR coalesce(public.case_account_role(v_account, p_actor) IN ('super_admin', 'admin'), false) IS NOT TRUE THEN
    RAISE EXCEPTION '% may not configure file specs', p_actor
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  -- Exclusive: 181's own FOR SHARE would let two saves compare at once.
  PERFORM 1 FROM public.case_banks b
   WHERE b.account_id = v_account AND b.code = p_bank_code FOR NO KEY UPDATE;
  IF p_expected IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(to_jsonb(s) - 'account_id' - 'bank_code' - 'product' ORDER BY s.position, s.doc_key), '[]'::jsonb)
      INTO v_stored
      FROM public.case_file_specs s
     WHERE s.account_id = v_account AND s.bank_code = p_bank_code
       AND lower(btrim(s.product)) = lower(btrim(p_product));
    IF v_stored IS DISTINCT FROM p_expected THEN
      RAISE EXCEPTION 'the file spec of % / % was changed meanwhile', p_bank_code, p_product
        USING ERRCODE = 'check_violation', HINT = 'SPEC_CHANGED';
    END IF;
  END IF;
  RETURN public.case_file_spec_set(p_actor, p_bank_code, p_product, p_rows);
END;
$function$;

-- Answers the approved row.
CREATE OR REPLACE FUNCTION public.case_intake_template_approve(
  p_actor uuid, p_account uuid, p_kind text, p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  t public.case_intake_templates%ROWTYPE;
BEGIN
  IF public.case_account_role(p_account, p_actor) IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'NOT_ALLOWED: only an owner may approve the intake wording of %', p_account
      USING ERRCODE = 'insufficient_privilege', HINT = 'NOT_ALLOWED';
  END IF;
  SELECT * INTO t FROM public.case_intake_templates x
   WHERE x.account_id = p_account AND x.kind = p_kind FOR UPDATE;
  IF FOUND AND p_expected_updated_at IS NOT NULL
     AND t.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'TEMPLATE_CHANGED: the % wording was changed meanwhile', p_kind
      USING ERRCODE = 'check_violation', HINT = 'TEMPLATE_CHANGED';
  END IF;
  PERFORM public.case_intake_template_approve(p_actor, p_account, p_kind);
  SELECT * INTO t FROM public.case_intake_templates x
   WHERE x.account_id = p_account AND x.kind = p_kind;
  RETURN jsonb_build_object('kind', t.kind, 'body', t.body, 'approved', t.approved,
    'updated_at', to_jsonb(t.updated_at));
END;
$function$;

REVOKE ALL ON FUNCTION public.case_bank_stages_set(uuid, uuid, text, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_bank_stages_set(uuid, uuid, text, text[], text[], boolean) TO service_role;
REVOKE ALL ON FUNCTION public.case_file_spec_set(uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_file_spec_set(uuid, text, text, jsonb, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.case_intake_template_approve(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.case_intake_template_approve(uuid, uuid, text, timestamptz) TO service_role;

RESET lock_timeout;
