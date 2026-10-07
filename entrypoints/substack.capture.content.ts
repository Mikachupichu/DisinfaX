/** Substack note capture, MAIN-world half.
 *
 *  Substack's reader is a React app fed by its own `/api/v1/` JSON, and the payload says
 *  three things about a note that the rendered page cannot: the note's own words while the
 *  reader is being shown a TRANSLATION of them, the language those words are in, and the
 *  language the reader is reading them in. The first is the one that matters most — the
 *  reader has auto-translation on for every foreign note it shows, so a translation is the
 *  ordinary state of a note here rather than a state the reader had to ask for, and the
 *  page holds one side of it at a time. Measured on
 *  `substack.com/@ivoddimov/note/c-348491187`: the page `<title>` and the rendered body both
 *  carry the English translation and the Bulgarian source is in no text node, no attribute
 *  and no page store.
 *
 *  Read from the response rather than by fetching it back later, and for the reason every
 *  platform's payload is preferred: it is already on the wire. The reader's own request for
 *  a feed, a note permalink or a comment thread answers with the note's `body` beside its
 *  `translation`, so nothing extra is asked of the host and the facts are in hand before the
 *  markup that renders them exists.
 *
 *  Two more things the payload is the only copy of, both found live rather than assumed:
 *  the WHOLE of a long note (the feed clips one behind a `See more` anchor — see
 *  `renderedText`), and the chain of notes ABOVE the one a page is about (a note permalink
 *  renders none of them — see `NetNote.ancestor`).
 *
 *  A third source feeds the same walk: the document's OWN state, the `JSON.parse("…")` blob
 *  Substack ships in an inline script to hydrate from. It carries the same envelope the API
 *  returns (`feedItem.comment` beside `feedItem.parentComments`), and it exists for the one
 *  reason the fetch does not always win: a note permalink renders its focal note from that
 *  blob, so on a slow response the note is on screen — and captured — before its own
 *  `ancestor_path` has been read off the wire. Filing it then hashes it without the chain it
 *  is classified in, and a post's parent is not something that can be amended afterwards: the
 *  chain is part of the hash the reader's row was billed on (see `absorbNetworkRecords`).
 *  Reading the blob the page rendered FROM is what closes that race rather than narrowing it
 *  — the state is in the document before the markup it hydrates is, and this walk sees it
 *  through the same `harvest` path, so there is one parser and one idea of what a note is.
 *
 *  It runs in the MAIN world for the same reason X's, Bluesky's, Threads' and Truth Social's
 *  interceptors do: the page's own `fetch` and `XMLHttpRequest` are different objects from
 *  the ones an isolated content script sees, so patching from there would observe nothing.
 *  Everything below is deliberately mechanical — find note-shaped records, copy the fields
 *  the adapter decides on, forward — so that every judgement (id namespacing, whether a
 *  payload is a capture or a statement about a post) stays in the adapter. Rebuilding the
 *  rendered text is mechanical in that sense and not a judgement: it is a transcription of
 *  what Substack's own renderer does with the document above it, verified against the page.
 */
const NETWORK_MESSAGE = 'MF_NETWORK_POSTS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Every note-bearing response goes through the app's own API, whatever surface asked for
 *  it: the reader's feed (`/api/v1/reader/feed`), a note permalink's focal note and its
 *  replies (`/api/v1/reader/comment/<id>`, `.../replies`), and a publication's comments.
 *  Matched by path rather than by endpoint name, because the extraction below reads the
 *  response's SHAPE — a surface nobody has listed yet still yields its notes. */
const API_MARKER = '/api/v1/';

/** Bounds on untrusted input. A response is page-controlled data, so the walk is bounded in
 *  depth and in what it will emit, and the replay buffer is capped. */
const MAX_DEPTH = 12;
const MAX_RECORDS_PER_RESPONSE = 200;
const BUFFER_LIMIT = 600;

/** The fields of a note this extension can use, copied verbatim. `plain` is the authored
 *  body, newlines and all, and `rendered` is what the reader puts on the page — the
 *  difference between them is not cosmetic, and `renderedText` below is the whole of it. */
interface NetNote {
  /** Substack's own key for the entity, `c-<id>` — built from the record's own id because
   *  the key it would be copied from is not on the record. */
  key: string;
  /** The note's text as the reader renders it, or null when this cannot state that exactly.
   *  Null is a refusal, not a failure: the adapter falls back to the page's own reading,
   *  which is right whenever the page is showing the whole note. */
  rendered: string | null;
  /** The authored body with the renderer's paragraph joins removed — the same string as
   *  `rendered` for every note carrying neither a link nor a mention (measured), and the
   *  only text there is for a note that is never rendered at all. */
  plain: string;
  language: string | null;
  /** The language the reader is reading this note in, when the app is translating it. */
  autotranslateTo: string | null;
  /** The note this one directly answers, as a bare numeric id, or null for a top-level one.
   *  Read off the tail of `ancestor_path`, which is the chain of ids from the root note down
   *  to this note's own parent, dot-separated. */
  parent: string | null;
  /** The author's display name, as the payload states it. */
  name: string;
  /** True for a note reached through `parentComments` — an ancestor of the note this
   *  response is about.
   *
   *  This is the one thing about a note that its own fields cannot say, and the reason it is
   *  carried: a note permalink renders its focal note and its replies and NOTHING above them
   *  (measured 2026-10-01 on `substack.com/@gurdeep212/note/c-349973906`: the response
   *  described three notes, the page rendered one). The adapter files what the page renders,
   *  so an ancestor with no element would never be captured at all — and since a post's hash
   *  covers its whole ancestor chain, the focal note would be hashed without the context it
   *  is classified in. Marked here because the payload's own shape is what says so: these are
   *  the notes hanging off `parentComments`, and the walk that finds them is what knows. */
  ancestor: boolean;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

/** Whether an object is a note, narrowed to the fields the adapter reads.
 *
 *  The test is shape-driven, not endpoint-driven: a note is an object whose `id` is the
 *  number its key, its anchor and its permalink are all built from, whose `body` is the
 *  authored text, and whose `name` is its author's display name. Measured on
 *  `/api/v1/reader/comment/<id>`: exactly one object in the response carries a body and a
 *  name — the note — and nothing else does, which is what makes the pair a test rather than
 *  a guess about Substack's schema. `body` empty is refused here rather than one step later:
 *  an image-only note has nothing to fact-check.
 *
 *  The key is CONSTRUCTED rather than copied. `entity_key` — `c-348491187` for the note whose
 *  `id` is `348491187` — sits on the envelope that wraps a note (`items[].entity_key`,
 *  `item.entity_key`), not on the note itself, and one envelope can carry a note AND a post
 *  (`items[].comment` beside `items[].post`), so the key above a record does not necessarily
 *  name that record. The id does, and it is the same number: `c-` + id is the key Substack
 *  itself derives. */
function isNote(value: unknown): value is Record<string, any> {
  return isRecord(value)
    && typeof value.id === 'number' && Number.isInteger(value.id) && value.id > 0
    && typeof value.body === 'string' && value.body.trim().length > 0
    && typeof value.name === 'string' && value.name.trim().length > 0;
}

/** One ProseMirror node as the text the reader puts on the page, appended to `out`.
 *
 *  Returns false for a node type this does not know, which is what makes `renderedText`
 *  all-or-nothing: a paragraph this mis-renders is worse than none, because the string
 *  would then be neither the payload's text nor the page's, and the adapter would file a
 *  post under a hash no surface agrees with. */
function renderNode(node: unknown, out: string[]): boolean {
  if (!isRecord(node)) return false;
  const type = node.type;
  if (type === 'text') {
    let text = typeof node.text === 'string' ? node.text : '';
    // The renderer prints a link as its target with the scheme stripped, and the AUTHORED
    // text carries the whole URL. Measured on `c-343671380`, a note with fifty links: the
    // payload's text minus `https://` on every link-marked run, minus the `@` a mention
    // keeps and the renderer drops, is the page's `textContent` character for character.
    const marks = Array.isArray(node.marks) ? node.marks : [];
    for (const mark of marks) {
      if (isRecord(mark) && mark.type === 'link') text = text.replace(/^https?:\/\//, '');
    }
    out.push(text);
    return true;
  }
  if (type === 'substack_mention') {
    // The renderer drops the `@` the payload keeps, and prints the label alone.
    const label = isRecord(node.attrs) && typeof node.attrs.label === 'string' ? node.attrs.label : '';
    out.push(label);
    return true;
  }
  if (type === 'doc' || type === 'paragraph') {
    // Blocks are joined with NOTHING between them: the renderer makes one element per
    // paragraph and no whitespace, so a paragraph break is a boundary the page's text does
    // not carry at all.
    const content = Array.isArray(node.content) ? node.content : [];
    for (const child of content) if (!renderNode(child, out)) return false;
    return true;
  }
  return false;
}

/** The note's text as the reader renders it, or null when this cannot state it exactly.
 *
 *  This exists because the reader's feed CLIPS a long note: past roughly 250 characters the
 *  card shows a prefix and a `See more` link, and the link is an anchor to the note's own
 *  permalink rather than an expander, so there is no in-place way to see the rest. Measured
 *  on `c-345653183`: the feed card's body element read 348 characters (the note's first 340
 *  plus the eight of `See more`, which sits INSIDE the element this extension files), the
 *  same note's permalink read 1631, and the payload's `body` minus the renderer's own two
 *  normalisations read 1631 as well. Filing the card's reading would hash a post on a prefix
 *  of itself plus a piece of Substack's UI, and would hash one note two ways depending on
 *  which surface the reader happened to be on.
 *
 *  Verified exact against the page, not assumed: rebuilt text === the body element's
 *  `textContent` on both long notes measured (`c-345653183`, 1631 chars, 12 links, 1 mention;
 *  `c-343671380`, 2388 chars, 50 links) and on every unclipped feed card measured (nine of
 *  nine). */
function renderedText(doc: unknown): string | null {
  if (!isRecord(doc) || doc.type !== 'doc') return null;
  const out: string[] = [];
  return renderNode(doc, out) ? out.join('') : null;
}

/** The id of the note a note directly answers, or null for a top-level one.
 *
 *  `ancestor_path` is the whole chain from the root down, dot-separated and in order, so the
 *  parent is its last element — `"349963969.349966257"` is a note answering `349966257`,
 *  which itself answers `349963969`. Measured on `/api/v1/reader/comment/349973906`, whose
 *  `parentComments` then carried both ancestors in full. */
function parentIdFromPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const ids = path.split('.').filter((part) => /^\d+$/.test(part));
  return ids.length > 0 ? ids[ids.length - 1] : null;
}

function compactNote(value: Record<string, any>, ancestor: boolean): NetNote | null {
  if (!isNote(value)) return null;
  return {
    key: `c-${value.id}`,
    rendered: renderedText(value.body_json),
    plain: value.body.replace(/\n+/g, '').trim(),
    // Absent, null and empty all mean the same thing here — the platform is not stating a
    // language — so they collapse to null rather than to a string that names nothing.
    language: typeof value.language === 'string' && value.language.trim() ? value.language.trim().toLowerCase() : null,
    autotranslateTo: typeof value.autotranslate_to === 'string' && value.autotranslate_to.trim()
      ? value.autotranslate_to.trim().toLowerCase()
      : null,
    parent: parentIdFromPath(value.ancestor_path),
    name: value.name.trim(),
    ancestor,
  };
}

/** Walk a parsed response for notes. Shape-driven, so it does not care whether they hang off
 *  `items[].comment`, `item.comment`, `parentComments` or something newer — with the one
 *  exception of `ancestor`, which is read off the key a note was reached through, because
 *  that is the only thing in the response that says whether the page renders it. */
function collectNotes(value: unknown, out: NetNote[], seen: Map<string, NetNote>, depth: number, ancestor: boolean): void {
  if (out.length >= MAX_RECORDS_PER_RESPONSE || depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectNotes(item, out, seen, depth + 1, ancestor);
    return;
  }
  if (isNote(value)) {
    const compact = compactNote(value, ancestor);
    if (!compact) return;
    const known = seen.get(compact.key);
    // Sticky: a note the walk met as an ancestor stays one wherever else it turns up in the
    // same response. The reverse cannot happen — the note a response is ABOUT is not also in
    // the chain above itself — so this only ever upgrades.
    if (!known) {
      seen.set(compact.key, compact);
      out.push(compact);
    } else if (ancestor && !known.ancestor) {
      known.ancestor = true;
    }
    // Deliberately no descent past a note. A note's own children (its reactions, its
    // attachments, its media) hold no other note, and a reply is reached through the
    // `parentComments`/`items` branch that carries it in its own right.
    return;
  }
  for (const key of Object.keys(value)) {
    if (isRecord((value as any)[key])) {
      collectNotes((value as any)[key], out, seen, depth + 1, ancestor || key === 'parentComments');
    }
  }
}

/** The JSON text an inline `<script>` carries, or null when it carries none.
 *
 *  Two shapes are accepted and no more: the text is JSON already, or it is the
 *  `JSON.parse("…")` assignment Substack actually ships — read by taking the string literal
 *  apart and parsing it back into the text it holds, because the JSON inside it is escaped
 *  and parsing the script's own source as JSON would read the escaping instead of the data.
 *  A last resort slices between the outermost braces, which is what a bundler-wrapped or
 *  suffixed variant would need and costs nothing to try. */
function scriptJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const literal = trimmed.match(/JSON\.parse\(\s*"((?:[^"\\]|\\.)*)"\s*\)/);
  if (literal) {
    try { return JSON.parse(`"${literal[1]}"`); } catch { /* try the braces instead */ }
  }
  const open = trimmed.indexOf('{');
  const close = trimmed.lastIndexOf('}');
  return open >= 0 && close > open ? trimmed.slice(open, close + 1) : null;
}

export default defineContentScript({
  // Both names, and every publication subdomain: a comment thread under a publication's post
  // is one of the two social surfaces this integration covers, and its notes arrive from the
  // same API.
  matches: ['*://substack.com/*', '*://*.substack.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a disinfax_
    // return marker is about to be harvested and closed, and nothing from it should enter
    // the pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    const buffer: NetNote[] = [];
    const seenInBuffer = new Set<string>();

    function remember(records: NetNote[]): void {
      for (const record of records) {
        if (seenInBuffer.has(record.key)) continue;
        seenInBuffer.add(record.key);
        buffer.push(record);
      }
      while (buffer.length > BUFFER_LIMIT) {
        const dropped = buffer.shift();
        if (dropped) seenInBuffer.delete(dropped.key);
      }
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const records: NetNote[] = [];
      collectNotes(parsed, records, new Map<string, NetNote>(), 0, false);
      if (records.length === 0) return;
      console.log(`[misinfo] substack: ${records.length} note(s) from ${label}`);
      remember(records);
      window.postMessage({ type: NETWORK_MESSAGE, records }, '*');
    }

    function labelOf(url: string): string {
      return url.match(/\/api\/v1\/[^?#]*/)?.[0].slice('/api/v1/'.length) || 'api/v1';
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

    /** Notes the page was hydrated from, read out of the document's own inline state.
     *
     *  Every script is looked at once and only scripts mentioning a note document are parsed,
     *  so a page's other hundred scripts cost a substring search each and nothing else. A
     *  script is examined as soon as it is inserted rather than after the document settles,
     *  because the whole point is to know a note's parent BEFORE the markup hydrated from
     *  that state is rendered and captured. */
    const seenScripts = new WeakSet<Element>();
    function scanScript(el: Element): void {
      if (seenScripts.has(el)) return;
      seenScripts.add(el);
      const text = el.textContent || '';
      if (!text.includes('body_json')) return;
      const json = scriptJson(text);
      if (json) harvest(json, 'document');
    }
    function scanScripts(root: ParentNode): void {
      for (const el of Array.from(root.querySelectorAll('script'))) scanScript(el);
    }

    scanScripts(document);
    document.addEventListener('DOMContentLoaded', () => scanScripts(document), { once: true });
    // Subtree-wide, because the state script sits wherever the host's router put it, and only
    // the added nodes are inspected — the alternative, re-scanning the whole document on every
    // mutation, is what a page this busy cannot afford.
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          if (el.tagName === 'SCRIPT') scanScript(el);
          else scanScripts(el);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

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
      if (buffer.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: buffer }, '*');
    });
  },
});
