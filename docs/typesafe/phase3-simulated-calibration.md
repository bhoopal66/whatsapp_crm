# Module 013 — Phase 3 calibration (SIMULATED — pipeline test only)

Generated 2026-09-29T09:54:49.802Z · model `jev-1.13.0` · question set `qs-013-v0.2`

> **These numbers come from a seeded fake model, not TypeSafe.** They prove the pipeline works; they say nothing about Jev's real accuracy.

## Recommendation

- Triage: **propose policy; activate after second-person approval**
- Guardrail: **propose policy; activate after second-person approval**
- `TS_SHADOW_LANGUAGES=ar,mixed`

## Triage (checks A/B)

| Threshold | Default | Calibrated |
|---|---|---|
| intentConfidenceMin | 0.5 | 0.5 |
| possibleComplaintMin | 0.25 | 0.5 |
| optOutRecordMin | 0.8 | 0.8 |
| optOutReviewMin | 0.4 | 0.4 |
| wantsHumanMin | 0.7 | 0.7 |

| Language | Rows | Intent acc. (auto) | To RM | Opt-out recall | False opt-out | Human recall | Pass |
|---|---|---|---|---|---|---|---|
| en | 315 | 97.9% | 0.4% | 100.0% | 0.0% | 100.0% | ✅ |
| ar | 306 | 90.1% | 0.4% | 93.1% | 0.0% | 100.0% | ❌ |
| mixed | 100 | 89.8% | 0.0% | 91.7% | 0.0% | 100.0% | ❌ |


### Intent confidence curve (English)

| Threshold | Accuracy (auto) | To RM |
|---|---|---|
| 0.5 | 97.9% | 0.4% |
| 0.55 | 98.2% | 0.7% |
| 0.6 | 98.2% | 0.7% |
| 0.65 | 98.2% | 0.7% |
| 0.7 | 98.2% | 0.7% |
| 0.75 | 98.2% | 1.1% |
| 0.8 | 98.2% | 1.1% |
| 0.85 | 98.2% | 1.4% |
| 0.9 | 98.2% | 1.8% |

### Possible-complaint curve (English)

| Threshold | Complaint recall | To RM |
|---|---|---|
| 0.1 | 100.0% | 0.4% |
| 0.15 | 100.0% | 0.4% |
| 0.2 | 100.0% | 0.4% |
| 0.25 | 100.0% | 0.4% |
| 0.3 | 100.0% | 0.4% |
| 0.35 | 100.0% | 0.4% |
| 0.4 | 100.0% | 0.4% |
| 0.45 | 100.0% | 0.4% |
| 0.5 | 100.0% | 0.4% |

### Misses at calibrated thresholds (first 15 per language)

**en**

- `en-035` intent: “Hello team, I want to talk to a real person, not a bot asap” — expected unclear, got business_loan @0.49
- `en-090` intent: “Sorry, I want to open a corporate account for my grocery in DMCC.” — expected account_opening, got complaint @0.50
- `en-131` intent: “Hi, Looking for POS for 2 branches, what are the fees? please” — expected pos_terminal, got unclear @0.56
- `en-263` intent: “Salam, Any update on my Ruya application? Submitted a month ago asap” — expected application_status, got smalltalk @0.28
- `en-268` intent: “Sorry, Do you do personal loans?.” — expected other_banking, got application_status @0.32
- `v02-007` intent: “How long does it take?” — expected account_opening, got other_banking @0.41

**ar**

- `ar-041` intent: “يا جماعة ممكن أحد يتصل فيني بخصوص الحساب؟ ضروري” — expected account_opening, got other_banking @0.62
- `ar-043` intent: “مرحبا، ممكن أحد يتصل فيني بخصوص الحساب؟ شكراً” — expected account_opening, got application_status @0.32
- `ar-063` intent: “أبغى أفتح حساب لمكتب استشارات جديد ضروري” — expected account_opening, got application_status @0.59
- `ar-070` intent: “يا جماعة كم ياخذ وقت فتح الحساب؟ ضروري” — expected account_opening, got complaint @0.52
- `ar-078` intent: “أحتاج حساب جاري للشركة، كم الحد الأدنى للرصيد؟!” — expected account_opening, got pos_terminal @0.65
- `ar-093` intent: “السلام عليكم، هل يمكن فتح حساب لشركة منطقة حرة؟!” — expected account_opening, got business_loan @0.48
- `ar-125` intent: “لو سمحت كم رسوم جهاز الدفع بالبطاقة؟ لو سمحتوا” — expected pos_terminal, got other_request @0.36
- `ar-127` intent: “لو سمحت أبي مكينة دفع لمحلي في دبي!” — expected pos_terminal, got other_request @0.62
- `ar-143` intent: “لو سمحت نحتاج جهاز نقاط بيع للمكتب تأجير سيارات ضروري” — expected pos_terminal, got business_loan @0.49
- `ar-145` intent: “مرحبا، نحتاج أجهزة دفع لفرعين” — expected pos_terminal, got smalltalk @0.18
- `ar-155` intent: “لو سمحت أبي مكينة دفع لمحلي في الشارقة” — expected pos_terminal, got smalltalk @0.31
- `ar-172` intent: “مرحبا، أبغى تمويل لصالون بقيمة مليون درهم” — expected business_loan, got other_banking @0.63
- `ar-175` intent: “السلام عليكم، المبيعات السنوية ٣٠٠ ألف ونبي قرض!” — expected business_loan, got other_banking @0.46
- `ar-180` intent: “السلام عليكم، ما هي شروط قرض الشركات الصغيرة في بنك المشرق؟ شكراً” — expected business_loan, got other_banking @0.60
- `ar-181` intent: “السلام عليكم، هل يمكن الحصول على قرض تجاري بدون ضمان؟!” — expected business_loan, got application_status @0.29

**mixed**

- `mx-016` intent: “مرحبا call me مع RM please thx” — expected unclear, got business_loan @0.63
- `mx-039` intent: “مرحبا need حساب للشركة ASAP” — expected account_opening, got unclear @0.20
- `mx-042` intent: “salam, كم fees الـ POS؟ thx” — expected pos_terminal, got smalltalk @0.38
- `mx-044` intent: “مرحبا abi machine lel card payment شكراً” — expected pos_terminal, got trade_working_capital @0.20
- `mx-046` intent: “مرحبا كم fees الـ POS؟” — expected pos_terminal, got unclear @0.23
- `mx-048` intent: “مرحبا ابغى POS machine للمحل pls” — expected pos_terminal, got other_banking @0.19
- `mx-066` intent: “نحتاج working capital facility شكراً” — expected trade_working_capital, got pos_terminal @0.65
- `mx-068` intent: “مرحبا نحتاج working capital facility thx” — expected trade_working_capital, got business_loan @0.31
- `mx-093` intent: “مرحبا very bad خدمة، محد رد pls” — expected complaint, got other_request @0.35
- `mx-001` opt_out missed: “مرحبا stop الرسائل please شكراً” — expected opt-out, got 0.78

## Guardrail (check C)

| Threshold | Default | Calibrated |
|---|---|---|
| reviewMin | 0.35 | 0.2 |
| actionMin | 0.7 | 0.7 |
| severityBlock | 2 | 1.5 |

Feasible threshold combinations: 210

| Language | Rows | Dangerous caught | False holds | Exact outcome | Pass |
|---|---|---|---|---|---|
| en | 101 | 100.0% | 0.0% | 96.0% | ✅ |
| ar | 49 | 100.0% | 0.0% | 100.0% | ✅ |


## Run statistics

- Failed calls: triage 0, guardrail 0
- Input tokens: 843,801 (≈ USD 0.0354)
- p95 latency: triage 5 ms, guardrail 6 ms

