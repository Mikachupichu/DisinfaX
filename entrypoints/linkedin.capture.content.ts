/** LinkedIn translation-state capture, MAIN-world half.
 *
 *  LinkedIn's own translation control does not mark the side it is showing. That is measured,
 *  not assumed: flipping a post produces a byte-identical card — 1391 elements compared element
 *  by element and attribute by attribute across the flip, and not one difference — with no
 *  `lang`, no `data-*`, no class change, and the commentary wrapper's `id` (which carries the
 *  content URN and the target locale) carrying the same bytes before and after. The only thing
 *  that changes is the control's own label, which is translated per reader and is exactly what
 *  must not be keyed on. Nor is the source recoverable from the page: a post that arrives
 *  already translated renders the translation and nothing else — the source text is in no text
 *  node, no attribute and no payload (measured) — so the adapter has to drive the host's own
 *  control to get it back.
 *
 *  What the payload does carry is the state of that control, and it carries it for posts whose
 *  translation the reader is being shown on a fresh load, which is the case the DOM cannot
 *  cover at all. LinkedIn's SDUI tree writes a `proto.sdui.State` per remembered thing, and the
 *  translation one is:
 *
 *    {"$type":"proto.sdui.State","stateKey":"",
 *     "value":{"$case":"stringValue","stringValue":"Original"},
 *     "key":{"$type":"proto.sdui.StateKey","value":"TranslationState-<blob><cardKey>",…}}
 *
 *  Two measured facts make that usable. The value is `"Original"` or `"Translated"` and it
 *  agrees with what is on screen — the one translated post among six carrying `"Translated"`
 *  while the five showing their own words carry `"Original"`. And the key ENDS with the
 *  `componentkey` of the very element that renders the post's translation — the element holding
 *  both the commentary and the control — so the DOM can find its own state by testing its
 *  ancestor keys against the keys remembered here. The blob in the middle is opaque to us and
 *  is left alone: its content id is not always populated (`TranslationState-null…` is a real
 *  shape observed), whereas the trailing component key always is.
 *
 *  So this file forwards state, never text. There is no post here to classify — a translation
 *  record names no author, no body and no id — and its only reader is the adapter's
 *  `displayedTranslationLocale`, which is the question the DOM cannot answer for itself.
 *
 *  It runs in the MAIN world for the same reason X's, Bluesky's, Truth Social's and Threads'
 *  interceptors do: the page's own `fetch` and `XMLHttpRequest` are different objects from the
 *  ones an isolated content script sees, so patching from there would observe nothing.
 */
const TRANSLATION_MESSAGE = 'MF_NETWORK_TRANSLATIONS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Every translation response comes from the SDUI action endpoints under this path — the
 *  pagination that renders the feed, the page's own feed payload, and the two per-post
 *  `…translation.translatedText` / `…translation.originalText` server-requests a flip makes.
 *  Matching the path rather than an operation name is what keeps a post's own flip observed
 *  without this file having to know either operation. */
const API_MARKER = '/flagship-web/';

/** The state key LinkedIn mints. Bounded generously — the blob's length is not known and the
 *  key is opaque, so the bound is only there to stop a runaway match on a corrupt payload. */
const STATE_KEY = /TranslationState-[A-Za-z0-9+/=_-]{8,140}/g;

/** The value belonging to a state key. It PRECEDES the key inside the same state object
 *  (`…"value":{"$case":"stringValue","stringValue":"Original"},…"value":"TranslationState-…"`),
 *  so the nearest one behind the key is that key's own. The quotes may be backslash-escaped:
 *  the same payload is carried both raw and as a string inside a flight row, and the escaping
 *  is the only thing that differs between the two copies. */
const STATE_VALUE = /\\?"stringValue\\?":\\?"(Original|Translated)\\?"/g;

/** How far behind a key its value may sit. A state object measures ~200 characters; the window
 *  is doubled for slack and is what keeps a value from a neighbouring object being taken. */
const VALUE_WINDOW = 400;

const BUFFER_LIMIT = 400;

export interface NetTranslation {
  key: string;
  state: 'Original' | 'Translated';
}

/** The last value written before `index`, scanning backwards. */
function valueBefore(text: string, index: number): 'Original' | 'Translated' | null {
  const window = text.slice(Math.max(0, index - VALUE_WINDOW), index);
  let last: 'Original' | 'Translated' | null = null;
  for (const m of window.matchAll(STATE_VALUE)) last = m[1] as 'Original' | 'Translated';
  return last;
}

/** Every translation state a response declares. A text scan rather than a parse: the body is a
 *  flight stream carrying the same tree twice — once raw and once as an escaped string — so it
 *  is not one JSON document to walk, and the state objects are shallow enough to read directly. */
function collectStates(text: string, out: NetTranslation[], seen: Set<string>): void {
  for (const m of text.matchAll(STATE_KEY)) {
    const key = m[0];
    if (seen.has(key)) continue;
    const state = valueBefore(text, m.index ?? 0);
    if (!state) continue;
    seen.add(key);
    out.push({ key, state });
  }
}

export default defineContentScript({
  // Every name the app is served from, including the per-reader locale subdomains LinkedIn
  // uses (`de.linkedin.com` and the rest), so the interceptor is installed on all of them.
  matches: ['*://*.linkedin.com/*', '*://linkedin.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a disinfax_
    // return marker is about to be harvested and closed, and nothing from it should enter
    // the pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    const buffer: NetTranslation[] = [];
    const seen = new Set<string>();

    function remember(records: NetTranslation[]): void {
      for (const record of records) {
        if (seen.has(record.key)) continue;
        seen.add(record.key);
        buffer.push(record);
      }
      while (buffer.length > BUFFER_LIMIT) {
        const dropped = buffer.shift();
        if (dropped) seen.delete(dropped.key);
      }
    }

    function harvest(text: string, label: string): void {
      const records: NetTranslation[] = [];
      collectStates(text, records, new Set<string>());
      if (records.length === 0) return;
      console.log(`[misinfo] linkedin: ${records.length} translation state(s) from ${label}`);
      remember(records);
      window.postMessage({ type: TRANSLATION_MESSAGE, records }, '*');
    }

    function labelOf(url: string): string {
      return url.match(/\/(rsc-action\/actions\/[a-z-]+|feed)\b/)?.[1] ?? 'flagship-web';
    }

    /** The URL of a fetch call, whichever of the three legal input shapes carries it.
     *  A `URL` has no `.url` property, so reading that property (the obvious spelling)
     *  silently matches nothing. */
    function requestUrl(input: any): string {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;    // Request
      if (input && typeof input.href === 'string') return input.href;  // URL
      return '';
    }

    const originalFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
      const promise = originalFetch.call(this, input, init);
      const url = requestUrl(input);
      if (!url.includes(API_MARKER)) return promise;
      // Read a clone: the response body is a stream, and consuming the original would leave
      // the page's own code with an empty one.
      return promise.then((response: Response) => {
        try {
          response.clone().text().then((text) => harvest(text, labelOf(url))).catch(() => {});
        } catch {}
        return response;
      });
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method: string, url: string | URL) {
      const href = String(url);
      if (href.includes(API_MARKER)) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.responseText === 'string') harvest(this.responseText, labelOf(href));
          } catch {}
        });
      }
      return originalOpen.apply(this, arguments as any);
    };

    // The isolated half may not have been listening when the first responses landed.
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== HELLO_MESSAGE) return;
      if (buffer.length > 0) window.postMessage({ type: TRANSLATION_MESSAGE, records: buffer }, '*');
    });
  },
});
