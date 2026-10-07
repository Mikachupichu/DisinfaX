/** Truth Social post capture, MAIN-world half.
 *
 *  Truth Social's web client is a Soapbox/Mastodon fork, so every post it shows came out
 *  of a `/api/v1/…` JSON response first. That payload carries three things the rendered
 *  markup does not: the post's own language (`language`), the id of the post it answers
 *  (`in_reply_to_id`), and its body as authored (`content`, where the DOM shows the
 *  renderer's own nested markup). It also arrives BEFORE the post is laid out, which is
 *  the difference between buttons that are already there when a feed paints and buttons
 *  that appear a beat later.
 *
 *  This runs in the MAIN world for the same reason X's and Bluesky's interceptors do: the
 *  page's own `fetch` and `XMLHttpRequest` are different objects from the ones a content
 *  script sees in its isolated world, so patching from there would observe nothing.
 *
 *  What it does is deliberately mechanical: find status-shaped records, copy the handful
 *  of fields the adapter decides on, and forward. Every judgement — id namespacing, how a
 *  verification flag becomes a badge, which chain a reply belongs to — is made in the
 *  adapter, so this file needs no knowledge of the extension's data model.
 */
const NETWORK_MESSAGE = 'MF_NETWORK_POSTS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';

/** Every post-bearing response on this site is served from `/api/v<n>/…` under the app's
 *  own origin — the version segment is what the app is on today (v1 for timelines and
 *  statuses, v2 for feeds, v6 for ads), so the marker is the `/api/v` prefix rather than
 *  any one version. Matching the path instead of an endpoint name is what makes this
 *  survive a renamed or brand-new endpoint: the extraction below reads the response's
 *  SHAPE, so an endpoint nobody has listed yet still yields its posts. */
const API_MARKER = '/api/v';

/** Bounds on untrusted input. A response is page-controlled data, so the walk is bounded
 *  in depth and in what it will emit, and the replay buffer is capped. */
const MAX_DEPTH = 12;
const MAX_RECORDS_PER_RESPONSE = 200;
const BUFFER_LIMIT = 600;

/** The fields of a status this extension can use, copied verbatim. */
interface NetStatus {
  id: string;
  content: string;
  language: string | null;
  inReplyToId: string | null;
  createdAt: string | null;
  account: NetAccount;
  /** The retruth wrapper this record was unwrapped out of, when it was. See
   *  `compactStatus` — without it the card on screen cannot be found from the original. */
  /** Whether the platform itself marked this post as an advertisement. A boolean on every
   *  status, so it is the one ad marker on this platform — and, unlike the DOM's, it is not
   *  a translated label. */
  sponsored: boolean;
  wrapperId: string | null;
  /** The post this one quotes, when it quotes one, in full. A quote is a post of its own and
   *  keeps its own id; this travels because a share whose own body renders as nothing (the
   *  platform's `RT: <url>` marker is stripped by the renderer) shows the QUOTED post and
   *  nothing else, and the quoted post's id is nowhere in the markup.
   *
   *  The body travels with the id because a quote is part of the quoting post's own hash and
   *  of the context it is classified in, and the walk below deliberately does not descend
   *  into `quote`: a quoted post that the response also carries standalone arrives under its
   *  own record, and emitting it twice would put one post's text under two ids. */
  quoted: NetQuoted | null;
}

/** The quoted post, as much of it as the quoting post's hash and context need. */
interface NetQuoted {
  id: string;
  content: string;
  language: string | null;
  account: NetAccount;
}

interface NetAccount {
  acct: string;
  displayName: string | null;
  verified: boolean;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

/** Whether an object is a status, narrowed to the fields the adapter reads.
 *
 *  The id test is what makes this shape-driven rather than endpoint-driven: Truth Social
 *  ids are snowflake-style digit strings, and requiring that excludes the id-less objects
 *  every other response is full of (accounts, groups, ads, carousels) without naming a
 *  single endpoint. `content` with `account` then excludes an account, a group, and a
 *  media attachment, none of which have all three. */
function isStatus(value: unknown): value is Record<string, any> {
  return isRecord(value)
    && typeof value.id === 'string' && /^\d{6,}$/.test(value.id)
    && typeof value.content === 'string' && value.content.length > 0
    && isRecord(value.account);
}

/** Narrow a status to the fields the adapter reads, reading THROUGH a retruth.
 *
 *  A retruth arrives as a wrapper whose `reblog` is the post actually shown. A retruth is
 *  not a post of its own, so the wrapper's fields are NOT what the extension wants: the
 *  record carries the ORIGINAL's id, body, language and author. Unwrapping here — rather
 *  than letting the walk emit both the wrapper and the original — is what keeps one
 *  visible post from arriving under two ids. The background's classification cache is
 *  keyed by id while what it stores is keyed by the text, so two ids over one text is a
 *  shape this pipeline has been bitten by before.
 *
 *  The wrapper's id still has to travel, as `wrapperId`. A card on screen is one DOM element
 *  with one permalink, and on a share that permalink is the sharer's line: the embedded
 *  post's id is nowhere in the markup, not even on its own timestamp, which is not inside an
 *  anchor. So the embedded post's id alone cannot locate the card the buttons go on, and the
 *  adapter is what pairs the two — only to find the card, never to change which post it is.
 *
 *  `quoted` travels for the same reason and is a different relationship: a quote is a post
 *  of its own, so its record stays its own, and the quoted post's id is what lets the adapter
 *  recognise the share whose own body renders as nothing. */
function compactStatus(value: any): NetStatus | null {
  const reblog = isStatus(value.reblog) ? value.reblog : null;
  const status = reblog ?? value;
  if (!isStatus(status)) return null;
  const account = status.account;
  const acct = typeof account.acct === 'string' && account.acct.length > 0
    ? account.acct
    : (typeof account.username === 'string' && account.username.length > 0 ? account.username : null);
  if (!acct) return null;
  return {
    id: status.id,
    content: status.content,
    language: typeof status.language === 'string' && status.language.length > 0 ? status.language : null,
    inReplyToId: typeof status.in_reply_to_id === 'string' ? status.in_reply_to_id : null,
    createdAt: typeof status.created_at === 'string' ? status.created_at : null,
    account: {
      acct,
      displayName: typeof account.display_name === 'string' ? account.display_name : null,
      verified: account.verified === true,
    },
    wrapperId: reblog ? value.id : null,
    sponsored: status.sponsored === true,
    quoted: compactQuoted(status.quote),
  };
}

/** The quoted post of a quoting status, or null when the status quotes nothing.
 *
 *  Read one level deep and no further: a quote of a quote is the quoted post's own business,
 *  and the extension only ever carries one `quoting` beside a post. */
function compactQuoted(value: unknown): NetQuoted | null {
  if (!isStatus(value)) return null;
  const account = value.account;
  const acct = typeof account.acct === 'string' && account.acct.length > 0
    ? account.acct
    : (typeof account.username === 'string' && account.username.length > 0 ? account.username : null);
  if (!acct) return null;
  return {
    id: value.id,
    content: value.content,
    language: typeof value.language === 'string' && value.language.length > 0 ? value.language : null,
    account: {
      acct,
      displayName: typeof account.display_name === 'string' ? account.display_name : null,
      verified: account.verified === true,
    },
  };
}

/** Walk a parsed response for statuses. Shape-driven, so it does not care whether the
 *  posts hang off a bare array, `statuses`, `feeds`, `items` or something newer. */
function collectStatuses(value: unknown, out: NetStatus[], seen: Set<string>, depth: number): void {
  if (out.length >= MAX_RECORDS_PER_RESPONSE || depth > MAX_DEPTH || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStatuses(item, out, seen, depth + 1);
    return;
  }
  // A retruth arrives as an envelope whose `reblog` is the post actually shown, and the
  // envelope is NOT itself a status: its own body is empty, so `isStatus` refuses it and the
  // walk would otherwise descend and reach the reblog directly — losing the envelope's id,
  // which is the only name the card on screen has. Recognising the envelope by its `reblog`
  // is what lets `compactStatus` read through it and carry that id as `wrapperId`.
  if (isStatus((value as any).reblog)) {
    const boosted = compactStatus(value);
    if (boosted && !seen.has(boosted.id)) {
      seen.add(boosted.id);
      out.push(boosted);
    }
    // Nothing past it: the reblog is reached here, and descending would emit it twice.
    return;
  }
  if (isStatus(value)) {
    const compact = compactStatus(value);
    if (compact && !seen.has(compact.id)) {
      seen.add(compact.id);
      out.push(compact);
    }
    // Deliberately no descent past a status. Its `quote`, its `reblog` and its
    // `in_reply_to` are other posts, each reached by its own record in the same feed or
    // thread response — descending here would forward the same text under a second id,
    // which is exactly what the unwrap above exists to prevent.
    return;
  }
  for (const key of Object.keys(value)) {
    if (isRecord((value as any)[key])) collectStatuses((value as any)[key], out, seen, depth + 1);
  }
}

export default defineContentScript({
  // Both names Truth Social serves the app from. The `www.` form is the canonical one and
  // the apex redirects to it, but a redirect is not a guarantee the apex was never used.
  matches: ['*://truthsocial.com/*', '*://www.truthsocial.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a
    // disinfax_ return marker is about to be harvested and closed, and nothing from it
    // should enter the pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    const buffer: NetStatus[] = [];
    const seenInBuffer = new Set<string>();

    function remember(records: NetStatus[]): void {
      for (const record of records) {
        if (seenInBuffer.has(record.id)) {
          // The same post can arrive twice — standalone, and as the body of a retruth. Only
          // the record that knows about the envelope can name the card showing it, so it
          // replaces an earlier one that did not.
          if (record.wrapperId) {
            const at = buffer.findIndex((r) => r.id === record.id);
            if (at >= 0 && !buffer[at].wrapperId) buffer[at] = record;
          }
          continue;
        }
        seenInBuffer.add(record.id);
        buffer.push(record);
      }
      while (buffer.length > BUFFER_LIMIT) {
        const dropped = buffer.shift();
        if (dropped) seenInBuffer.delete(dropped.id);
      }
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const records: NetStatus[] = [];
      collectStatuses(parsed, records, new Set<string>(), 0);
      if (records.length === 0) return;
      console.log(`[misinfo] truthsocial: ${records.length} status(es) from ${label}`);
      remember(records);
      window.postMessage({ type: NETWORK_MESSAGE, records }, '*');
    }

    function labelOf(url: string): string {
      const match = url.match(/\/api\/v\d+\/([^/?]+)/);
      return match?.[1] ?? url;
    }

    /** The URL of a fetch call, whichever of the three legal input shapes carries it.
     *  A `URL` has no `.url` property, so reading that property (the obvious spelling)
     *  silently matches nothing — the mistake Bluesky's interceptor records making. */
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
