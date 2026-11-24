/**
 * Which people and companies a text names (learn from team answers, 290).
 *
 * `buildNameMatcher` indexes an account's names once per run; matching
 * walks a text's words, so the cost does not grow with the list.
 *
 *  - whole words, any case; Arabic folded (alef/hamza, ta marbuta, alef
 *    maqsura, diacritics, tatweel), Latin accents too;
 *  - an Arabic word also matches behind و ف ب ل ك س and ال, in any
 *    combination (لمحمد, وأحمد, وبالنور);
 *  - a name of several words is matched as a phrase, and each of its
 *    words alone unless it is in COMMON (or shorter than three letters);
 *  - a name made only of COMMON words ("Business Loan Dubai") is matched
 *    as a phrase of three or more words, never word by word;
 *  - a two-letter Latin name counts only where the text capitalises it.
 *
 * Pure: the list itself is read in `learn-run.ts`.
 */

/** Words that name nobody on their own, and that answers are made of. */
const COMMON_TEXT = `
a an and are as at be by can do for from get go has have he hi how i if in
is it its me my no not of off on one or our out she so that the their them
they this to two up us was we what when where which who will with you your
all also any am pm yes ok okay sir madam dear hello thanks thank please mr
mrs ms miss dr eng al el abu bin ibn bint bu de la new old good best first
access account accounts accounting agency agent air application apply
approval approved area assets associates auto back bank banking banks bay
branch broker brokers building business businesses call capital car card
cards care case cash center centre chat check city clean cleaning clear
clearing client clients co commercial company companies complete confirm
consultancy consultant consultants consulting contact contracting
contractor contractors cooperation corporate corporation corp credit
customer customers customs daily date day days dead deal debit deposit
design development digital direct document documents draft drafting east
easy electrical electronics emirate emirates engineering enterprise
enterprises entry equipment est establishment event events every exchange
express facilities facility factory fast fee fees finance financial fit
fitness food foods foodstuff foundation free freelance freight full fund
furniture future garage gcc general gift global gold golden goods group
gulf hand health help here high holding holdings home hotel house import
export inc income industrial industries industry info information
insurance interest international internet into investment investments
invoice issue item jewellery job key kitchen land law lead legal letter
licence license licensed life light limit limited line link living llc llp
loan loans local logistics long ltd main maintenance make management
manager manufacturing marine market marketing materials max mechanical
media medical meeting merchant metal min minimum mobile money month
monthly months more mortgage motor motors must name national need net
network next north number offer office offices officer oil online only open
opening order other owner paper park partner partners party pay payment
payments permit person personal phone plan plus point pos post power price
private pro process product products professional project projects
promotion properties property provide public purchase quality quick rate
rates real reach receive recruitment renewal rental rent request required
restaurant retail review right royal safe salary sale sales salon school
sector secure security see send service services set share shipping shop
short sign site sky small smart sme soft software sole solution solutions
south special sports spare stamp standard star start state statement steel
stock store studio sub submit super supplies supply support swift system
systems tax team tech technical technologies technology terms test textile
time today top total tourism tourist trade trader traders trading training
transaction transfer transport transportation travel travels trust uae uk
unit united universal update usa value vat vehicle via view visa visit
wait want water way web week welcome west wholesale work workshop world
year years zone abu dhabi ajman dubai sharjah fujairah ras khaimah umm
quwain quwwain deira arab arabian arabia middle saudi india indian
pakistan pakistani oman qatar kuwait bahrain egypt english arabic islamic
islam january february march april may june july august september october
november december monday tuesday wednesday thursday friday saturday sunday
fze fzc fzco fzllc dmcc rakez ifza difc adgm jafza meydan psc pjsc spc
adcb fab enbd nbd mashreq rakbank hsbc wio adib nbf cbd cbi dib
و في من على الى عن ان هذا هذه هل لا نعم مع او كل قبل بعد عند لدى غير كم
ما ماذا كيف متى اين لو اذا تم يتم يمكن يمكنك لكم لك لي لنا هو هي نحن انت
الله اهلا مرحبا شكرا استاذ سيد سيدي الف مئه
شركه شركات مؤسسه مجموعه مكتب مكاتب تجاره تجاري تجاريه عامه عام خدمات خدمه
بنك بنوك مصرف حساب حسابات قرض قروض تمويل ائتمان بطاقه رخصه تصريح عمل حر
فتح طلب مستند مستندات وثيقه وثائق راتب دخل عميل عملاء فرع رقم هاتف رسوم
نقدي تحويل ايداع شهر شهري سنه سنوي يوم ايام اسبوع دبي ابوظبي ظبي الشارقه
شارقه عجمان راس خيمه فجيره ام قيوين امارات دوله دولي دوليه عالمي عربي
عربيه خليج مقاولات استشارات عقار عقارات نقل شحن سياحه سفر سيارات مطعم
مطاعم ذهب مواد بناء غذائيه صيانه تنظيف تسويق تقنيه تكنولوجيا حلول مشاريع
مشروع استثمار استثمارات قابضه محدوده ذمم ش م
`;

const ARABIC_LETTER = /[؀-ۿ]/u;

/** Case, accents, hamza seats, ta marbuta, tatweel and invisibles out. */
export function foldName(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}ـء]/gu, '')
    .toLowerCase()
    .replace(/ٱ/gu, 'ا')
    .replace(/[ىی]/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(/ة/gu, 'ه');
}

const COMMON: ReadonlySet<string> = new Set(
  COMMON_TEXT.split(/\s+/u).filter(Boolean).map(foldName)
);

// Letters, their marks and invisible joiners; digits and punctuation part.
const WORD = /[\p{L}\p{M}\p{Cf}ـ]+/gu;
/** Our own masks: never read as words, so masking twice changes nothing. */
const MASK =
  /\[(?:NAME|CASE|ID|EMAIL|IBAN|EID|CARD|OTP|ACCT|PASSPORT|PHONE:\d{3}|withheld)\]/gu;
/** Joined to the next word when written as one (Abdulrahman, عبدالله). */
const JOINERS = new Set(
  ['عبد', 'ابو', 'ال', 'abdul', 'abdel', 'abd', 'abu', 'al', 'el'].map(foldName)
);
const PREFIX = /^(?:[وفبلكس]{0,3}(?:ال)?|[وف]?لل)/u;

/** The word as a name could be written: itself, and behind each Arabic
 *  prefix it may carry. */
function forms(folded: string): string[] {
  const out = [folded];
  if (!ARABIC_LETTER.test(folded)) return out;
  const longest = PREFIX.exec(folded)?.[0].length ?? 0;
  for (let n = 1; n <= Math.max(longest, folded.startsWith('لل') ? 2 : 0); n++)
    if (folded.length - n >= 2) out.push(folded.slice(n));
  return out;
}

const words = (text: string): string[] =>
  (text.match(WORD) ?? []).map(foldName).filter(Boolean);

/** A common word, also with its article (الشركة). No other prefix is
 *  taken off here: وسام would become ام. */
const isCommon = (folded: string) =>
  COMMON.has(folded) ||
  (folded.startsWith('ال') && COMMON.has(folded.slice(2)));

export interface NameMatcher {
  /** The text with every known name replaced by [NAME]. */
  mask(text: string): string;
}

interface Token {
  start: number;
  end: number;
  raw: string;
  forms: string[];
}

export function buildNameMatcher(names: Iterable<string>): NameMatcher {
  /** Names, or words of names, that identify on their own. */
  const single = new Set<string>();
  /** Two-letter Latin names: only where the text capitalises them. */
  const short = new Set<string>();
  /** First word → the phrases it starts, longest first. */
  const phrases = new Map<string, string[][]>();

  const addSingle = (w: string) => {
    if (!isCommon(w)) {
      if (w.length >= 3) single.add(w);
      else if (w.length === 2 && /^[a-z]{2}$/u.test(w)) short.add(w);
    }
    // "النور" is also written without its article, behind a prefix.
    if (w.startsWith('ال') && w.length >= 5 && !isCommon(w))
      single.add(w.slice(2));
  };

  for (const name of names) {
    if (typeof name !== 'string') continue;
    const w = words(name);
    if (w.length === 0) continue;
    w.forEach(addSingle);
    for (let i = 0; i + 1 < w.length; i++)
      if (JOINERS.has(w[i]!)) {
        const joined = w[i]! + w[i + 1]!;
        if (joined.length >= 4 && !isCommon(joined)) single.add(joined);
      }
    const allCommon = w.every(isCommon);
    if (w.length >= (allCommon ? 3 : 2)) {
      const list = phrases.get(w[0]!) ?? [];
      list.push(w);
      phrases.set(w[0]!, list);
    }
  }
  for (const [first, list] of phrases) {
    const unique = [...new Map(list.map((p) => [p.join(' '), p])).values()];
    phrases.set(
      first,
      unique.sort((a, b) => b.length - a.length)
    );
  }

  const matchAt = (tokens: Token[], at: number): number => {
    const t = tokens[at]!;
    for (const form of t.forms)
      for (const phrase of phrases.get(form) ?? [])
        if (
          phrase.every(
            (w, k) =>
              k === 0 || tokens[at + k]?.forms.some((f) => f === w) === true
          )
        )
          return phrase.length;
    if (t.forms.some((f) => single.has(f))) return 1;
    if (short.has(t.forms[0]!) && /^\p{Lu}/u.test(t.raw)) return 1;
    return 0;
  };

  const maskPlain = (text: string): string => {
    const tokens: Token[] = [];
    for (const m of text.matchAll(WORD)) {
      const folded = foldName(m[0]);
      if (folded)
        tokens.push({
          start: m.index,
          end: m.index + m[0].length,
          raw: m[0],
          forms: forms(folded),
        });
    }
    let out = '';
    let from = 0;
    for (let i = 0; i < tokens.length; i++) {
      const n = matchAt(tokens, i);
      if (n === 0) continue;
      out += text.slice(from, tokens[i]!.start) + '[NAME]';
      from = tokens[i + n - 1]!.end;
      i += n - 1;
    }
    return out + text.slice(from);
  };

  return {
    mask(text) {
      let out = '';
      let from = 0;
      for (const m of text.matchAll(MASK)) {
        out += maskPlain(text.slice(from, m.index)) + m[0];
        from = m.index + m[0].length;
      }
      return out + maskPlain(text.slice(from));
    },
  };
}
