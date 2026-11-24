import { describe, expect, it } from 'vitest';

import { buildNameMatcher, type KnownName } from './known-names';
import { maskIdentifiers, screenText } from './learn';

const person = (name: string): KnownName => ({ name, kind: 'person' });
const company = (name: string): KnownName => ({ name, kind: 'company' });

// Everything saved in one workspace: the ordinary sentences below are
// masked with this whole list.
const SAVED: KnownName[] = [
  ...[
    'Max Muller',
    'May',
    'Will',
    'April Jones',
    'Mark',
    'Grace',
    'سيد',
    'سفر علي',
    'Abdul Rahman',
    'عبد الله',
    'Al Noor',
    "D'Souza",
    'Ahmed Khan',
    'مي',
    'Mohammed',
    'Rashid',
    'Noor',
    'محمد',
    'Karim Salem',
    'Peter Hassan',
    'Sultan Omar',
  ].map(person),
  ...[
    'Golden Star Trading LLC',
    'Smart Solutions General Trading LLC',
    'Royal Express',
    'General Trading LLC',
    'Trade Licence',
    'Business Bay Motors LLC',
  ].map(company),
];

describe('names: every probe is masked', () => {
  // [saved name, text, what must not be left]
  const probes: [KnownName, string, RegExp][] = [
    [company('Golden Star Trading LLC'), 'for Golden Star', /star/i],
    [company('Golden Star Trading LLC'), 'GOLDEN STAR TRADING is ok', /star/i],
    [company('Golden Star Trading LLC'), 'a golden star account', /star/i],
    [
      company('Golden Star Trading LLC'),
      'Golden Star Trading L.L.C. is ok',
      /star|trading|L\.L/i,
    ],
    [company('Golden Star Trading'), 'Golden Star Trading LLC', /star|LLC/i],
    [
      company('Golden Star Trading'),
      'Golden Star Trading FZ-LLC',
      /star|FZ|LLC/i,
    ],
    [
      company('Smart Solutions General Trading LLC'),
      'at Smart Solutions General Trading we',
      /smart|trading/i,
    ],
    [company('Royal Express'), 'Royal Express applied', /royal|express/i],
    [company('Express LLC'), 'from Express L.L.C today', /express/i],
    [company('حلول التقنية ذ.م.م'), 'شركة حلول التقنية طلبت', /حلول|التقنية/],
    [person('Max'), 'please ask Max about it', /max/i],
    [person('May Will'), 'spoke to May Will now', /may|will/i],
    [person('Will'), 'send it to Will today', /Will/],
    [person('Grace'), 'thanks to Grace for this', /grace/i],
    [person('سيد أحمد'), 'كلم سيد أحمد اليوم', /سيد|حمد/],
    [person('سفر علي'), 'مع سفر علي', /سفر|علي/],
    [person('Abdul Rahman'), 'ask Abdulrahman', /rahman/i],
    [person('Abdulrahman'), 'ask Abdul Rahman', /rahman|abdul/i],
    [person('عبد الله'), 'كلم عبدالله', /عبد/],
    [person('عبدالله'), 'كلم عبد الله', /عبد/],
    [company('Al Noor'), 'from Alnoor', /noor/i],
    [company('Al Noor'), 'from Al-Noor', /noor|al/i],
    [company('Alnoor'), 'from Al Noor', /noor/i],
    [company('Al-Noor'), 'from Alnoor', /noor/i],
    [person("D'Souza"), 'ask Dsouza', /souza/i],
    [person('Dsouza'), "ask D'Souza's team", /souza/i],
    [person('D’Souza'), 'ask D Souza', /souza/i],
    [person('AhmedKhan'), 'ask Ahmed Khan', /ahmed|khan/i],
    [person('Ahmed Khan'), 'ask AhmedKhan', /ahmed|khan/i],
    [person('Ahmed Khan'), 'ask ahmedkhan', /ahmed|khan/i],
    [person('Ahmed Khan'), "Khan's file", /khan/i],
    [person('محمد'), 'يا محمد ويامحمد', /محمد/],
    [person('مي'), 'كلم مي اليوم', /(?<!\p{L})مي(?!\p{L})/u],
    [person('مي'), 'كلم يامي', /مي/],
    [person('Mohammed'), 'ask muhammad and Mohamed', /moham|muham/i],
    [person('Mohammed'), 'كلم محمد', /محمد/],
    [person('محمد'), 'ask Mohammed', /mohammed/i],
    [person('Rashid'), 'كلم راشد', /راشد/],
    [person('راشد'), 'ask Rashid or Rasheed', /rash/i],
    [person('Noor'), 'ask Nour or nour', /nour/i],
    [person('Noor'), 'كلم النور', /نور/],
    [person('النور'), 'ask Noor', /noor/i],
    [person('Omar'), 'كلم عمر', /عمر/],
    [person('خالد'), 'ask Khaled', /khaled/i],
    [person('Fatima'), 'كلم فاطمة', /فاطم/],
  ];
  it.each(probes)('%j in "%s"', (saved, text, left) => {
    const out = buildNameMatcher([saved]).mask(text);
    expect(out).toContain('[NAME]');
    expect(out).not.toMatch(left);
  });
});

describe('numbers: every probe is masked', () => {
  it.each([
    ['call 50 12 3', '50 12 3'],
    ['ref 20-451', '20-451'],
    ['ref 20/4.51', '20/4.51'],
    ['ref 20\n451', '451'],
    ['رقم ٢٠ ٤٥ ١', '٤٥'],
    ['ref 2 -0451', '0451'],
    ['five zero one two three four', 'one two three'],
    ['خمسة صفر واحد اثنين ثلاثة', 'واحد'],
    ['id 3f2504e0-4f89-11d3-9a0c-0305e82c3301', '3f2504e0'],
    ['see https://x.example.com/a?b=c', 'example'],
    ['see www.alnoor.ae/about', 'alnoor'],
    ['see alnoor.ae please', 'alnoor'],
    ['ref AB12CD34', 'AB12CD34'],
    ['PO Box 4512 Dubai', '4512'],
    ['P.O. Box: 451', '451'],
    ['ص.ب 4512', '4512'],
    ['mail sara at x dot ae', 'sara'],
    ['mail sara (at) x . ae', 'sara'],
    ['case TC 26 001 ok', '26 001'],
  ])('%j', (text, left) => {
    const out = maskIdentifiers(text)!;
    expect(out).not.toContain(left);
    expect(out).toMatch(/\[[A-Z]+\]/);
    // The output screen refuses what the mask would change.
    expect(screenText(text, buildNameMatcher([]))).toBe(false);
  });
});

describe('ordinary answers come through', () => {
  it.each([
    'The annual fee is AED 10,000 plus 5% VAT.',
    'You need a valid trade licence and a tenancy contract.',
    'We will open the account within 5 working days.',
    'You may apply after 6 months in business.',
    'Will the bank ask for a deposit? No.',
    'May I know your sector? It depends on that.',
    'The maximum limit is AED 250,000.00 for this card.',
    'Mark the box on page 2 and sign the form.',
    'There is a grace period of 25 days.',
    'The offer is open in May and April 2027.',
    'The minimum salary is AED 5000 a month.',
    'A business loan in Dubai needs a trade licence.',
    'General trading is allowed with this licence.',
    'Smart people save money; the solutions are easy.',
    'The visa must be valid for at least 3 months.',
    'Send the last 6 months of bank statements.',
    'A freelance permit is enough for a personal account.',
    'The minimum balance is AED 3,000, else AED 25 a month.',
    'Express service costs AED 150 and takes one day.',
    'Yes, free zone companies can apply.',
    'The rate starts from 5.99% reducing.',
    'No, the POS machine is free for the first year.',
    'The gold card has no annual fee in the first year.',
    'Clear copies of the passport and Emirates ID are needed.',
    'Payment is due by the 5th of each month.',
    'Our office in Business Bay is open from 9 am to 6 pm.',
    "Don't close the old account before the transfer is done.",
    'A better rate is possible with a higher deposit.',
    'The limit can be raised after 12 months.',
    'Housing, car and personal finance are all available.',
    'No need to bring the original, a copy is fine.',
    'الرسوم السنوية 500 درهم فقط.',
    'يمكنك فتح الحساب برخصة العمل الحر.',
    'نحتاج صورة الجواز والهوية وكشف حساب 6 أشهر.',
    'الحد الأدنى للراتب 5000 درهم شهريا.',
    'السلام عليكم، نعم يمكن التقديم من المنطقة الحرة.',
    'مدة الموافقة من 3 إلى 5 أيام عمل.',
    'يجب أن تكون التأشيرة سارية لمدة ثلاثة أشهر.',
    'لا توجد رسوم على التحويل داخل الدولة.',
    'الحد الأقصى للتمويل هو 250,000 درهم.',
    'الخدمة مجانية لمدة سنة واحدة.',
    'يا سيدي الكريم الحساب يحتاج رخصة تجارية.',
    'تذكرة السفر ليست مطلوبة لفتح الحساب.',
    'يتم إصدار البطاقة خلال أسبوع من الموافقة.',
  ])('%s', (text) => {
    expect(maskIdentifiers(text)).toBe(text);
    expect(buildNameMatcher(SAVED).mask(text)).toBe(text);
  });
});
