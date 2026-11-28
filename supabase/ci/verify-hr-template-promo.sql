-- Migration 337: hr_automsg_template_set refuses promotional wording in a
-- Utility template (HINT TEMPLATE_PROMOTIONAL) through both overloads,
-- English case-insensitively and word-bounded, Arabic as a substring; a
-- refusal writes nothing; recruitment wording the editor allows still
-- saves. One statement, rolled back by the sentinel at its end.
DO $verify$
DECLARE
  u_own uuid := '00000000-0000-4000-8000-000000337001';
  a uuid; r text; b text;
BEGIN
  BEGIN
  INSERT INTO auth.users (id, email) VALUES (u_own, 'hp337-own@example.invalid');
  SELECT id INTO a FROM accounts WHERE owner_user_id = u_own;
  ASSERT a IS NOT NULL, 'fixture: auth.users trigger did not provision an account';

  EXECUTE $fn$
    CREATE FUNCTION pg_temp.hp337_as(p_uid uuid, p_sql text) RETURNS text LANGUAGE plpgsql AS $b$
    DECLARE v text; h text; st text;
    BEGIN
      BEGIN
        PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
        PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        EXECUTE p_sql INTO v;
        RESET ROLE;
        RETURN coalesce(v, 'ok');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE, h = PG_EXCEPTION_HINT;
        RESET ROLE;
        RETURN format('ERROR %s %s', st, h);
      END;
    END $b$ $fn$;

  -- ---------- refused: 317's overload, with the page's version ----------
  r := pg_temp.hp337_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Hi {name}, apply now'', '''', ''draft'', ''utility'', ''whatsapp'', NULL::timestamptz)::text');
  IF r IS DISTINCT FROM 'ERROR 22023 TEMPLATE_PROMOTIONAL' THEN
    RAISE EXCEPTION 'verify-hr-template-promo: apply now through the versioned save: %', r;
  END IF;

  -- ---------- refused: the 7-argument body, every channel ----------
  FOREACH b IN ARRAY ARRAY[
    'Hi {name}, APPLY NOW',
    'Discounted fees for {name}',
    'Hi {name}, a Special Offer awaits',
    'Big sale today',
    'Get it for free',
    'Use promo code X',
    'A limited-time slot',
    'See other openings',
    'Visit our website',
    'See https://example.invalid',
    'See www.example.invalid',
    'Click here, {name}',
    'مرحبا {name}، التسجيل مجاني',
    'خصم لك',
    'اضغط هنا'
  ] LOOP
    r := pg_temp.hp337_as(u_own, format(
      'SELECT hr_automsg_template_set(''cv_ack'', ''en'', %L, '''', ''draft'')::text', b));
    IF r IS DISTINCT FROM 'ERROR 22023 TEMPLATE_PROMOTIONAL' THEN
      RAISE EXCEPTION 'verify-hr-template-promo: % was not refused: %', b, r;
    END IF;
  END LOOP;
  r := pg_temp.hp337_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''en'', ''Apply now'', ''a'', ''draft'', ''utility'', ''rcs'')::text')
    || '/' || pg_temp.hp337_as(u_own, 'SELECT hr_automsg_template_set(''cv_ack'', ''ar'', ''Apply now'', ''a'', ''draft'', ''utility'', ''sms'')::text');
  IF r IS DISTINCT FROM 'ERROR 22023 TEMPLATE_PROMOTIONAL/ERROR 22023 TEMPLATE_PROMOTIONAL' THEN
    RAISE EXCEPTION 'verify-hr-template-promo: rcs / sms: %', r;
  END IF;
  IF EXISTS (SELECT 1 FROM hr_automsg_templates WHERE account_id = a) THEN
    RAISE EXCEPTION 'verify-hr-template-promo: a refusal wrote a template';
  END IF;

  -- ---------- allowed: recruitment wording ----------
  FOREACH b IN ARRAY ARRAY[
    'Hi {name}, your job offer is ready',
    'Your offer letter, {name}',
    'Feel free to reply, {name}',
    'Your interview for Sales Executive is at {slot}',
    'Congratulations on the promotion',
    'Applying now is not needed',
    'عرض العمل جاهز يا {name}'
  ] LOOP
    r := pg_temp.hp337_as(u_own, format(
      'SELECT hr_automsg_template_set(''cv_ack'', ''en'', %L, '''', ''draft'')::text', b));
    IF r LIKE 'ERROR%' THEN
      RAISE EXCEPTION 'verify-hr-template-promo: % was refused: %', b, r;
    END IF;
    IF (SELECT body FROM hr_automsg_templates
         WHERE account_id = a AND kind = 'cv_ack' AND language = 'en' AND channel = 'whatsapp')
       IS DISTINCT FROM b THEN
      RAISE EXCEPTION 'verify-hr-template-promo: % was not stored', b;
    END IF;
  END LOOP;

  -- ---------- the phrase helper ----------
  IF public.hr_automsg_promo_phrase('Apply now at www.example.invalid') IS DISTINCT FROM 'apply now'
     OR public.hr_automsg_promo_phrase('زوروا موقعنا') IS DISTINCT FROM 'visit our website'
     OR public.hr_automsg_promo_phrase('Hi {name}') IS NOT NULL THEN
    RAISE EXCEPTION 'verify-hr-template-promo: hr_automsg_promo_phrase answers wrongly';
  END IF;
  IF has_function_privilege('authenticated', 'public.hr_automsg_promo_phrase(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_automsg_promo_phrase(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.hr_automsg_template_set(text,text,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.hr_automsg_template_set(text,text,text,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'verify-hr-template-promo: grants';
  END IF;

  RAISE EXCEPTION USING ERRCODE = 'ZT337', MESSAGE = 'verify-hr-template-promo rollback';
  EXCEPTION WHEN SQLSTATE 'ZT337' THEN
    NULL;
  END;
END $verify$;
