-- ============================================================
-- 329_desk_tray_search.sql — search the desk tray by the customer.
--
-- desk_tray_page gains p_q (DEFAULT NULL): the tray narrowed to items
-- whose contact's name contains the text (ILIKE, so Arabic names match
-- as typed), or, when the text is a phone number (digits with spaces,
-- '+', '-', '.', parentheses), whose contact's phone digits contain its
-- digits ("+971 50" finds 971501234567). '%', '_' and '\' in the text
-- are literal. The search is one more condition beside 303's visibility
-- filter (team leader and up, else desk_tray_can_sort): it only narrows
-- what the caller already sees. NULL, empty or blank p_q answers exactly
-- what 303 did; ordering, limit and the total (of the matching items) are
-- 303's.
--
-- Apply in order, once, after 303. The old five-argument overload is
-- dropped first (a sixth argument is a new overload, not a replacement).
-- Re-running 303 afterwards would recreate that overload beside this one,
-- and every call that names five arguments or fewer would then be
-- ambiguous: re-apply this file after it if that ever happens.
-- Asserted by supabase/ci/verify-desk-tray-search.sql.
-- ============================================================

DROP FUNCTION IF EXISTS public.desk_tray_page(uuid, uuid, text, integer, timestamptz);

CREATE OR REPLACE FUNCTION public.desk_tray_page(p_actor uuid, p_account uuid, p_state text DEFAULT 'open',
                                                 p_limit integer DEFAULT 100, p_now timestamptz DEFAULT NULL,
                                                 p_q text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now    timestamptz := coalesce(p_now, now());
  v_limit  integer := least(greatest(coalesce(p_limit, 100), 1), 1000);
  v_role   text := public.case_account_role(p_account, p_actor);
  -- Blank is no search (btrim strips only spaces; tabs and newlines too).
  v_q      text := nullif(btrim(coalesce(p_q, ''), E' \t\r\n'), '');
  v_like   text;
  v_digits text;
  v_total  integer;
  v_items  jsonb;
BEGIN
  IF v_role IS NULL THEN
    PERFORM public.desk_refuse('desk_tray_page', 'NOT_ALLOWED', 'staff only');
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('open', 'filed', 'dismissed') THEN
    PERFORM public.desk_refuse('desk_tray_page', 'INVALID', 'state is open, filed or dismissed');
  END IF;
  IF v_q IS NOT NULL THEN
    -- The person's text is literal: escape the LIKE wildcards and the escape.
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- A phone number only when the text is one; "Ahmed 1" is a name, not
    -- every phone with a 1 in it.
    IF v_q ~ '^[0-9+(). -]+$' THEN
      v_digits := nullif(regexp_replace(v_q, '[^0-9]', '', 'g'), '');
    END IF;
  END IF;
  SELECT count(*) INTO v_total FROM public.desk_tray t
   WHERE t.account_id = p_account AND t.state = p_state
     AND (v_role IN ('team_lead', 'admin', 'super_admin')
          OR public.desk_tray_can_sort(p_actor, p_account, t.candidates))
     AND (v_q IS NULL
          OR EXISTS (SELECT 1 FROM public.contacts s
                      WHERE s.id = t.contact_id
                        AND (s.name ILIKE v_like ESCAPE '\'
                             OR (v_digits IS NOT NULL
                                 AND regexp_replace(coalesce(s.phone, ''), '[^0-9]', '', 'g')
                                     LIKE '%' || v_digits || '%'))));
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'tray_id', p.id, 'reason', p.reason, 'candidates', p.candidates, 'state', p.state,
           'received_at', p.received_at,
           'age_seconds', greatest(0, extract(epoch FROM v_now - p.received_at))::bigint,
           'escalated_at', p.escalated_at, 'duty_user_id', p.duty_user_id, 'contact_id', p.contact_id,
           'contact_name', c.name, 'contact_phone', c.phone, 'conversation_id', p.conversation_id,
           'sender_companies', (SELECT coalesce(jsonb_agg(jsonb_build_object('company', x.legal_name, 'role', x.role)
                                                          ORDER BY x.legal_name), '[]'::jsonb)
                                  FROM public.desk_customers_for_contact(p_account, p.contact_id) x),
           'document_kind', d.kind, 'mime', d.mime, 'original_name', d.original_name, 'caption', d.caption,
           'size_bytes', d.size_bytes, 'media_url', d.media_url, 'resolved_case_id', p.resolved_case_id,
           'dismiss_reason', p.dismiss_reason) ORDER BY p.n), '[]'::jsonb)
    INTO v_items
    FROM (SELECT t.*, row_number() OVER (ORDER BY CASE WHEN p_state = 'open' THEN t.received_at END,
                                                  t.resolved_at DESC, t.received_at, t.id) AS n
            FROM public.desk_tray t
           WHERE t.account_id = p_account AND t.state = p_state
             AND (v_role IN ('team_lead', 'admin', 'super_admin')
                  OR public.desk_tray_can_sort(p_actor, p_account, t.candidates))
             AND (v_q IS NULL
                  OR EXISTS (SELECT 1 FROM public.contacts s
                              WHERE s.id = t.contact_id
                                AND (s.name ILIKE v_like ESCAPE '\'
                                     OR (v_digits IS NOT NULL
                                         AND regexp_replace(coalesce(s.phone, ''), '[^0-9]', '', 'g')
                                             LIKE '%' || v_digits || '%'))))
           ORDER BY n LIMIT v_limit) p
    JOIN public.customer_documents d ON d.id = p.customer_document_id
    LEFT JOIN public.contacts c ON c.id = p.contact_id;
  RETURN jsonb_build_object('items', v_items, 'total', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.desk_tray_page(uuid, uuid, text, integer, timestamptz, text)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.desk_tray_page(uuid, uuid, text, integer, timestamptz, text)
TO service_role;
