-- Verifies migration 291: a delivery in the cost ledger corrects a failed
-- campaign recipient (status, reason, counters, campaign), a failure never
-- undoes a delivery, and a failure alone still fails a sent recipient.
-- hr_automsg_delivery_apply: verify-hr-automsg-delivery.sql. Fixtures
-- (dcf-) are rolled back.
DO $$
DECLARE
  u uuid := gen_random_uuid();
  acct uuid;
  b_all uuid;
  b_one uuid;
  r_row record;
  got text;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES (u, 'dcf-owner@verify.local', '{"full_name": "dcf owner"}'::jsonb);
    SELECT account_id INTO acct FROM public.profiles WHERE user_id = u LIMIT 1;
    IF acct IS NULL THEN RAISE EXCEPTION '291: no fixture account'; END IF;

    INSERT INTO public.broadcasts (user_id, account_id, name, template_name, status)
    VALUES (u, acct, 'dcf all', 'dcf', 'failed') RETURNING id INTO b_all;
    INSERT INTO public.broadcasts (user_id, account_id, name, template_name, status)
    VALUES (u, acct, 'dcf one', 'dcf', 'sent') RETURNING id INTO b_one;

    INSERT INTO public.broadcast_recipients
      (broadcast_id, status, whatsapp_message_id, sent_at, error_message)
    VALUES
      (b_all, 'failed',    'dcf-corrected', now(), 'Meta 1: dcf'),
      (b_all, 'failed',    'dcf-still',     now(), 'Meta 1: dcf'),
      (b_all, 'failed',    NULL,            now(), 'never reached WhatsApp'),
      (b_one, 'delivered', 'dcf-done',      now(), NULL),
      (b_one, 'sent',      'dcf-fails',     now(), NULL),
      (b_one, 'sent',      'dcf-both',      now(), NULL),
      (b_one, 'failed',    'dcf-unsure',    now(),
       'May have been sent - WhatsApp accepted it but it could not be recorded');

    INSERT INTO public.whatsapp_message_costs
      (account_id, phone_number_id, message_id, status, recipient_wa_id,
       recipient_market, billable, raw_status, created_at)
    SELECT acct, 'dcf', m, s, '971500000000', 'AE', false, '{}'::jsonb, now() + o * interval '1 second'
      FROM (VALUES
        ('dcf-corrected', 'failed', 1), ('dcf-corrected', 'delivered', 2),
        ('dcf-still', 'sent', 1), ('dcf-still', 'failed', 2),
        ('dcf-done', 'failed', 3),
        ('dcf-fails', 'failed', 1),
        ('dcf-both', 'failed', 1), ('dcf-both', 'delivered', 2), ('dcf-both', 'read', 3),
        ('dcf-unsure', 'delivered', 1)) v(m, s, o);

    PERFORM public.reconcile_broadcast_recipient_statuses(b_all);
    PERFORM public.reconcile_broadcast_recipient_statuses(b_one);

    FOR r_row IN
      SELECT * FROM (VALUES
        ('dcf-corrected', 'delivered/-/t'),
        ('dcf-still', 'failed/Meta 1: dcf/f'),
        ('dcf-done', 'delivered/-/f'),
        ('dcf-fails', 'failed/+/f'),
        ('dcf-both', 'read/-/t'),
        ('dcf-unsure', 'delivered/-/t')) v(m, want)
    LOOP
      SELECT concat_ws('/', r.status,
               CASE WHEN r.error_message IS NULL THEN '-'
                    WHEN r.error_message LIKE 'Meta 1%' THEN r.error_message ELSE '+' END,
               r.delivered_at IS NOT NULL)
        INTO got FROM public.broadcast_recipients r WHERE r.whatsapp_message_id = r_row.m;
      IF got IS DISTINCT FROM r_row.want THEN
        RAISE EXCEPTION '291: % is %, expected %', r_row.m, got, r_row.want;
      END IF;
    END LOOP;

    SELECT concat_ws('/', status, delivered_count, failed_count) INTO got
      FROM public.broadcasts WHERE id = b_all;
    IF got IS DISTINCT FROM 'sent/1/2' THEN
      RAISE EXCEPTION '291: the corrected campaign is %, expected sent/1/2', got;
    END IF;
    SELECT concat_ws('/', status, delivered_count, read_count, failed_count) INTO got
      FROM public.broadcasts WHERE id = b_one;
    IF got IS DISTINCT FROM 'sent/3/1/1' THEN
      RAISE EXCEPTION '291: the second campaign is %, expected sent/3/1/1', got;
    END IF;

    RAISE EXCEPTION 'dcf rollback' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE 'verify-delivery-corrects-failed: ok';
END $$;
