/**
 * What Facebook's own GraphQL knows that its markup does not, forwarded to the isolated half.
 *  The first is what its translation control hands over.
 *
 *  Facebook shows a post in one language at a time. A post whose author wrote in another
 *  language renders its own words with a `See translation` link under them, and clicking that
 *  link REPLACES the body in place — measured on a Spanish post, the visible words went from
 *  "Wall Street mira ahora al empleo y la inflación…" to "Wall Street is now watching employment
 *  and inflation…" and the link's own label became `Hide Translation`. The post's own words are
 *  then nowhere on the page: the body is the only copy the DOM holds.
 *
 *  The translation itself arrives as a single small GraphQL response, `POST /api/graphql/`,
 *  whose `data.node` is the Story with `{ id, translation: { message: { text, ranges } } }`.
 *  Three properties of that response shape this file:
 *
 *    - `translation.message.text` is the WHOLE translated body, newlines and hashtags included,
 *      with `ranges` giving the entity offsets into it.
 *    - The response carries NO source text — `node`'s keys are `__typename`,
 *      `message_truncation_line_limit`, `is_text_only_story`, `translation`, `id`. So this is
 *      read as one side of a flip, not as a post: nothing here is classified.
 *    - It names the post only by Facebook's opaque base64 story id, and that id appears nowhere
 *      in the DOM (checked against both numeric ids the id encodes — the story id and the
 *      author's). So the translation cannot be joined to a post by id; the adapter matches it
 *      against the body on screen, the way `threads.ts` does.
 *
 *  The same hook carries two more things this half exists for. The first is the comment each
 *  comment answers: a comment node states it as `comment_direct_parent` — `null` for a
 *  top-level comment, and otherwise an `id` that decodes to `comment:<post id>_<parent comment
 *  id>`. The rendered row states the same edge in its own timestamp link and gets it WRONG
 *  beyond one level, and the page's server-rendered blob holds only top-level comments, so
 *  this response is the only place a sub-reply's true parent can be read at all (see
 *  `EDGE_MARKER`). Edges travel under their own message and are remembered rather than
 *  classified: an edge has no text.
 *
 *  The second is which story a post root stands for. A payload states a story's own `post_id`,
 *  and the values it uses for that story elsewhere — the `pfbid…` in its permalink, the ids of
 *  the photos it attaches — while the rendered markup states only those aliases, never the
 *  story's id (see `postIds` below, and `facebookPostIds.ts`). Read here because the feed
 *  renders its first screen from the page's server-rendered blobs and every later one from
 *  these responses.
 *
 *  The third is what each comment SAYS. A comment states its own words at `body.text`, where a
 *  story states its own at `message.text`, under the `legacy_fbid` its permalink spells as
 *  `comment_id` — and a comment the page truncated is completed from them, the way a truncated
 *  post is completed from the story's `message`. A post page's first comments arrive with its
 *  server-rendered blob, which the isolated half reads itself; every later batch — an expanded
 *  thread, an older page of replies — arrives here and nowhere else, which is why this harvest
 *  exists alongside that reading rather than instead of it.
 *
 *  MAIN world, because the app's own `fetch` and `XMLHttpRequest` are what carry the response.
 */
const TRANSLATION_MESSAGE = 'MF_NETWORK_TRANSLATIONS';
const THREAD_EDGE_MESSAGE = 'MF_NETWORK_THREAD_EDGES';
const POST_ID_MESSAGE = 'MF_NETWORK_POST_IDS';
const COMMENT_TEXT_MESSAGE = 'MF_NETWORK_COMMENT_TEXTS';
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';
const API_MARKER = '/api/graphql/';

/** A response this large is the feed, not a translation; the payloads worth parsing are small
 *  (measured under 10 KB). Checked before `JSON.parse` so a multi-megabyte feed response costs
 *  one substring search rather than a parse. */
const TRANSLATION_MARKER = '"translation"';

/** The field that names a comment's parent, and the gate for the second harvest this file
 *  does. A comment node carries its own `legacy_fbid`, a `depth`, and `comment_direct_parent`
 *  — `null` for a top-level comment, and for a reply an `id` that base64-decodes to
 *  `comment:<the post's numeric id>_<the comment it answers>`.
 *
 *  This is the ONLY source beyond one level: the rendered row states the same edge in its own
 *  timestamp link, but at depth ≥2 that link names the thread's root instead of the comment
 *  being answered (measured 0 of 32, against 120 of 120 at depth 1). Every ancestor is part
 *  of a post's hash, so the markup's reading there is a wrong chain rather than a coarser one.
 *
 *  The page's server-rendered blob uses the same field name and carries only top-level
 *  comments (measured: 6 comments, all `depth` 0, none with a parent), so one walker over both
 *  shapes costs nothing and the blob is not scanned separately. */
const EDGE_MARKER = '"comment_direct_parent"';

/** The field every story node states, and the gate for the third harvest. A story's own id is
 *  stated as `post_id`, and the aliases the markup carries resolve to it (see `postIds`).
 *
 *  Both of the page's payload paths carry it: the app's `/api/graphql/` responses and the
 *  server-rendered `script[type="application/json"]` blobs. The blobs are read by the isolated
 *  half instead, which can see them without a hook — the two halves of this file's job split
 *  by which half can see the payload. */
const POST_ID_MARKER = '"post_id"';

/** The field that carries a comment's own words, and the gate for the fourth harvest. A comment
 *  states them at `body.text` where a story states its own at `message.text`, under a
 *  `legacy_fbid` that is the same decimal the comment's own permalink spells in `comment_id` —
 *  so a comment the page truncated can be completed from here (`wholeCommentText`).
 *
 *  A thread's comments arrive BOTH ways, which is why this is a harvest of its own rather than
 *  part of the blob reading the isolated half does: a post page's first comments come with the
 *  server-rendered blob, and every later batch — an expanded thread, an older page of replies —
 *  comes over these responses, where the isolated half cannot see them. */
const COMMENT_TEXT_MARKER = '"legacy_fbid"';

/** How deep to walk a response looking for a translation, and how much of one to keep.
 *
 *  `TranslationState`-style payloads nest a Story a few levels down; 12 is generous for that and
 *  stops a cyclic or unexpectedly deep body from being walked forever. The floor exists so a
 *  stray short string cannot be remembered as a whole post's translation. */
const MAX_DEPTH = 12;
const MIN_TRANSLATION_LENGTH = 16;
const BUFFER_LIMIT = 64;

/** Thread edges kept before the oldest are dropped. Larger than the translation limit because
 *  an edge is two ids rather than a post's worth of text, and one expanded thread covers
 *  hundreds of them (measured 152 comments on a single 7.4K-comment post). */
const EDGE_BUFFER_LIMIT = 1024;

/** Post ids kept before the oldest are dropped. A story is one id and a handful of aliases, so
 *  this covers a long feed scroll many times over. */
const POST_ID_BUFFER_LIMIT = 1024;

/** Comment texts kept before the oldest are dropped. One expanded thread runs to hundreds of
 *  comments (measured 152 on a single 7.4K-comment post), so this is the edge buffer's size
 *  rather than the translation buffer's. */
const COMMENT_TEXT_BUFFER_LIMIT = 1024;

export interface NetTranslation {
  id: string;
  text: string;
}

/** One comment and the comment it answers, both plain decimal. */
export interface NetThreadEdge {
  id: string;
  parentId: string;
}

/** The comment id inside a base64 `comment:<post id>_<comment id>` reference, or null for
 *  anything else. Both numbers in that decode are decimal — the same space a comment's own id
 *  lives in — so the edge joins the ids the adapter files directly. */
function commentIdIn(raw: string): string | null {
  let decoded: string;
  try {
    decoded = atob(raw);
  } catch {
    return null;
  }
  const match = decoded.match(/^comment:\d+_(\d+)$/);
  return match ? match[1] : null;
}

function collectThreadEdges(value: unknown, out: NetThreadEdge[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectThreadEdges(item, out, seen, depth + 1);
    return;
  }
  const node = value as Record<string, any>;
  const id = node.legacy_fbid;
  const parentRef = node.comment_direct_parent?.id;
  if (typeof id === 'string' && typeof parentRef === 'string') {
    const parentId = commentIdIn(parentRef);
    // A comment answering itself would make the chain builder break a legitimate edge, and a
    // payload is page-authored data: dropped rather than trusted.
    if (parentId && parentId !== id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, parentId });
    }
  }
  for (const key of Object.keys(node)) collectThreadEdges(node[key], out, seen, depth + 1);
}

function collectTranslations(value: unknown, out: NetTranslation[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTranslations(item, out, seen, depth + 1);
    return;
  }
  const node = value as Record<string, any>;
  const message = node.translation?.message;
  const text = typeof message?.text === 'string' ? message.text : '';
  if (text.length >= MIN_TRANSLATION_LENGTH && !seen.has(text)) {
    seen.add(text);
    out.push({ id: typeof node.id === 'string' ? node.id : '', text });
  }
  for (const key of Object.keys(node)) collectTranslations(node[key], out, seen, depth + 1);
}

import { collectCommentTexts, collectPostIds, type NetCommentText, type NetPostId } from '../utils/platforms/facebookPostIds';

export default defineContentScript({
  matches: ['*://*.facebook.com/*', '*://facebook.com/*', '*://web.facebook.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (location.search.includes('disinfax_oauth=callback')) return;

    const buffer: NetTranslation[] = [];
    const seenInBuffer = new Set<string>();
    /** Edges by comment id rather than in a list, because a comment has exactly one parent:
     *  the map IS the dedupe, and a thread re-expanded or re-rendered states the same edges
     *  again. */
    const edgeBuffer = new Map<string, NetThreadEdge>();
    /** Post ids by the story's own id, because a story is stated once per response it appears
     *  in and the map is the dedupe. */
    const postIdBuffer = new Map<string, NetPostId>();
    /** Comment texts by the comment's own id, because a payload re-stating a comment (a
     *  re-expanded thread, a re-render) states the same words again and the map is the dedupe. */
    const commentTextBuffer = new Map<string, NetCommentText>();

    function remember(records: NetTranslation[]): void {
      for (const record of records) {
        if (seenInBuffer.has(record.text)) continue;
        seenInBuffer.add(record.text);
        buffer.push(record);
      }
      while (buffer.length > BUFFER_LIMIT) {
        const dropped = buffer.shift();
        if (dropped) seenInBuffer.delete(dropped.text);
      }
    }

    function rememberEdges(records: NetThreadEdge[]): void {
      for (const record of records) edgeBuffer.set(record.id, record);
      while (edgeBuffer.size > EDGE_BUFFER_LIMIT) {
        const oldest = edgeBuffer.keys().next().value;
        if (oldest === undefined) break;
        edgeBuffer.delete(oldest);
      }
    }

    function rememberPostIds(records: NetPostId[]): void {
      for (const record of records) postIdBuffer.set(record.postId, record);
      while (postIdBuffer.size > POST_ID_BUFFER_LIMIT) {
        const oldest = postIdBuffer.keys().next().value;
        if (oldest === undefined) break;
        postIdBuffer.delete(oldest);
      }
    }

    function rememberCommentTexts(records: NetCommentText[]): void {
      for (const record of records) commentTextBuffer.set(record.commentId, record);
      while (commentTextBuffer.size > COMMENT_TEXT_BUFFER_LIMIT) {
        const oldest = commentTextBuffer.keys().next().value;
        if (oldest === undefined) break;
        commentTextBuffer.delete(oldest);
      }
    }

    function harvest(text: string, label: string): void {
      // Four gates on one response, each a substring search before any parse: a response
      // states the things this half is here for independently of each other, and a feed
      // response carries none of the first two.
      const hasTranslations = text.includes(TRANSLATION_MARKER);
      const hasEdges = text.includes(EDGE_MARKER);
      const hasPostIds = text.includes(POST_ID_MARKER);
      const hasCommentTexts = text.includes(COMMENT_TEXT_MARKER);
      if (!hasTranslations && !hasEdges && !hasPostIds && !hasCommentTexts) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (hasTranslations) {
        const records: NetTranslation[] = [];
        collectTranslations(parsed, records, new Set<string>(), 0);
        if (records.length > 0) {
          console.log(`[misinfo] facebook: ${records.length} translation(s) from ${label}`);
          remember(records);
          window.postMessage({ type: TRANSLATION_MESSAGE, records }, '*');
        }
      }
      if (hasEdges) {
        const records: NetThreadEdge[] = [];
        collectThreadEdges(parsed, records, new Set<string>(), 0);
        if (records.length > 0) {
          console.log(`[misinfo] facebook: ${records.length} thread edge(s) from ${label}`);
          rememberEdges(records);
          window.postMessage({ type: THREAD_EDGE_MESSAGE, records }, '*');
        }
      }
      if (hasPostIds) {
        const records = collectPostIds(parsed);
        if (records.length > 0) {
          console.log(`[misinfo] facebook: ${records.length} post id(s) from ${label}`);
          rememberPostIds(records);
          window.postMessage({ type: POST_ID_MESSAGE, records }, '*');
        }
      }
      if (hasCommentTexts) {
        const records = collectCommentTexts(parsed);
        if (records.length > 0) {
          console.log(`[misinfo] facebook: ${records.length} comment text(s) from ${label}`);
          rememberCommentTexts(records);
          window.postMessage({ type: COMMENT_TEXT_MESSAGE, records }, '*');
        }
      }
    }

    function labelOf(url: string): string {
      return url.includes(API_MARKER) ? 'api/graphql' : 'graphql';
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
      if (edgeBuffer.size > 0) {
        window.postMessage({ type: THREAD_EDGE_MESSAGE, records: [...edgeBuffer.values()] }, '*');
      }
      if (postIdBuffer.size > 0) {
        window.postMessage({ type: POST_ID_MESSAGE, records: [...postIdBuffer.values()] }, '*');
      }
      if (commentTextBuffer.size > 0) {
        window.postMessage({ type: COMMENT_TEXT_MESSAGE, records: [...commentTextBuffer.values()] }, '*');
      }
    });
  },
});
