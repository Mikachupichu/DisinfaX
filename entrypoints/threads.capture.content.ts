/** Threads post capture, MAIN-world half.
 *
 *  Threads' web client is a React app fed by Meta's GraphQL endpoint (`/api/graphql` for
 *  the page's initial data, `/graphql/query` for every page after it), so a post exists as
 *  JSON before it exists as markup. This file is what reads that JSON.
 *
 *  The reason to prefer it over the DOM is truncation, and it is measurable rather than
 *  theoretical. Captured live against the rendered page, the same post differs between the
 *  two sources in exactly two ways, both of them the renderer throwing characters away:
 *  a caption long enough to be clipped ends at `View N more` in the markup while the
 *  payload carries every paragraph, and an inline link renders as `meta.com/thefu…` while
 *  the payload carries `meta.com/thefutureisforeveryone`. Neither is a difference of
 *  opinion — the payload is the authored text and the markup is a crop of it — so the
 *  caption is what gets classified and the markup is only asked where to paint it.
 *
 *  What the payload does NOT carry is also measured, because it decides the one field the
 *  adapter still leaves empty: `detected_language` (and `original_lang_for_translations`) is
 *  null on every post observed, so no source language is claimed.
 *
 *  A post's PARENT it does carry, though not under a field named for one. A reply thread is
 *  `text_post_app_info.direct_replies.edges[i].node.posts.edges`, and that list is ordered:
 *  entry 0 answers the post the connection hangs off, and every later entry answers the one
 *  before it. That is where the parent is read from — `reply_to_author` and `is_reply` name
 *  the ACCOUNT being answered, never the post. The post at the head of such a list is named
 *  only by a numeric id, because Relay answers a thread request with a partial record for it
 *  (`{id, text_post_app_info}`, no shortcode), so that id is resolved against the `id` of
 *  every full post record seen; a head whose post has not been seen yet keeps a null parent
 *  rather than a guessed one.
 *
 *  The post a post QUOTES is named exactly, at `text_post_app_info.share_info.quoted_post`.
 *  It is copied into the quoting post's own record and never forwarded as a post of its own:
 *  a quote card renders without a header, so it is a post the adapter could never put
 *  buttons on.
 *
 *  Two further facts this file relies on, both verified from the payload: a caption's
 *  paragraphs are separated by a blank line, and a post's attachments are NOT part of the
 *  caption at all — `text_post_app_info.link_preview_attachment` is populated exactly on the
 *  post that renders a link card, and its headline and domain appear nowhere in
 *  `caption.text`. That is the same words-only boundary X gets from `card.wrapper` standing
 *  outside `tweetText`, and here it comes for free.
 *
 *  The same endpoint answers a second question the markup cannot. A post's translation is
 *  fetched on demand — a first flip is one POST answered by `xdt_translate_comment` — and the
 *  page then renders it in place of the post's own words with nothing marking the swap: no
 *  `lang`, no `data-*`, no stable class, and the only label that changes is the control's own
 *  locale-dependent text, which is exactly what must not be keyed on. The translation's OWN
 *  TEXT is what carries across (see `absorbTranslations` in the adapter), so it is forwarded
 *  alongside the posts, on its own channel because it is not a post.
 *
 *  It runs in the MAIN world for the same reason X's, Bluesky's and Truth Social's
 *  interceptors do: the page's own `fetch` and `XMLHttpRequest` are different objects from
 *  the ones an isolated content script sees, so patching from there would observe nothing.
 *  Everything below is deliberately mechanical — find post-shaped records, copy the handful
 *  of fields the adapter decides on, forward — so that every judgement (id namespacing, how
 *  a verification flag becomes a badge) stays in the adapter.
 */
const NETWORK_MESSAGE = 'MF_NETWORK_POSTS';
/** The app's own translation of a post, on its own channel: it is not a post, and the
 *  adapter is what decides whether a platform's DOM needs it. */
const TRANSLATION_MESSAGE = 'MF_NETWORK_TRANSLATIONS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Both of the app's GraphQL names, matched by their common path segment rather than by a
 *  full URL, so a new query name on either one still yields its posts. The extraction below
 *  reads the response's SHAPE, so an operation nobody has listed yet is covered too. */
const API_MARKER = '/graphql';

/** Bounds on untrusted input. A response is page-controlled data, so the walk is bounded in
 *  depth and in what it will emit, and the replay buffer is capped.
 *
 *  The depth bound is set by measurement rather than taste, because Relay buries its data
 *  deep and the number varies with the query: inside a hydration blob, the posts a reply
 *  permalink renders sat 7, 12, 14 and 14 levels down a path of keys and array indices. The
 *  bound is comfortably above that, and the reply walk below is bounded separately, since it
 *  descends for a reason the generic walk never does. */
const MAX_DEPTH = 24;
const MAX_RECORDS_PER_RESPONSE = 200;
/** How deep a reply thread may nest before the walk stops following it. Threads indents
 *  replies on a page and a chain is one list per connection, so this is a bound on the
 *  platform's own data rather than on anything the extension renders. */
const MAX_CHAIN_DEPTH = 12;
/** How many `id -> shortcode` mappings to keep. Only thread heads need them, and a browsing
 *  session can visit a great many posts, so the oldest is dropped rather than the map grown. */
const MAX_ID_MAP = 4000;
const BUFFER_LIMIT = 600;
/** Translations are one post each, and a reader flips a handful per page, so these are far
 *  smaller than the post bounds above. A translation is also the size of a post. */
const MAX_TRANSLATIONS_PER_RESPONSE = 20;
const TRANSLATION_BUFFER_LIMIT = 64;

/** The fields of a post this extension can use, copied verbatim. */
interface NetPost {
  code: string;
  text: string;
  username: string;
  verified: boolean;
  /** Shortcode of the post this one directly answers, when the payload says so. */
  parent: string | null;
  /** The post this one embeds, when it embeds one. */
  quoted: NetQuoted | null;
}

/** An embedded post: the same fields as a post, and no references of its own — a quoted
 *  post cannot quote, so nothing below this level is read. */
interface NetQuoted {
  code: string;
  text: string;
  username: string;
  verified: boolean;
}

/** What a post's shortcode looks like. Its permalink is built from it, so a record whose
 *  `code` does not have this shape is not a post this extension can address. */
const CODE_RE = /^[A-Za-z0-9_-]{5,}$/;

/** One response's harvest: the posts found, every record seen while walking it (so a second
 *  sighting can fill in what the first could not know), and the page-wide id mapping. */
interface Walk {
  out: NetPost[];
  index: Map<string, NetPost>;
  /** Numeric post id -> shortcode, remembered for the life of the page: the post a reply
   *  thread hangs off is named only by an id on the partial record that carries it. */
  ids: Map<string, string>;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

/** Whether an object is a post, narrowed to the fields the adapter reads.
 *
 *  The test is shape-driven, not endpoint-driven: a post is an object whose `code` is the
 *  shortcode its permalink is built from, whose `caption.text` is the authored body, and
 *  whose `user.username` names its author. Requiring all three is what excludes the rest of
 *  what these responses are full of — media (no code), accounts (no caption), and the
 *  caption-less wrappers around them — without naming a single query.
 *
 *  A post with no caption text is dropped rather than forwarded: a media-only post has
 *  nothing to fact-check, and the adapter would drop it one step later anyway. */
function isPost(value: unknown): value is Record<string, any> {
  return isRecord(value)
    && typeof value.code === 'string' && CODE_RE.test(value.code)
    && isRecord(value.caption) && typeof value.caption.text === 'string' && value.caption.text.trim().length > 0
    && isRecord(value.user) && typeof value.user.username === 'string' && value.user.username.length > 0;
}

/** A post as the adapter reads it. `parent` is the CALLER's and not the record's: the payload
 *  states a post's parent by position (see `walkReplies`), so only the walk knows it. */
function compactPost(value: Record<string, any>, parent: string | null): NetPost {
  return {
    code: value.code,
    text: value.caption.text,
    username: value.user.username,
    verified: value.user.is_verified === true,
    parent,
    quoted: compactQuoted(value.text_post_app_info?.share_info?.quoted_post),
  };
}

function compactQuoted(value: unknown): NetQuoted | null {
  if (!isPost(value)) return null;
  return {
    code: value.code,
    text: value.caption.text,
    username: value.user.username,
    verified: value.user.is_verified === true,
  };
}

/** The shortcode a numeric post id names, once a full record for that post has been seen.
 *  Null until then — the walk reports no parent rather than a half-resolved one. */
function shortcodeOf(id: unknown, walk: Walk): string | null {
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return walk.ids.get(String(id)) ?? null;
}

/** One reply thread, in order, each entry parented to the one before it.
 *
 *  `text_post_app_info.direct_replies.edges[i].node.posts.edges` is a single thread: entry 0
 *  answers `ownerCode` — the post whose connection this is — and each later entry answers its
 *  predecessor. Nothing has to be inferred from the page's indentation or from
 *  `reply_to_author`, both of which name things other than the post being answered.
 *
 *  `ownerCode` is null when the owning record is one of Relay's partials and its id has not
 *  been resolved yet; that thread's first entry is then reported with no parent, which the
 *  coordinator reads as "no ancestor known" rather than as "no ancestor". */
function walkReplies(info: any, ownerCode: string | null, walk: Walk, chainDepth: number): void {
  const edges = info?.direct_replies?.edges;
  if (!Array.isArray(edges) || chainDepth > MAX_CHAIN_DEPTH) return;
  for (const edge of edges) {
    const posts = edge?.node?.posts?.edges;
    if (!Array.isArray(posts)) continue;
    let parent = ownerCode;
    for (const entry of posts) {
      const node = entry?.node;
      if (!isPost(node)) continue;
      emitPost(node, walk, parent, chainDepth + 1);
      parent = node.code;
    }
  }
}

/** Emit one post record, remember what its id names, and follow its own reply thread. */
function emitPost(value: Record<string, any>, walk: Walk, parent: string | null, chainDepth: number): void {
  if (walk.out.length >= MAX_RECORDS_PER_RESPONSE || chainDepth > MAX_CHAIN_DEPTH) return;
  if (typeof value.id === 'string' || typeof value.id === 'number') {
    const id = String(value.id);
    if (!walk.ids.has(id)) {
      walk.ids.set(id, value.code);
      while (walk.ids.size > MAX_ID_MAP) {
        const oldest = walk.ids.keys().next().value;
        if (oldest === undefined) break;
        walk.ids.delete(oldest);
      }
    }
  }
  const known = walk.index.get(value.code);
  if (known) {
    // One post reaches the walk twice when a response contains both it and the thread that
    // names it — once generically, where no parent is knowable, and once from the thread.
    // The better answer wins, whichever order they arrive in.
    if (parent && !known.parent) known.parent = parent;
    const quoted = compactQuoted(value.text_post_app_info?.share_info?.quoted_post);
    if (quoted && !known.quoted) known.quoted = quoted;
  } else {
    const record = compactPost(value, parent);
    walk.index.set(record.code, record);
    walk.out.push(record);
  }
  walkReplies(value.text_post_app_info, value.code, walk, chainDepth);
}

/** Walk a parsed response for posts. Shape-driven, so it does not care whether the posts
 *  hang off `edges[].node`, `thread_items`, `feed_items` or something newer. */
function collectPosts(value: unknown, walk: Walk, depth: number): void {
  if (walk.out.length >= MAX_RECORDS_PER_RESPONSE || depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPosts(item, walk, depth + 1);
    return;
  }
  const record: any = value;
  if (isPost(record)) {
    emitPost(record, walk, null, 0);
    // Deliberately no descent past a post. The app nests its own related posts inside some
    // records — the quoted post (`share_info.quoted_post`, read by `compactPost`) is one —
    // and each is reached by its own record in the same response, so descending here would
    // take a second copy through a shape the adapter never asked for. Reply threads are the
    // exception, and `emitPost` has already followed them.
    return;
  }
  // Relay answers a thread request with a PARTIAL record for the post the thread belongs to
  // — `{id, text_post_app_info}`, no shortcode, no caption — so this is the one place its
  // reply threads can be reached. Its id resolves only once a full record for the same post
  // has been seen (a permalink's own hydration blob is where that comes from).
  if (record.text_post_app_info) {
    walkReplies(record.text_post_app_info, shortcodeOf(record.id, walk), walk, 0);
  }
  for (const key of Object.keys(record)) {
    if (isRecord(record[key])) collectPosts(record[key], walk, depth + 1);
  }
}

/** Relay's hydration data, which is where a permalink's post comes from.
 *
 *  The app streams its initial data into `<script type="application/json">` elements holding
 *  Relay's own `__bbox` envelopes rather than answering a request with it, so none of the
 *  above sees a post permalink's own post: measured on one, every post was captured with no
 *  caption from the payload at all and the whole page had to fall back to the markup. Reading
 *  those elements is the difference between the focal post being classified as authored and
 *  being classified as the renderer cropped it.
 *
 *  The marker is the app's own field name inside the app's own hydration scripts, not a class
 *  or a piece of text, so a restyle cannot move it. Elements are remembered in a WeakSet so
 *  the same blob is never parsed twice and nothing is written back to the page. */
const HYDRATION_MARKER = '__bbox';

/** The list the app's translate operation answers with, under the operation's own name —
 *  measured: `{"data":{"xdt_translate_comment":{"comment_translations":[{"id","translation"}]}}}`.
 *
 *  Named rather than guessed at because the entries have no shape of their own to recognise
 *  them by: `{id, translation}` is far too generic to match on inside a response full of
 *  Meta's own objects, and a false positive here would have the adapter recognising some
 *  unrelated string as a post's translation. */
const TRANSLATION_LIST_KEY = 'comment_translations';

/** A post's translated body, as the app's own translate operation returns it. */
interface NetTranslation {
  id: string;
  translation: string;
}

function isTranslation(value: unknown): value is Record<string, any> {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.translation === 'string' && value.translation.trim().length > 0;
}

/** Walk a parsed response for translations. Mirrors `collectPosts`: shape-driven, bounded,
 *  and it does not descend past what it has found. */
function collectTranslations(value: unknown, out: NetTranslation[], seen: Set<string>, depth: number): void {
  if (out.length >= MAX_TRANSLATIONS_PER_RESPONSE || depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTranslations(item, out, seen, depth + 1);
    return;
  }
  const list = (value as any)[TRANSLATION_LIST_KEY];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isTranslation(entry) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push({ id: entry.id, translation: entry.translation });
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isRecord((value as any)[key])) collectTranslations((value as any)[key], out, seen, depth + 1);
  }
}

export default defineContentScript({
  // Every name Threads serves the app from: the apex redirects to `www.`, and the app is
  // served at either TLD.
  matches: ['*://threads.com/*', '*://www.threads.com/*', '*://threads.net/*', '*://www.threads.net/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a disinfax_
    // return marker is about to be harvested and closed, and nothing from it should enter
    // the pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    /** Posts already harvested, by shortcode, oldest first — the replay buffer and the
     *  dedupe in one, since a Map keeps insertion order and evicts from the front. */
    const buffered = new Map<string, NetPost>();
    /** Numeric post id -> shortcode, for the life of the page. See `Walk`. */
    const ids = new Map<string, string>();
    const translationBuffer: NetTranslation[] = [];
    const seenTranslations = new Set<string>();

    /** File this response's posts, and answer with the ones worth forwarding.
     *
     *  A post already buffered is normally not forwarded again — but a later sighting can
     *  name what the first could not, because a reply's parent is stated only by the thread
     *  connection that carries it and that connection can arrive afterwards. Those are sent
     *  on; the adapter ignores a record it has already announced, and one it has not still
     *  picks the better answer up. */
    function remember(records: NetPost[]): NetPost[] {
      const forward: NetPost[] = [];
      for (const record of records) {
        const known = buffered.get(record.code);
        if (!known) {
          buffered.set(record.code, record);
          forward.push(record);
          continue;
        }
        const improved = (!!record.parent && !known.parent) || (!!record.quoted && !known.quoted);
        if (record.parent && !known.parent) known.parent = record.parent;
        if (record.quoted && !known.quoted) known.quoted = record.quoted;
        if (improved) forward.push(known);
      }
      while (buffered.size > BUFFER_LIMIT) {
        const oldest = buffered.keys().next().value;
        if (oldest === undefined) break;
        buffered.delete(oldest);
      }
      return forward;
    }

    function rememberTranslations(records: NetTranslation[]): void {
      for (const record of records) {
        if (seenTranslations.has(record.id)) continue;
        seenTranslations.add(record.id);
        translationBuffer.push(record);
      }
      while (translationBuffer.length > TRANSLATION_BUFFER_LIMIT) {
        const dropped = translationBuffer.shift();
        if (dropped) seenTranslations.delete(dropped.id);
      }
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const walk: Walk = { out: [], index: new Map(), ids };
      collectPosts(parsed, walk, 0);
      if (walk.out.length > 0) {
        console.log(`[misinfo] threads: ${walk.out.length} post(s) from ${label}`);
        const forward = remember(walk.out);
        if (forward.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: forward }, '*');
      }
      // Looked for in every response, not only the one the operation is named after: the
      // posts above come from whichever query the app happened to run, and nothing here
      // should have to know which query a translation arrives on.
      const translations: NetTranslation[] = [];
      collectTranslations(parsed, translations, new Set<string>(), 0);
      if (translations.length > 0) {
        console.log(`[misinfo] threads: ${translations.length} translation(s) from ${label}`);
        rememberTranslations(translations);
        window.postMessage({ type: TRANSLATION_MESSAGE, records: translations }, '*');
      }
    }

    function labelOf(url: string): string {
      return url.match(/\/(api\/graphql|graphql\/query)/)?.[1] ?? 'graphql';
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

    /** Relay's hydration payloads, read as they are inserted.
     *
     *  A content script at document_start runs before any of this exists, so the elements
     *  are watched rather than looked for once: the app inserts each blob during hydration
     *  and while navigating, and every one of them is an ordinary `script` whose text is
     *  JSON. A WeakSet keeps a blob from being parsed twice, and nothing is written back to
     *  the page. */
    const readScripts = new WeakSet<Element>();

    function readScript(element: Element): void {
      if (readScripts.has(element)) return;
      readScripts.add(element);
      if (element.tagName !== 'SCRIPT') return;
      if ((element as HTMLScriptElement).type !== 'application/json') return;
      const text = element.textContent;
      if (text && text.includes(HYDRATION_MARKER)) harvest(text, 'hydration');
    }

    /** Read every hydration blob at or under `root`. The SUBTREE matters: the app streams
     *  its data in chunks, so a blob usually arrives inside an element that was inserted
     *  rather than as an inserted script of its own, and a walk that only looked at the
     *  added node itself found the one blob the app happened to append directly and missed
     *  the rest (measured: one post read where the page was rendering four). */
    function readScriptsIn(root: ParentNode): void {
      for (const script of Array.from(root.querySelectorAll('script[type="application/json"]'))) {
        readScript(script);
      }
    }

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const element = node as Element;
          if (element.tagName === 'SCRIPT') readScript(element);
          else if (element.childElementCount > 0) readScriptsIn(element);
        }
      }
    }).observe(document, { childList: true, subtree: true });

    // …and once more when the document is done, for a blob that was already there when the
    // observer attached.
    window.addEventListener('load', () => readScriptsIn(document));

    // The isolated half may not have been listening when the first responses landed.
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== HELLO_MESSAGE) return;
      const known = Array.from(buffered.values());
      if (known.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: known }, '*');
      if (translationBuffer.length > 0) {
        window.postMessage({ type: TRANSLATION_MESSAGE, records: translationBuffer }, '*');
      }
    });
  },
});
