-- ============================================================
-- 337_hr_template_promo.sql — an HR template with promotional wording is
-- refused when it is saved, not only held when it is sent.
--
-- The editor refuses promotional wording in a Utility template inline
-- (validateTemplateBody in src/lib/hr/automsg/templates.ts), but the save
-- is a direct call to hr_automsg_template_set, which checked only length,
-- control characters and braces: a call made outside the editor stored a
-- promotional body, held only later at send time.
--
--  1. hr_automsg_promo_phrase(body): the first promotional marker in a
--     body, or NULL. Mirrors PROMO_PHRASES_EN (case-insensitive and
--     word-bounded: JS \b is \y here) and PROMO_PHRASES_AR (substring),
--     in the same order. src/lib/hr/automsg/promo-sql.test.ts reads this
--     file and fails when the two lists drift: change both.
--  2. hr_automsg_template_set (the 7-argument body, last restated in 226;
--     317's overload with p_expected only checks the version and calls
--     it) refuses such a body with HINT TEMPLATE_PROMOTIONAL. Signature,
--     defaults and grants unchanged.
--
-- Apply in order, once: re-running 226 after this file puts back the body
-- without the check. Needs 203, 226. supabase/ci/verify-hr-template-promo.sql
-- asserts it.
-- ============================================================

SET lock_timeout = '5s';

-- ---------- 1. the phrase lists ----------

CREATE OR REPLACE FUNCTION public.hr_automsg_promo_phrase(p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT x.phrase
    FROM (VALUES
      -- PROMO_PHRASES_EN: (n, 'en', phrase, case-insensitive regex)
      (1, 'en', 'discount', '\ydiscount(s|ed)?\y'),
      (2, 'en', 'special offer', '\y(special|exclusive|limited|best) offers?\y'),
      (3, 'en', 'sale', '\y(on|for|big|flash) sale\y|\ysale\y(?!s)'),
      (4, 'en', 'free', '\y(for free|free (gift|trial|offer)|100% free)\y'),
      (5, 'en', 'promo', '\ypromo(s|tional)?\y|\ypromo code\y'),
      (6, 'en', 'limited time', '\ylimited[- ]time\y'),
      (7, 'en', 'apply now', '\yapply now\y'),
      (8, 'en', 'other openings', '\yother (openings|vacancies|jobs|positions)\y'),
      (9, 'en', 'visit our website', '\yvisit our (website|site|page)\y'),
      (10, 'en', 'url', '\yhttps?://|\ywww\.'),
      (11, 'en', 'click here', '\yclick here\y'),
      -- PROMO_PHRASES_AR: (n, 'ar', phrase, substring)
      (12, 'ar', 'discount', 'خصم'),
      (13, 'ar', 'reduction', 'تخفيض'),
      (14, 'ar', 'special offer', 'عرض خاص'),
      (15, 'ar', 'free', 'مجان'),
      (16, 'ar', 'limited time', 'لفترة محدودة'),
      (17, 'ar', 'other jobs', 'وظائف أخرى'),
      (18, 'ar', 'other vacancies', 'شواغر أخرى'),
      (19, 'ar', 'visit our website', 'زوروا موقعنا'),
      (20, 'ar', 'click here', 'اضغط هنا')
    ) AS x(n, lang, phrase, pattern)
   WHERE CASE x.lang WHEN 'en' THEN p_body ~* x.pattern
                     ELSE strpos(p_body, x.pattern) > 0 END
   ORDER BY x.n
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.hr_automsg_promo_phrase(text)
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------- 2. the save refuses it ----------

-- Restated from 226 with one check added after the brace rule.
CREATE OR REPLACE FUNCTION public.hr_automsg_template_set(
  p_kind text, p_language text, p_body text, p_meta_template_name text,
  p_approval_status text, p_category text DEFAULT 'utility',
  p_channel text DEFAULT 'whatsapp')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_role text;
  v_name text := COALESCE(p_meta_template_name, '');
  v_phrase text;
BEGIN
  SELECT o_account, o_role INTO v_account, v_role FROM hr_automsg_caller();
  IF v_role IS DISTINCT FROM 'admin' THEN
    PERFORM hr_refuse('NOT_ALLOWED', 'only an admin may change automated-message templates');
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN (
       'cv_ack', 'ai_interview_invite', 'hr_interview_invite', 'manager_interview_invite',
       'interview_reminder', 'reply_nudge') THEN
    PERFORM hr_refuse('INVALID', 'unknown template kind');
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('en', 'ar') THEN
    PERFORM hr_refuse('INVALID', 'unknown language');
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('whatsapp', 'rcs', 'sms') THEN
    PERFORM hr_refuse('INVALID', 'unknown channel');
  END IF;
  IF p_approval_status IS NULL OR p_approval_status NOT IN ('draft', 'approved') THEN
    PERFORM hr_refuse('INVALID', 'unknown approval status');
  END IF;
  IF p_category IS DISTINCT FROM 'utility' THEN
    PERFORM hr_refuse('INVALID', 'automated templates must be Utility templates');
  END IF;
  IF p_body IS NULL OR char_length(p_body) NOT BETWEEN 1 AND 1024 THEN
    PERFORM hr_refuse('INVALID', 'the body must be 1 to 1024 characters');
  END IF;
  -- Control characters other than a newline.
  IF p_body ~ '[\x01-\x09\x0B-\x1F\x7F]' THEN
    PERFORM hr_refuse('INVALID', 'the body may not contain control characters');
  END IF;
  -- Braces only as the exact tokens {name} and {slot}.
  IF replace(replace(p_body, '{name}', ''), '{slot}', '') ~ '[{}]' THEN
    PERFORM hr_refuse('INVALID', 'the only placeholders allowed are {name} and {slot}');
  END IF;
  -- 337: promotional wording in a Utility template (every kind is one).
  v_phrase := hr_automsg_promo_phrase(p_body);
  IF v_phrase IS NOT NULL THEN
    PERFORM hr_refuse('TEMPLATE_PROMOTIONAL',
                      format('promotional wording is not allowed: "%s"', v_phrase));
  END IF;
  IF p_channel = 'rcs' THEN
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[A-Za-z0-9_.:-]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved RCS template needs its provider template id');
    END IF;
    IF v_name !~ '^[A-Za-z0-9_.:-]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'an RCS template id is up to 512 letters, digits and _ . : -');
    END IF;
  ELSIF p_channel = 'sms' THEN
    -- An SMS template has no provider registry: the name is the admin's
    -- label (203's hr_automsg_templates_approved_named still wants one
    -- to approve), and approving means the admin has checked the text.
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[A-Za-z0-9_.:-]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved SMS template needs a label');
    END IF;
    IF v_name !~ '^[A-Za-z0-9_.:-]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'an SMS template label is up to 512 letters, digits and _ . : -');
    END IF;
  ELSE
    IF p_approval_status = 'approved'
       AND (v_name !~ '^[a-z0-9_]+$' OR char_length(v_name) > 512) THEN
      PERFORM hr_refuse('INVALID', 'an approved template needs its Meta template name');
    END IF;
    IF v_name !~ '^[a-z0-9_]*$' OR char_length(v_name) > 512 THEN
      PERFORM hr_refuse('INVALID', 'a Meta template name is lower-case letters, digits and _');
    END IF;
  END IF;

  INSERT INTO hr_automsg_templates (account_id, kind, language, channel, body, meta_template_name,
                                    approval_status, category, updated_at, updated_by)
  VALUES (v_account, p_kind, p_language, p_channel, p_body, v_name, p_approval_status, p_category,
          now(), auth.uid())
  ON CONFLICT (account_id, kind, language, channel) DO UPDATE
    SET body = EXCLUDED.body, meta_template_name = EXCLUDED.meta_template_name,
        approval_status = EXCLUDED.approval_status, category = EXCLUDED.category,
        updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  PERFORM hr_automsg_log(v_account, 'template', jsonb_build_object(
    'kind', p_kind, 'language', p_language, 'channel', p_channel, 'meta_template_name', v_name,
    'approval_status', p_approval_status, 'category', p_category));
  RETURN hr_automsg_config();
END;
$$;

REVOKE ALL ON FUNCTION public.hr_automsg_template_set(text, text, text, text, text, text, text)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.hr_automsg_template_set(text, text, text, text, text, text, text)
  TO authenticated;

RESET lock_timeout;
