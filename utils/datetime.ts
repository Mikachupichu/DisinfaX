/** A post's own time, normalized to the one spelling that leaves this extension.
 *
 *  Hosts state a post's time in whatever shape their own stack uses — an ISO 8601 instant in a
 *  `<time datetime>`, truthsocial's `created_at`, Hacker News' Unix second count on the age
 *  link's `title`, X's `Wed Oct 10 20:19:24 +0000 2018`, and the prose a host writes into its own
 *  accessibility label (`Tuesday, October 13, 2026 at 1:14 PM`) — and the preclassify worker reads
 *  the value back by ISO component. Normalizing here means the worker only ever parses one shape,
 *  and a post carries the same value whichever platform captured it.
 *
 *  Either way a value says only as far down as its source did. A host that hands over a time is
 *  believed for that time and no further (`spelledPrecision`); one that states an AGE states no
 *  instant at all, so the instant it implies is cut to the age's own unit (`isoDatetimeFromAge`).
 *  Fields neither could place are ABSENT rather than zeroed — a zero is indistinguishable from a
 *  real reading, and the note built from this value is what the model treats as the present
 *  moment, so a defaulted one would be read as fact.
 *
 *  Anything unreadable is DROPPED rather than forwarded: an Invalid Date throws when the worker
 *  formats it, so one host's unexpected spelling would fail a request over a timestamp the
 *  prompt could have done without. `undefined` is the fallback everywhere, on the tweet type
 *  (`Tweet.datetime`) and in the worker.
 *
 *  It lives in its own module rather than beside the capture helpers for one reason: X's tweets
 *  are built by `utils/parsing.ts`, which `platforms/capture.ts` already imports, so a helper
 *  shared by both cannot live in either without a cycle. */
export function isoDatetime(value: string | number | null | undefined): string | undefined {
  if (value == null || value === '') return undefined;
  // A number is a Unix SECOND count: that is what the one host stating a time numerically
  // states, and reading it as milliseconds would file the post in 1970. A whole second count is
  // also a spelling that states seconds and nothing finer.
  const numeric = typeof value === 'number';
  const ms = numeric ? value * 1000 : Date.parse(value);
  if (Number.isFinite(ms)) return CUT[numeric ? 'second' : spelledPrecision(value)](new Date(ms).toISOString());
  if (numeric) return undefined;
  // The one spelling the engine's own parser refuses: a label that spells a date out and joins
  // the clock to it with a word (`October 13, 2026 at 1:14 PM`). Only English needs covering —
  // the date half has to be one `Date.parse` reads at all, and every English form glues the two
  // halves with `at` — so a reader whose app is in another language gets nothing here, which is
  // the value they got before this existed rather than a guessed instant.
  const glued = Date.parse(value.replace(PROSE_DATE_GLUE, ' '));
  return Number.isFinite(glued) ? CUT[spelledPrecision(value)](new Date(glued).toISOString()) : undefined;
}

const PROSE_DATE_GLUE = /\s+at\s+/i;

/** How far down a value places the instant, which is how far down it is allowed to say. */
type Precision = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** One unit a host may state a post's AGE in, with what that unit's own precision makes
 *  meaningless about the instant behind it. */
interface AgeUnit {
  /** The unit's `Intl.RelativeTimeFormat` name: how a localized spelling is attached to it. */
  readonly key: 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';
  /** Every spelling the host may use for the unit, in every language it writes them in — the
   *  English ones below, plus whatever the page's own language spells (see `ageWords`). */
  readonly names: readonly string[];
  /** Zero the fields the unit is not precise enough to place. */
  readonly floor: (at: Date) => void;
  /** Step back one whole unit. */
  readonly back: (at: Date, count: number) => void;
  /** The finest field the unit places, and so the finest the value it produces may state. */
  readonly precision: Precision;
}

/** What a value states, cut to the fields its unit actually places: `6y` is a year (`2020`),
 *  `2mo` a month (`2026-04`), `3d` and `2w` a day (`2026-10-11`), `5h` an hour
 *  (`2026-10-14T04Z`), and a label that counts seconds is stated to the second.
 *
 *  The fields the unit cannot place are LEFT OUT rather than zeroed, which is the whole point of
 *  the cut: `2026-10-14T04:00:00.000Z` cannot be told apart from a post written at 4am exactly,
 *  while `2026-10-14T04Z` says only what the host actually stated. Omission is the one spelling
 *  that cannot be mistaken for a measurement. */
const CUT: Record<Precision, (iso: string) => string> = {
  year: (iso) => iso.slice(0, 4),
  month: (iso) => iso.slice(0, 7),
  day: (iso) => iso.slice(0, 10),
  hour: (iso) => `${iso.slice(0, 13)}Z`,
  minute: (iso) => `${iso.slice(0, 16)}Z`,
  second: (iso) => `${iso.slice(0, 19)}Z`,
};

/** How far down a host's own value spells the time, checked in this order. Seconds come before
 *  minutes because a clock that spells seconds matches the minute pattern too, and the two
 *  date-only shapes come first because neither can carry a colon. */
const SPELLED: ReadonlyArray<readonly [Precision, RegExp]> = [
  ['year', /^\d{4}$/],
  ['month', /^\d{4}-\d{2}$/],
  ['second', /\d{1,2}:\d{2}:\d{2}/],
  ['minute', /\d{1,2}:\d{2}/],
];

/** How far down a host's OWN value goes, which is as far down as the instant it states may be
 *  recorded.
 *
 *  A host that hands over a time is trusted for that time and for nothing past it: Facebook's
 *  accessibility label reads `at 1:14 PM` and knows nothing of seconds, so the value it produces
 *  says `17:14Z` rather than putting a `00` where the host never looked — the same reason a
 *  derived age states at its own unit's depth. `Sep 28`-shaped labels never reach here (the 2001
 *  trap, see the age reader), so a value with no clock at all is read as a day, which is the
 *  coarsest a stated instant gets in practice.
 *
 *  Read off the spelling rather than declared per host, so a platform that starts stating more
 *  or less is believed without a matching change here — and so a value a host spells further
 *  down than we knew is never cut short by our own table going stale. */
function spelledPrecision(value: string): Precision {
  for (const [precision, shape] of SPELLED) if (shape.test(value)) return precision;
  return 'day';
}

const MIDNIGHT = (at: Date): void => {
  at.setUTCHours(0, 0, 0, 0);
};

/** Ordered widest unit first, and within a unit the longest spelling first, so `6mo` is read as
 *  six months rather than six minutes — and the boundary every match must end on (`(?![a-z])`,
 *  below) is what keeps `6months` from being read as either of the two shorter halves.
 *
 *  Months and years step through the calendar rather than through a fixed count of milliseconds,
 *  which is why each unit carries its own way of stepping back rather than a millisecond value:
 *  a month is not a length of time, and 30 days is not a month. */
const AGE_UNITS: readonly AgeUnit[] = [
  {
    key: 'year',
    names: ['years', 'year', 'yrs', 'yr', 'y'],
    floor: (at) => {
      at.setUTCMonth(0, 1);
      MIDNIGHT(at);
    },
    back: (at, count) => at.setUTCFullYear(at.getUTCFullYear() - count),
    precision: 'year',
  },
  {
    key: 'month',
    names: ['months', 'month', 'mos', 'mo'],
    floor: (at) => {
      at.setUTCDate(1);
      MIDNIGHT(at);
    },
    back: (at, count) => at.setUTCMonth(at.getUTCMonth() - count),
    precision: 'month',
  },
  // A week places the day it lands on and no finer — it is a length, not a calendar unit, so
  // there is no "week of" to name the way there is a month or a year.
  {
    key: 'week',
    names: ['weeks', 'week', 'wks', 'wk', 'w'],
    floor: MIDNIGHT,
    back: (at, count) => at.setUTCDate(at.getUTCDate() - 7 * count),
    precision: 'day',
  },
  {
    key: 'day',
    names: ['days', 'day', 'd'],
    floor: MIDNIGHT,
    back: (at, count) => at.setUTCDate(at.getUTCDate() - count),
    precision: 'day',
  },
  {
    key: 'hour',
    names: ['hours', 'hour', 'hrs', 'hr', 'h'],
    floor: (at) => at.setUTCMinutes(0, 0, 0),
    back: (at, count) => at.setUTCHours(at.getUTCHours() - count),
    precision: 'hour',
  },
  {
    key: 'minute',
    names: ['minutes', 'minute', 'mins', 'min', 'm'],
    floor: (at) => at.setUTCSeconds(0, 0),
    back: (at, count) => at.setUTCMinutes(at.getUTCMinutes() - count),
    precision: 'minute',
  },
  {
    key: 'second',
    names: ['seconds', 'second', 'secs', 'sec', 's'],
    floor: (at) => at.setUTCMilliseconds(0),
    back: (at, count) => at.setUTCSeconds(at.getUTCSeconds() - count),
    precision: 'second',
  },
];

/** The languages whose age spellings can be read: the page's own first, as the host states it,
 *  then the browser's. A host renders an age in ITS OWN interface language, which is not always
 *  the browser's — a French YouTube UI in an English browser states `fr-FR` on the document while
 *  `navigator.language` still says `en-US` (measured 2026-11-01), and reading only the latter
 *  dated every French comment as of today. Read lazily, because a label is only ever parsed while
 *  its page is open, and guarded so a context without a document still has the English table. */
function ageLocales(): string[] {
  const out: string[] = [];
  try {
    const stated = document.documentElement.getAttribute('lang');
    if (stated) out.push(stated);
  } catch { /* no document */ }
  try {
    for (const value of navigator.languages ?? []) if (value) out.push(value);
    if (navigator.language) out.push(navigator.language);
  } catch { /* no navigator */ }
  return out;
}

/** The plural counts sampled to learn a language's unit spellings: between them they reach every
 *  CLDR plural category (`day`, `days`; `день`, `дня`, `дней`; `jour`, `jours`), and the three
 *  styles cover the abbreviated forms hosts put on timestamps (`5d`, `5 j`, `vor 5 Std.`). */
const AGE_SAMPLE_COUNTS = [1, 2, 3, 5, 11, 21, 101];

const AGE_NUMBER = /\p{Nd}+/u;
const AGE_WORD_RUN = /^[\p{L}\p{M}]+/u;
const AGE_LEADING_SPACE = /^[\s\u00a0\u200e\u200f\u202a-\u202e]*/u;

/** What this reader learned about the current page's languages. */
interface AgeWords {
  /** An age anywhere in a label: the count, then the unit's own spelling (group 2). */
  label: RegExp;
  /** An age and nothing else: `18h`, `il y a 5 j`, `2 days ago`. */
  alone: RegExp;
  /** Every spelling → the unit it states. A spelling two units claim is left out. */
  byName: Map<string, AgeUnit>;
}

let ageWordsCache: { key: string; words: AgeWords } | null = null;

/** The spellings that make up an age, in every language this page speaks.
 *
 *  A host writes its ages in its own interface language — `il y a 9 mois`, `vor 9 Monaten`,
 *  `9 か月前`, `قبل ۹ أشهر` — so an English-only table cannot read a non-English reader's
 *  timestamps at all, and a post with a relative reference then reached the classifier dated as
 *  of today (reported 2026-11-01 on a French YouTube UI: a comment's `il y a 9 mois` produced no
 *  datetime, and `534 years ago` was researched against the day it was read rather than the day
 *  it was written). The spellings are taken from the platform's own CLDR data —
 *  `Intl.RelativeTimeFormat` formatted for each unit, count and style — rather than transcribed
 *  by hand, because a hand-written table goes stale silently and this one follows the engine's
 *  data wherever it changes.
 *
 *  Only the WORDS are learned, never the phrase: the count is read by the same digit test
 *  everywhere, and the host's words around it (`il y a`, `vor`, `ago`) are collected separately so
 *  the whole-string test can accept `il y a 5 j` without accepting a sentence that merely
 *  mentions a duration.
 *
 *  A spelling claimed by two units is DROPPED rather than assigned to the first: two languages on
 *  one page can spell different units alike (`j` is a day in French and a year in Dutch), and a
 *  wrong unit is a misdate, which is worse than the undated post this reader falls back to. A
 *  spelling claimed by EVERY unit is instead a particle that sits between count and unit in that
 *  language (`acum 101 de ani`), and is allowed to be skipped.
 *
 *  Unit-first phrasings (Swahili's `miezi 101 iliyopita`) are not covered: every spelling read
 *  here follows its count, which is what every measured host does. Such a label yields an
 *  undated post rather than a guessed one. */
function ageWords(): AgeWords {
  const locales = ageLocales();
  const key = locales.join('\u0001');
  if (ageWordsCache?.key === key) return ageWordsCache.words;

  const owners = new Map<string, Set<AgeUnit>>();
  const prefixes = new Set<string>();
  const suffixes = new Set<string>();
  const claim = (word: string, unit: AgeUnit): void => {
    const name = word.toLowerCase();
    const set = owners.get(name);
    if (set) set.add(unit);
    else owners.set(name, new Set([unit]));
  };
  for (const unit of AGE_UNITS) for (const name of unit.names) claim(name, unit);

  if (typeof Intl.RelativeTimeFormat === 'function') {
    for (const locale of locales) {
      for (const style of ['long', 'short', 'narrow'] as const) {
        let format: Intl.RelativeTimeFormat;
        try {
          format = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style });
        } catch {
          continue; // a locale this engine does not know
        }
        for (const unit of AGE_UNITS) {
          for (const count of AGE_SAMPLE_COUNTS) {
            let stated: string;
            try {
              stated = format.format(-count, unit.key);
            } catch {
              continue;
            }
            const number = AGE_NUMBER.exec(stated);
            if (!number) continue;
            const before = stated.slice(0, number.index).trim();
            const rest = stated.slice(number.index + number[0].length).replace(AGE_LEADING_SPACE, '');
            const word = AGE_WORD_RUN.exec(rest)?.[0];
            if (!word) continue;
            claim(word, unit);
            const after = rest.slice(word.length).trim();
            if (/\p{L}/u.test(before)) prefixes.add(before);
            if (/\p{L}/u.test(after)) suffixes.add(after);
          }
        }
      }
    }
  }

  const byName = new Map<string, AgeUnit>();
  const particles: string[] = [];
  for (const [name, set] of owners) {
    if (set.size === 1) byName.set(name, set.values().next().value!);
    else if (set.size === AGE_UNITS.length) particles.push(name);
  }

  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const longestFirst = (a: string, b: string): number => b.length - a.length;
  const names = [...byName.keys()].sort(longestFirst).map(escape).join('|');
  const particle = particles.sort(longestFirst).map(escape).join('|');
  const prefix = [...prefixes].sort(longestFirst).map(escape).join('|');
  const suffix = [...suffixes].sort(longestFirst).map(escape).join('|');
  const gap = '\\s*';
  // A count is never a fraction or the tail of one (`35.2M`), and its digits may be any script's
  // own (`قبل ۹ أشهر`); a unit spelling is never the start of a longer word in that language
  // (`mo` inside `mois`).
  const boundaryBefore = '(?<![\\p{Nd}.])';
  const boundaryAfter = '(?![\\p{L}\\p{M}\\p{Nd}])';
  const between = particle ? `(?:${particle})${gap}` : '';
  const words: AgeWords = {
    label: new RegExp(`${boundaryBefore}(\\p{Nd}+)${gap}(?:${between})?(${names})${boundaryAfter}`, 'giu'),
    alone: new RegExp(
      '^[^\\p{L}\\p{N}]*'
      + (prefix ? `(?:(?:${prefix})${gap})?` : '')
      + `\\p{Nd}+${gap}(?:${between})?(?:${names})`
      + (suffix ? `(?:${gap}(?:${suffix}))?` : '')
      + '[^\\p{L}\\p{N}]*$',
      'iu',
    ),
    byName,
  };
  ageWordsCache = { key, words };
  return words;
}

/** The count a run of digits states, in any script's own digits. Unicode lays every decimal block
 *  out as ten consecutive code points with zero first, which is what lets `قبل ۹ أشهر` be counted
 *  without a table of digit sets. */
function ageCount(digits: string): number {
  let value = 0;
  for (const char of digits) {
    const point = char.codePointAt(0)!;
    let zero = point;
    while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
    value = value * 10 + (point - zero);
  }
  return value;
}

/** Whether a string states nothing but an age.
 *
 *  For the hosts that give a timestamp no name of its own — no class, no attribute, nothing but
 *  the words on its face — the face is the only identifier there is, and a post's own WORDS can
 *  contain a duration (`3d printing`, `we waited 5m`). Read as a whole string, an age is
 *  unmistakable: a sentence that merely mentions one fails on the words around it. */
export function isAgeLabel(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  return text !== '' && ageWords().alone.test(text);
}

/** Whether a string OPENS with an age the host then labels: `5d • Edited`, `2yr · Modifié`.
 *
 *  A host that marks an edited post puts its own marker in the same element as the age, so the
 *  whole-string test above refuses a timestamp that is plainly one — and a post refused here
 *  carries no datetime at all, which is a post the classifier dates as of today. The age is the
 *  part before the host's own separator; the marker behind it is the host's words, so it may
 *  name anything as long as it states no number of its own (a second number would leave two
 *  ages in the string and no way to tell which one the host meant). Read second, never first:
 *  a label that is nothing but an age is decided by `isAgeLabel`, and this only rescues one the
 *  host has wrapped a marker around. Measured on LinkedIn, whose edited posts read `5d • Edited`
 *  in one span (2026-10-26). */
export function isLabelledAgeLabel(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  const at = text.search(/[•·|]/);
  if (at <= 0) return false;
  const marker = text.slice(at + 1).trim();
  return marker !== '' && !/\p{Nd}/u.test(marker) && ageWords().alone.test(text.slice(0, at).trim());
}

/** The instant a post's age label describes, for the hosts that state an age and no instant.
 *
 *  A host that renders a post's age as a duration — Quora's `Updated 6y`, Facebook's `18h` and
 *  the `1 day ago` inside its mobile author row — states when the post was written only relative
 *  to the moment the reader is reading it, so the instant is that moment less the age. The
 *  subtraction is exact and the date it lands on is not, and the value says so by stating only
 *  the fields the label placed (`CUT`) rather than filling the rest with zeroes: `5h` is an hour
 *  and carries no minutes, `3d` is a day, `6y` a bare year. A zero would be indistinguishable
 *  from a real reading, which is what makes omitting the honest form; a precise label is read
 *  precisely, down to the second.
 *
 *  The label's LAST number-and-unit is the one taken, because a host that names an age names it
 *  last — `Updated 6y` carries its age after the verb and the reader's own language may put
 *  words on either side. Anything without a number and a unit this knows — a date spelled out in
 *  full (`Sep 28`), a label in a language the page does not name (see `ageWords`), a post whose
 *  age the host states some other way — yields `undefined`, which is a post that carries no
 *  datetime rather than one reconstructed from a guess.
 *
 *  `now` is the moment the label was read, and is passed in only so a caller can pin it. */
export function isoDatetimeFromAge(label: string | null | undefined, now: Date = new Date()): string | undefined {
  const text = label?.trim() ?? '';
  if (!text) return undefined;
  let unit: AgeUnit | undefined;
  let count = 0;
  const words = ageWords();
  for (const match of text.matchAll(words.label)) {
    const found = words.byName.get(match[2].toLowerCase());
    if (!found) continue;
    unit = found;
    count = ageCount(match[1]);
  }
  if (!unit) return undefined;
  const at = new Date(now.getTime());
  // Floored BEFORE stepping back, which is what keeps a calendar unit from overflowing: stepping
  // a month back from March 31 lands on March 3, while zeroing the day first lands on February 1
  // — and a whole unit never disturbs the fields above it either way.
  unit.floor(at);
  unit.back(at, count);
  return Number.isFinite(at.getTime()) ? CUT[unit.precision](at.toISOString()) : undefined;
}
