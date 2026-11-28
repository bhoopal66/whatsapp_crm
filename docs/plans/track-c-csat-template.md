# Track C: CSAT rating request templates (draft for Meta)

The wording below is coordinator-approved. It is the body of the Meta
template for each moment and, with the parameters filled in, the plain
text sent on Whapi and OpenWA numbers and on Meta inside the customer's
24-hour window (`CSAT_TEMPLATE_BODIES` in `src/lib/cases/csat.ts`, pinned
by `csat.test.ts`).

Parameters, both moments:

- `{{1}}`: the customer's first name (the first word of the contact's
  name; "there" when the contact is saved under a number). Sample: `Asha`.
- `{{2}}`: bank and product. Sample for submitted:
  `Emirates NBD business account`; for approved: `Emirates NBD business`
  (the approved sentence already says "account"; see the notes file).

Category: **Utility**. Language: English (`en`); the Arabic texts are
optional, submitted as the `ar` language of the same template name.

## case_csat_submitted

English:

> Hi {{1}}, your {{2}} application has been submitted to the bank. How
> happy are you with our service so far? Reply with a number from 1 (not
> happy) to 5 (very happy).

Arabic (draft, not yet approved by the coordinator):

> مرحبًا {{1}}، تم تقديم طلب {{2}} الخاص بك إلى البنك. ما مدى رضاك عن
> خدمتنا حتى الآن؟ أرسل رقمًا من 1 (غير راضٍ) إلى 5 (راضٍ جدًا).

## case_csat_approved

English:

> Hi {{1}}, good news: your {{2}} has been approved! How would you
> rate our service? Reply with a number from 1 (not happy) to 5 (very
> happy).

Arabic (draft, not yet approved by the coordinator):

> مرحبًا {{1}}، خبر سار: تمت الموافقة على {{2}} الخاص بك! كيف تقيّم
> خدمتنا؟ أرسل رقمًا من 1 (غير راضٍ) إلى 5 (راضٍ جدًا).

## Submitting

1. Add each template in Settings → Templates with the exact name, the
   Utility category and the body above, then submit it to Meta.
2. Until Meta approves it, requests on the Meta number to customers
   outside their 24-hour window wait as `held` (`awaiting_template`) and
   expire after 3 days. Linked-device numbers are not affected.
3. Meta may reclassify a rating request as Marketing. A marketing
   template is not accepted (the sender requires Utility); the request
   then waits as held.
