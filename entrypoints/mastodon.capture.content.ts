/** Mastodon post capture, MAIN-world half.
 *
 *  Mastodon's web client is the app Truth Social's is a fork of, and it fetches everything it
 *  shows from `/api/v1/…` JSON: a timeline, a tag's posts, a profile, and — the one response
 *  this file exists for — `/api/v1/statuses/<id>/context` on a permalink, whose `ancestors`
 *  and `descendants` arrays each carry every post's own `in_reply_to_id`.
 *
 *  That field is the ONE thing this adapter cannot get anywhere else. The rendered markup
 *  states which posts are on screen and whose they are, but never what any of them answers:
 *  measured across a whole thread, no rendered row carries a parent in an attribute or a link.
 *  The API's response is therefore read for ancestors alone. Its text is deliberately NOT
 *  used — the renderer lifts a trailing hashtag-only line out of the body and into a bar of
 *  its own, so the payload's string and the page's differ for the same post, and a claim
 *  measured against one and painted over the other lands on words it never named.
 *
 *  This runs in the MAIN world for the same reason X's and Truth Social's interceptors do: the
 *  page's own `fetch` and `XMLHttpRequest` are different objects from the ones a content
 *  script sees in its isolated world, so patching from there would observe nothing — and
 *  measured, the API is reached by XHR (patching `fetch` alone saw no request at all), so the
 *  XHR patch below is the one that does the work.
 *
 *  What it does is deliberately mechanical: walk a response for status-shaped records, copy
 *  each one's id and the id it answers, and forward. Every judgement — id namespacing, what an
 *  edge means for a chain — is made in the adapter, so this file needs no knowledge of the
 *  extension's data model.
 */
const THREAD_EDGE_MESSAGE = 'MF_NETWORK_THREAD_EDGES';

/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed — measured, the context response lands a full second before the first row
 *  renders), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Every post-bearing response on this site is served from `/api/v<n>/…` under the instance's
 *  own origin — the version segment is what the app is on today (v1 for timelines, statuses
 *  and their contexts, v2 for instance and suggestion endpoints), so the marker is the
 *  `/api/v` prefix rather than any one version. Matching the path instead of an endpoint name
 *  is what makes this survive a renamed or brand-new endpoint: the extraction below reads the
 *  response's SHAPE, so an endpoint nobody has listed yet still yields its edges. */
const API_MARKER = '/api/v';

/** Bounds on untrusted input. A response is page-authored data, so the walk is bounded in
 *  depth and in what it will emit, and the replay buffer is capped. */
const MAX_DEPTH = 12;
const MAX_RECORDS_PER_RESPONSE = 200;
const EDGE_BUFFER_LIMIT = 1024;

/** The edge this half is here for: a post's id and the id of the post it answers. Two ids and
 *  no text — an edge carries no words, no author and no language, so nothing about it is
 *  classified. */
interface NetThreadEdge {
  id: string;
  parentId: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A status is recognized by its shape rather than by the endpoint that served it: every one
 *  embeds its own `account` and states a digit id. An account object has an id of its own but
 *  no account inside it, so the pair is what tells the two apart.
 *
 *  The body is deliberately not required. A post with no words — an image with alt text, a
 *  poll — is still a post in a thread, and the posts that answer it still have a parent. */
function isStatus(value: unknown): value is Record<string, any> {
  if (!isRecord(value)) return false;
  const { id, account } = value as { id?: unknown; account?: unknown };
  return typeof id === 'string' && /^\d{6,}$/.test(id) && isRecord(account);
}

/** Every `{id, parentId}` in a response, in any shape it is nested.
 *
 *  Driven by the response's shape rather than by a list of endpoints because the same three
 *  shapes all carry statuses: a bare status (`/api/v1/statuses/<id>`), an array of them (a
 *  timeline, a profile, an account's posts), and an object of arrays (`ancestors` and
 *  `descendants`). One walk covers all of them, including endpoints this file has never been
 *  told about.
 *
 *  It does NOT descend past a status, with one exception: a boost wraps the post it boosts in
 *  `reblog`, and the post a reader sees — the one the markup gives a `data-id` to — is the
 *  inner one, whose own ancestors are what matter. The wrapper's edge is emitted too; it
 *  names a carrier that is never rendered as a post of its own, and costs nothing. */
function collectEdges(value: unknown, out: NetThreadEdge[], depth: number): void {
  if (depth > MAX_DEPTH || out.length >= MAX_RECORDS_PER_RESPONSE) return;
  if (Array.isArray(value)) {
    for (const item of value) collectEdges(item, out, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (isStatus(value)) {
    const parent = (value as { in_reply_to_id?: unknown }).in_reply_to_id;
    // A post answering itself would make the chain builder break a legitimate edge, and a
    // payload is page-authored data: dropped rather than trusted.
    if (typeof parent === 'string' && /^\d+$/.test(parent) && parent !== value.id) {
      out.push({ id: value.id as string, parentId: parent });
    }
    collectEdges(value.reblog, out, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) collectEdges(value[key], out, depth + 1);
}

export default defineContentScript({
  // The default instance only, matching `PLATFORM_HOSTS.mastodon`. Federated hosts cannot be
  // enumerated, so every OTHER instance gets this file from the registration the opt-in makes
  // at runtime (`chrome.scripting.registerContentScripts`, see utils/mastodonOptIn.ts) — which
  // is also why this entrypoint cannot use WXT's own `registration: 'runtime'`: that routes
  // the pattern into `host_permissions` as a required grant instead. `mastodon.social` is
  // declared statically so the default instance needs no opt-in; the registered copies cover
  // the rest.
  matches: ['*://mastodon.social/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (location.search.includes('disinfax_oauth=callback')) return;

    /** Edges by the child's id rather than in a list, because a post answers exactly one
     *  post: the map IS the dedupe, and a thread re-fetched or re-rendered states the same
     *  edges again. */
    const edgeBuffer = new Map<string, NetThreadEdge>();

    function remember(records: NetThreadEdge[]): void {
      for (const record of records) edgeBuffer.set(record.id, record);
      while (edgeBuffer.size > EDGE_BUFFER_LIMIT) {
        const oldest = edgeBuffer.keys().next().value;
        if (oldest === undefined) break;
        edgeBuffer.delete(oldest);
      }
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const records: NetThreadEdge[] = [];
      collectEdges(parsed, records, 0);
      if (records.length === 0) return;
      console.log(`[misinfo] mastodon: ${records.length} thread edge(s) from ${label}`);
      remember(records);
      window.postMessage({ type: THREAD_EDGE_MESSAGE, records }, '*');
    }

    function labelOf(url: string): string {
      const match = url.match(/\/api\/v\d+\/([^/?]+)/);
      return match?.[1] ?? url;
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

    // Both are patched: XHR is what the app actually uses (measured), and fetch is patched
    // alongside it so an endpoint that switches transports does not silently go dark.
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
      if (edgeBuffer.size > 0) {
        window.postMessage({ type: THREAD_EDGE_MESSAGE, records: [...edgeBuffer.values()] }, '*');
      }
    });
  },
});
