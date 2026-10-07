/** Bluesky post capture, MAIN-world half. (Named `bsky.capture` because WXT derives an
 *  entrypoint's name from the segment before its first dot, so `capture.bsky` would
 *  collide with X's `capture.main`.)
 *
 *  bsky.app renders every post from an XRPC JSON response, and that response carries
 *  three things the rendered markup does not: the post's own language (`record.langs`),
 *  its ancestor chain (`record.reply`), and its full untruncated body (`record.text`,
 *  against the DOM's "Show more" cut). Those fields are why the adapter's DOM half
 *  records a null `replyingTo` and no `sourceLanguage` today, and why the buttons for a
 *  post could only appear after it was laid out — the payload arrives first.
 *
 *  This runs in the MAIN world for the same reason X's interceptor does: the page's own
 *  `fetch` and `XMLHttpRequest` are different objects from the ones a content script
 *  sees in its isolated world, so patching from there would observe nothing. Declaring
 *  `world: 'MAIN'` (rather than injectScript) also keeps it clear of the page's CSP.
 *
 *  What it does is deliberately mechanical: find post-shaped records, copy the handful
 *  of fields the adapter decides on, and forward. Every judgement — id namespacing, how
 *  a verification status becomes a badge, which chain a reply belongs to — is made in the
 *  adapter, so this file needs no knowledge of the extension's data model.
 */
const NETWORK_MESSAGE = 'MF_NETWORK_POSTS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Every post-bearing response is an XRPC call, whatever host serves it — the PDS
 *  (`<user>.host.bsky.network`), the entryway (`bsky.social`) and the public AppView
 *  (`public.api.bsky.app`) all carry `/xrpc/<nsid>` in the path, and all three were
 *  observed on one page load. Matching the path rather than an endpoint name is what
 *  makes this survive a renamed or brand-new endpoint: the extraction below reads the
 *  response's SHAPE, so an endpoint nobody has listed yet still yields its posts. */
const XRPC_MARKER = '/xrpc/';
/** The collection name inside a post's at-uri, which is what identifies a post record
 *  rather than a profile, a follow, or a feed generator. */
const POST_COLLECTION = '/app.bsky.feed.post/';

/** Bounds on untrusted input. A response is page-controlled data, so the walk is bounded
 *  in depth and in what it will emit, and the replay buffer is capped.
 *
 *  The depth bound has been measured rather than guessed, because a walker's cap that sits
 *  one level short fails SILENTLY — it returns a populated result missing exactly the
 *  ancestors the chain is built from, and nothing downstream can tell. Measured 2026-10-01
 *  on `app.bsky.unspecced.getPostThreadV2`, which is what bsky.app actually calls now: the
 *  response is a FLAT list, every post view sat at depth 4, and the walk reached all 11 of
 *  them. So 12 carries three times the headroom the live shape needs.
 *
 *  The margin matters because the older `app.bsky.feed.getPostThread` NESTS its ancestors
 *  (`thread.parent.parent…`), which costs two levels per ancestor instead of none — roughly
 *  six ancestors at this bound rather than eleven. That shape was not observed on any page
 *  measured; if it reappears, this is the constant to re-measure first. */
const MAX_DEPTH = 12;
const MAX_RECORDS_PER_RESPONSE = 200;
const BUFFER_LIMIT = 600;

/** The fields of a post view this extension can use, copied verbatim. */
interface NetPost {
  uri: string;
  text: string;
  langs: string[] | null;
  parentUri: string | null;
  author: NetAuthor;
  quote: { uri: string; text: string; author: NetAuthor } | null;
}

interface NetAuthor {
  handle: string;
  did: string | null;
  displayName: string | null;
  verification: { verifiedStatus: string | null; trustedVerifierStatus: string | null } | null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

/** Whether an object is a post VIEW (what every feed and thread response embeds), and not
 *  the raw record, a profile, or a quoted-post card.
 *
 *  All four conditions are load-bearing. `uri` with the post collection excludes profiles
 *  and feeds; `author.handle` excludes a post by an account whose handle the server could
 *  not resolve, which nothing could name afterwards; `record.text` excludes quote CARDS
 *  (`record#viewRecord` carries `value`, not `record`) and every media-only embed. */
function isPostView(value: unknown): value is Record<string, any> {
  return isRecord(value)
    && typeof value.uri === 'string' && value.uri.includes(POST_COLLECTION)
    && isRecord(value.author) && typeof value.author.handle === 'string' && value.author.handle.length > 0
    && isRecord(value.record) && typeof value.record.text === 'string';
}

/** Narrow an author to the fields the adapter reads. Verification is narrowed to its two
 *  status strings rather than forwarded whole: it also carries per-issuer detail that
 *  nothing here uses and that would ride through every message otherwise. */
function compactAuthor(author: any): NetAuthor | null {
  if (!isRecord(author) || typeof author.handle !== 'string' || author.handle.length === 0) return null;
  const v = author.verification;
  return {
    handle: author.handle,
    did: typeof author.did === 'string' ? author.did : null,
    displayName: typeof author.displayName === 'string' ? author.displayName : null,
    verification: isRecord(v)
      ? {
          verifiedStatus: typeof v.verifiedStatus === 'string' ? v.verifiedStatus : null,
          trustedVerifierStatus: typeof v.trustedVerifierStatus === 'string' ? v.trustedVerifierStatus : null,
        }
      : null,
  };
}

/** The quoted post inside an embed, if there is one.
 *
 *  A quote hides at a different depth in each embed type: `record#view` puts the card at
 *  `embed.record`, while `recordWithMedia#view` puts it at `embed.record.record` beside
 *  the media. Searching for the card by its own `$type` rather than by path covers both,
 *  and would keep covering a third arrangement. */
function findQuoteCard(embed: any): any | null {
  if (!isRecord(embed)) return null;
  const stack: any[] = [embed];
  let guard = 0;
  while (stack.length > 0 && guard++ < 40) {
    const cur = stack.pop();
    if (!isRecord(cur)) continue;
    if (cur.$type === 'app.bsky.embed.record#viewRecord') return cur;
    for (const key of Object.keys(cur)) {
      if (isRecord(cur[key])) stack.push(cur[key]);
    }
  }
  return null;
}

function compactPost(view: any): NetPost | null {
  const author = compactAuthor(view.author);
  if (!author) return null;
  const card = findQuoteCard(view.embed);
  const quoteAuthor = card ? compactAuthor(card.author) : null;
  const reply = view.record?.reply;
  return {
    uri: view.uri,
    text: view.record.text,
    langs: Array.isArray(view.record.langs)
      ? view.record.langs.filter((l: unknown) => typeof l === 'string').slice(0, 3)
      : null,
    parentUri: typeof reply?.parent?.uri === 'string' ? reply.parent.uri : null,
    author,
    // A quoted card whose author cannot be named is dropped rather than attached with a
    // guessed handle: the quote is context, and context that names the wrong account is
    // worse than none.
    quote: card && quoteAuthor && typeof card.value?.text === 'string'
      ? { uri: String(card.uri ?? ''), text: card.value.text, author: quoteAuthor }
      : null,
  };
}

/** Walk a parsed response for post views. Shape-driven, so it does not care whether the
 *  posts hang off `feed`, `thread`, `posts`, `items` or something newer. */
function collectPosts(value: unknown, out: NetPost[], seen: Set<string>, depth: number): void {
  if (out.length >= MAX_RECORDS_PER_RESPONSE || depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPosts(item, out, seen, depth + 1);
    return;
  }
  if (isPostView(value)) {
    // One response legitimately repeats a post (a thread's root appears in its own
    // replies' `reply.root`), and the same post arrives again in every later page of a
    // feed. Deduping here only saves message size — the receiving half keys by post id.
    if (!seen.has(value.uri)) {
      seen.add(value.uri);
      const compact = compactPost(value);
      if (compact) out.push(compact);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isRecord((value as any)[key])) collectPosts((value as any)[key], out, seen, depth + 1);
  }
}

export default defineContentScript({
  matches: ['*://bsky.app/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a
    // disinfax_ return marker is about to be harvested and closed, and nothing from it
    // should enter the pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    const buffer: NetPost[] = [];
    const seenInBuffer = new Set<string>();

    function remember(records: NetPost[]): void {
      for (const record of records) {
        if (seenInBuffer.has(record.uri)) continue;
        seenInBuffer.add(record.uri);
        buffer.push(record);
      }
      while (buffer.length > BUFFER_LIMIT) {
        const dropped = buffer.shift();
        if (dropped) seenInBuffer.delete(dropped.uri);
      }
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const records: NetPost[] = [];
      collectPosts(parsed, records, new Set<string>(), 0);
      if (records.length === 0) return;
      console.log(`[misinfo] bsky: ${records.length} post(s) from ${label}`);
      remember(records);
      window.postMessage({ type: NETWORK_MESSAGE, records }, '*');
    }

    function labelOf(url: string): string {
      const match = url.match(/\/xrpc\/([^/?]+)/);
      return match?.[1] ?? url;
    }

    /** The URL of a fetch call, whichever of the three legal input shapes carries it.
     *
     *  bsky.app passes a `URL` OBJECT, not a string — measured at document start, every one
     *  of its XRPC calls did. A `URL` has no `.url` property, so reading that property (the
     *  obvious spelling, and what this did at first) silently matched nothing and the whole
     *  interceptor observed no traffic at all while the page looked perfectly healthy. */
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
      if (!url.includes(XRPC_MARKER)) return promise;
      // Read a clone: the response body is a stream, and consuming the original would
      // leave the page's own code with an empty one.
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
      if (href.includes(XRPC_MARKER)) {
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
      if (buffer.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: buffer }, '*');
    });
  },
});
