/** Pure source-normalization helpers (no dependencies beyond data types).
 *
 *  These lived in utils/intelligence.ts, but that module imports the Supabase
 *  client — and ES module imports execute the whole file. So the content scripts
 *  (relay → injecting → intelligence) were bundling a full GoTrueClient with the
 *  shared storage adapter into every x.com tab, where each page load ran
 *  `_recoverAndRefresh()` against the one session slot and could wipe it
 *  (`_removeSession`, no server call) — logging the user out with zero server logs.
 *  Content scripts never call any Supabase API; they only need these pure
 *  functions. Kept in a module that imports nothing executable so that stays true:
 *  do NOT add stateful or networked imports here.
 */
import { Source } from "../data/Classification";

/** Normalize raw sources from the model into Source[].
 *  Supports:
 *    - Dictionary {url: title} (classify worker output)
 *    - Dictionary {title: url} (legacy)
 *    - Array of strings or {url, title, domain} objects
 *  Heuristic: if a dictionary key looks like an HTTP URL, treat it as {url: title}. */
export function normalizeSources(sources: unknown): Source[] {
  if (!sources) return [];
  if (typeof sources === 'object' && !Array.isArray(sources)) {
    const result: Source[] = [];
    for (const [key, val] of Object.entries(sources as Record<string, unknown>)) {
      if (typeof val === 'string') {
        if (key.match(/^https?:\/\//)) {
          result.push({ url: key, title: val });
        } else {
          result.push({ title: key, url: val });
        }
      }
    }
    return result;
  }
  if (!Array.isArray(sources)) return [];
  const result: Source[] = [];
  for (const s of sources) {
    if (typeof s === 'string') {
      result.push({ url: s, title: extractDomainFromUrl(s) });
    } else if (typeof s === 'object' && s !== null) {
      const obj = s as Record<string, unknown>;
      if (obj.url || obj.title || obj.domain) {
        result.push({
          url: obj.url as string | undefined,
          title: (obj.title as string | undefined) ?? (obj.domain as string | undefined)
        });
      }
    }
  }
  return result;
}

/** Extract a human-readable domain from a URL string (e.g. "https://www.xinhua.com/..." → "xinhua.com"). */
function extractDomainFromUrl(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return urlStr;
  }
}

/** Deduplicate sources by URL, keeping the first occurrence. */
export function deduplicateSources(sources: Source[] | undefined): Source[] {
  if (!sources) return [];
  const seen = new Set<string>();
  return sources.filter(s => {
    const key = s.url ?? s.title ?? '';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The passages a URL's text fragment (`#:~:text=…`) highlights, decoded.
 *
 *  Empty when the URL carries no text directive — the reader then lands on the whole
 *  page, not on a passage. A directive is `text=<passage>` or
 *  `text=<before>-,<passage>,-<after>`, where only the middle part is highlighted, and
 *  several may follow one another after `&`. */
export function textFragmentPassages(url: string): string[] {
  const hash = url.indexOf('#');
  if (hash < 0) return [];
  const marker = url.slice(hash).indexOf(':~:');
  if (marker < 0) return [];
  const passages: string[] = [];
  for (const directive of url.slice(hash + marker + 3).split('&')) {
    if (!directive.startsWith('text=')) continue;
    let value = directive.slice('text='.length);
    const beforeEnd = value.indexOf('-,');
    if (beforeEnd >= 0) value = value.slice(beforeEnd + 2);
    const afterStart = value.lastIndexOf(',-');
    if (afterStart >= 0) value = value.slice(0, afterStart);
    const passage = decodeFragmentText(value).trim();
    if (passage) passages.push(passage);
  }
  return passages;
}

function decodeFragmentText(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** The webpage a URL names, ignoring the passage it highlights: protocol, host
 *  (case-folded), path without a trailing slash, and query. Null when unparsable. */
export function webpageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return null;
  }
}

/** Lowercased word tokens, with punctuation and spacing dropped. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

/** Whether two word runs share a contiguous stretch long enough to call it the same
 *  text: four words at minimum, and at least half of the shorter run. */
function sharesRun(a: string[], b: string[]): boolean {
  const need = Math.max(4, Math.ceil(Math.min(a.length, b.length) / 2));
  if (a.length < need || b.length < need) return false;
  for (let i = 0; i + need <= a.length; i++) {
    for (let j = 0; j + need <= b.length; j++) {
      let k = 0;
      while (k < need && a[i + k] === b[j + k]) k++;
      if (k === need) return true;
    }
  }
  return false;
}

/** Drop the sources that only point back at the page the reader is already on.
 *
 *  A source is dropped when its URL names the current webpage and the passage its text
 *  fragment highlights overlaps the text this claim already has highlighted — the link
 *  leads back to the very words under it. A source with no text fragment stands for the
 *  whole page, which contains that text, so it is dropped too. With a single linkable
 *  source left the row keeps it, and a filter that would empty the row returns the
 *  original list rather than render no sources at all. */
export function withoutSelfSources(sources: Source[], pageUrl: string, claimTexts: string[]): Source[] {
  const page = webpageKey(pageUrl);
  if (!page || sources.filter(s => !!s.url).length <= 1) return sources;
  const claimRuns = claimTexts.map(wordsOf).filter(run => run.length > 0);
  const kept = sources.filter(s => {
    if (!s.url || webpageKey(s.url) !== page) return true;
    const passages = textFragmentPassages(s.url);
    if (passages.length === 0) return false;
    return !passages.some(passage => {
      const run = wordsOf(passage);
      return claimRuns.some(claim => sharesRun(run, claim));
    });
  });
  return kept.some(s => !!s.url) ? kept : sources;
}
