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
