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
  /** Every spelling the host may use for the unit. */
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
    names: ['years', 'year', 'yrs', 'yr', 'y'],
    floor: (at) => {
      at.setUTCMonth(0, 1);
      MIDNIGHT(at);
    },
    back: (at, count) => at.setUTCFullYear(at.getUTCFullYear() - count),
    precision: 'year',
  },
  {
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
    names: ['weeks', 'week', 'wks', 'wk', 'w'],
    floor: MIDNIGHT,
    back: (at, count) => at.setUTCDate(at.getUTCDate() - 7 * count),
    precision: 'day',
  },
  {
    names: ['days', 'day', 'd'],
    floor: MIDNIGHT,
    back: (at, count) => at.setUTCDate(at.getUTCDate() - count),
    precision: 'day',
  },
  {
    names: ['hours', 'hour', 'hrs', 'hr', 'h'],
    floor: (at) => at.setUTCMinutes(0, 0, 0),
    back: (at, count) => at.setUTCHours(at.getUTCHours() - count),
    precision: 'hour',
  },
  {
    names: ['minutes', 'minute', 'mins', 'min', 'm'],
    floor: (at) => at.setUTCSeconds(0, 0),
    back: (at, count) => at.setUTCMinutes(at.getUTCMinutes() - count),
    precision: 'minute',
  },
  {
    names: ['seconds', 'second', 'secs', 'sec', 's'],
    floor: (at) => at.setUTCMilliseconds(0),
    back: (at, count) => at.setUTCSeconds(at.getUTCSeconds() - count),
    precision: 'second',
  },
];

/** Every spelling in the table above, longest first so `6mo` is offered as months before it is
 *  offered as minutes. */
const AGE_NAMES = AGE_UNITS.flatMap((unit) => unit.names)
  .sort((a, b) => b.length - a.length)
  .join('|');

/** The age a label states. The number is held to a whole one (`(?<![\d.])`) so a count that
 *  happens to share a letter with a unit — `35.2M followers` — is not read as an age: an age is
 *  never a fraction, and the letter after a fraction is not a unit a host states an age in. */
const AGE_LABEL = new RegExp(`(?<![\\d.])(\\d+)\\s*(${AGE_NAMES})(?![a-z])`, 'gi');

/** The same age, held to the WHOLE string and to nothing but age: `18h`, `· 58m`. */
const AGE_ALONE = new RegExp(`^[^\\p{L}\\p{N}]*\\d+\\s*(?:${AGE_NAMES})(?![a-z])[^\\p{L}\\p{N}]*$`, 'iu');

/** Whether a string states nothing but an age.
 *
 *  For the hosts that give a timestamp no name of its own — no class, no attribute, nothing but
 *  the words on its face — the face is the only identifier there is, and a post's own WORDS can
 *  contain a duration (`3d printing`, `we waited 5m`). Read as a whole string, an age is
 *  unmistakable: a sentence that merely mentions one fails on the words around it. */
export function isAgeLabel(value: string | null | undefined): boolean {
  const text = value?.trim() ?? '';
  return text !== '' && AGE_ALONE.test(text);
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
  return marker !== '' && !/\d/.test(marker) && AGE_ALONE.test(text.slice(0, at).trim());
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
 *  full (`Sep 28`), a label in a language these spellings do not cover, a post whose age the host
 *  states some other way — yields `undefined`, which is a post that carries no datetime rather
 *  than one reconstructed from a guess.
 *
 *  `now` is the moment the label was read, and is passed in only so a caller can pin it. */
export function isoDatetimeFromAge(label: string | null | undefined, now: Date = new Date()): string | undefined {
  const text = label?.trim() ?? '';
  if (!text) return undefined;
  let unit: AgeUnit | undefined;
  let count = 0;
  for (const match of text.matchAll(AGE_LABEL)) {
    const found = AGE_UNITS.find((candidate) => candidate.names.includes(match[2].toLowerCase()));
    if (!found) continue;
    unit = found;
    count = Number(match[1]);
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
