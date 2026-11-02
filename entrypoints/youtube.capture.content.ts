/** YouTube post capture, MAIN-world half.
 *
 *  Both of YouTube's web readers — the desktop one on `www.` and the mobile one on `m.` — are
 *  clients of YouTube's internal API, `/youtubei/v1/*`. This file reads that traffic.
 *
 *  It is the only place three things exist (measured 2026-10-31 on a live watch page):
 *
 *  - A video's own words. `/youtubei/v1/player` — and, on the mobile reader, the inline
 *    `window.ytInitialPlayerResponse` blob, which is where a mobile page states them at all —
 *    carries `videoDetails.title`, `videoDetails.shortDescription` and the upload date at
 *    `microformat.playerMicroformatRenderer.uploadDate`. The desktop markup shows the
 *    description too, but collapsed: the snippet is a prefix and the rest is withheld. The
 *    mobile markup renders none of it.
 *  - A comment's own words on the mobile reader, which names no comment id anywhere in its
 *    DOM. The payload states both.
 *  - A comment's parent. The thread tree states it where the tree is nested, and the id does
 *    where it is flat: a reply's id is `<threadRootId>.<replyId>`, which is what a reply
 *    continuation response gives (measured: nine replies, zero tree edges, every id dotted).
 *
 *  Two response shapes are handled because both are live. Desktop `/next` answers with
 *  `commentEntityPayload` records (`properties.commentId`, `properties.content.content`,
 *  `properties.publishedTime`, `author.displayName`) held SEPARATELY from a thread tree of
 *  `commentViewModel` nodes, so the two are joined on the id. The mobile reader still gets the
 *  older `commentRenderer` shape, where the words are on the node itself
 *  (`contentText.runs`, `authorText`, `publishedTimeText`).
 *
 *  Nothing here judges anything: it finds records by their shape, copies the handful of fields
 *  the adapter reads, forwards, and dedupes. Every decision — id namespacing, which words are
 *  the source, what a parent means — is the adapter's.
 */
const NETWORK_MESSAGE = 'MF_NETWORK_POSTS';
/** Posted by the isolated half once it is listening. Responses routinely land before the
 *  isolated script runs (both are document_start, and the order between them is not
 *  guaranteed), so everything harvested so far is buffered and replayed on this. */
const HELLO_MESSAGE = 'MF_NETWORK_HELLO';
/** Says a response whose posts have not been forwarded yet is in flight (`open: true`) or has
 *  settled (`open: false`). The isolated half holds its announcements while one is open, so a
 *  comment's payload — which states its parent and its whole text — is filed instead of the
 *  markup's reading of it. The settle is posted AFTER the harvest, in the same task. */
const PENDING_MESSAGE = 'MF_NETWORK_PENDING';

/** The two calls that carry posts. Matched by path rather than by a full URL: the page's own
 *  origin (`www.` or `m.`) and the `youtubei` base both vary, and the extraction below reads
 *  the response's SHAPE so an endpoint nobody listed still yields its records. */
const API_MARKERS = ['/youtubei/v1/player', '/youtubei/v1/next'];

/** Bounds on untrusted input. A response is page-controlled data, so the walk is bounded in
 *  depth and in what it will emit, and the replay buffer is capped.
 *
 *  Depth is measured rather than guessed: a comment's `commentEntityPayload` sits under
 *  `frameworkUpdates.entityBatchUpdate.mutations[].payload`, six levels down, and the thread
 *  tree nests one level per reply. 30 is comfortably past both. */
const MAX_DEPTH = 30;
const MAX_RECORDS_PER_RESPONSE = 400;
const BUFFER_LIMIT = 800;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const COMMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

interface NetVideo {
  kind: 'video';
  videoId: string;
  title: string;
  description: string;
  author: string;
  /** The upload date as the payload states it (an ISO instant, e.g. `2010-04-01`). */
  published: string;
}

interface NetComment {
  kind: 'comment';
  id: string;
  videoId: string;
  text: string;
  author: string;
  published: string;
  /** The comment this one answers, or null when the payload stated no edge (in which case the
   *  adapter reads the id's dotted prefix instead). */
  parent: string | null;
}

type NetRecord = NetVideo | NetComment;

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object';
}

/** The text of a `{runs}` / `{simpleText}` / plain string field.
 *
 *  The mobile reader's older shape answers with `runs`, and some of its fields arrive as a
 *  JSON STRING holding the same object — measured on reply bodies, which is why a string that
 *  parses to a run list is decoded rather than returned raw. */
function runsText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"runs"')) {
      try {
        return runsText(JSON.parse(trimmed));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (!isRecord(value)) return '';
  if (Array.isArray(value.runs)) {
    return value.runs.map((run: any) => (isRecord(run) && typeof run.text === 'string' ? run.text : '')).join('');
  }
  if (typeof value.simpleText === 'string') return value.simpleText;
  return '';
}

/** A comment's words: the new shape states them at `content.content`, the old one at
 *  `contentText`. Both are read here so the walk does not have to know which it is in. */
function contentOf(value: unknown): string {
  if (isRecord(value) && typeof value.content === 'string') return value.content;
  return runsText(value);
}

/** The video the page is showing, read off its URL at harvest time. Every record is filed
 *  with it so the adapter can tell a payload that describes the page on screen from one that
 *  describes a page it has already left. */
function pageVideoId(): string {
  try {
    const value = new URLSearchParams(location.search).get('v');
    return value && VIDEO_ID_RE.test(value) ? value : '';
  } catch {
    return '';
  }
}

/** A video, as `/player` and the page's own initial blob state it. Shape-driven: an object
 *  whose `videoDetails` names a video id IS this record, wherever it sits. */
function videoOf(value: unknown): NetVideo | null {
  if (!isRecord(value) || !isRecord(value.videoDetails)) return null;
  const details = value.videoDetails;
  if (typeof details.videoId !== 'string' || !VIDEO_ID_RE.test(details.videoId)) return null;
  const title = typeof details.title === 'string' ? details.title : '';
  const description = typeof details.shortDescription === 'string' ? details.shortDescription : '';
  if (!title.trim() && !description.trim()) return null;
  const microformat = isRecord(value.microformat) ? value.microformat.playerMicroformatRenderer : null;
  const upload = isRecord(microformat) ? microformat.uploadDate : null;
  const publish = isRecord(microformat) ? microformat.publishDate : null;
  return {
    kind: 'video',
    videoId: details.videoId,
    title,
    description,
    author: typeof details.author === 'string' ? details.author : '',
    published: typeof upload === 'string' ? upload : typeof publish === 'string' ? publish : '',
  };
}

/** One response's comment harvest: what each entity states, and what each thread node states
 *  (with the parent the tree put it under). Joined by id afterwards, because the entity batch
 *  and the tree are structurally separate. */
interface CommentWalk {
  entities: Map<string, { text: string; author: string; published: string }>;
  nodes: Map<string, { text: string; author: string; published: string; parent: string | null }>;
  found: number;
}

function rememberEntity(walk: CommentWalk, entity: Record<string, any>): void {
  const properties = entity.properties;
  const author = entity.author;
  if (!isRecord(properties) || typeof properties.commentId !== 'string') return;
  if (!COMMENT_ID_RE.test(properties.commentId)) return;
  const known = walk.entities.get(properties.commentId);
  const text = contentOf(properties.content);
  if (known && known.text) return;
  if (!known) walk.found++;
  walk.entities.set(properties.commentId, {
    text,
    author: isRecord(author) && typeof author.displayName === 'string' ? author.displayName : '',
    published: typeof properties.publishedTime === 'string' ? properties.publishedTime : '',
  });
}

/** The id a thread node states, plus whatever the node states about itself. */
function commentNodeOf(value: Record<string, any>): { id: string; text: string; author: string; published: string } | null {
  const view = value.commentViewModel;
  if (isRecord(view) && typeof view.commentId === 'string') {
    // The new shape keeps the words in the entity batch, not on the node.
    return { id: view.commentId, text: '', author: '', published: '' };
  }
  const renderer = value.commentRenderer ?? (isRecord(value.comment) ? value.comment.commentRenderer : null);
  if (isRecord(renderer) && typeof renderer.commentId === 'string') {
    return {
      id: renderer.commentId,
      text: contentOf(renderer.contentText),
      author: runsText(renderer.authorText),
      published: runsText(renderer.publishedTimeText),
    };
  }
  return null;
}

function rememberNode(walk: CommentWalk, node: { id: string; text: string; author: string; published: string }, parent: string | null): void {
  if (!COMMENT_ID_RE.test(node.id)) return;
  // A node is never its own parent. The mobile reader's payload nests a comment's renderer
  // inside its thread renderer, and `commentNodeOf` unwraps both, so the same id is visited
  // twice — the second time with the first visit's id as its `parent`. Left as stated, every
  // top-level mobile comment chains to itself instead of to the video.
  if (parent === node.id) parent = null;
  const known = walk.nodes.get(node.id);
  if (!known) {
    walk.nodes.set(node.id, { ...node, parent });
    walk.found++;
    return;
  }
  if (!known.text && node.text) known.text = node.text;
  if (!known.author && node.author) known.author = node.author;
  if (!known.published && node.published) known.published = node.published;
  if (!known.parent && parent) known.parent = parent;
}

/** Walk a parsed response for comment records.
 *
 *  The parent of anything nested under a node is that node, which is what the nested thread
 *  tree means. A response that is FLAT states no edge at all, and the adapter then reads the
 *  id's dotted prefix — the thread root — rather than nothing. */
function collectComments(value: unknown, parent: string | null, depth: number, walk: CommentWalk): void {
  if (depth > MAX_DEPTH || walk.found >= MAX_RECORDS_PER_RESPONSE || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectComments(item, parent, depth + 1, walk);
    return;
  }
  const record = value as Record<string, any>;
  if (isRecord(record.commentEntityPayload)) rememberEntity(walk, record.commentEntityPayload);
  const node = commentNodeOf(record);
  if (node) rememberNode(walk, node, parent);
  const childParent = node ? node.id : parent;
  for (const key of Object.keys(record)) {
    if (isRecord(record[key])) collectComments(record[key], childParent, depth + 1, walk);
  }
}

/** Join the entity batch to the thread tree, by id. */
function buildComments(walk: CommentWalk): NetComment[] {
  const video = pageVideoId();
  const out: NetComment[] = [];
  const ids = new Set<string>([...walk.entities.keys(), ...walk.nodes.keys()]);
  for (const id of ids) {
    const entity = walk.entities.get(id);
    const node = walk.nodes.get(id);
    const text = (entity?.text || node?.text || '').trim();
    // A record whose words no part of the response stated describes a comment the page also
    // renders, and the adapter refuses an empty one anyway.
    if (!text) continue;
    out.push({
      kind: 'comment',
      id,
      videoId: video,
      text,
      author: entity?.author || node?.author || '',
      published: entity?.published || node?.published || '',
      parent: node?.parent ?? null,
    });
  }
  return out;
}

export default defineContentScript({
  // Both readers: the desktop app from the bare apex and its `www.` name, and the mobile one,
  // which is a separate application served in place rather than a redirect target.
  matches: ['*://youtube.com/*', '*://www.youtube.com/*', '*://m.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // Same redirect-landing bail as the other capture scripts: a tab carrying a disinfax_
    // return marker is about to be harvested and closed, and nothing from it belongs in the
    // pipeline.
    if (location.search.includes('disinfax_oauth=callback')) return;

    /** Records already harvested, keyed by their own id, oldest first — the replay buffer and
     *  the dedupe in one, since a Map keeps insertion order and evicts from the front. */
    const buffered = new Map<string, NetRecord>();

    function keyOf(record: NetRecord): string {
      return record.kind === 'video' ? `v:${record.videoId}` : `c:${record.id}`;
    }

    /** File this response's records, and answer with the ones worth forwarding.
     *
     *  A record already buffered is normally not forwarded again — but a later sighting can
     *  name what the first could not: a reply's parent is stated only by the tree that carries
     *  it, and that response can arrive afterwards. Those go on; the adapter ignores a record
     *  it has already announced, and one it has not still picks the better answer up. */
    function remember(records: NetRecord[]): NetRecord[] {
      const forward: NetRecord[] = [];
      for (const record of records) {
        const key = keyOf(record);
        const known = buffered.get(key);
        if (!known) {
          buffered.set(key, record);
          forward.push(record);
          continue;
        }
        if (record.kind === 'comment' && known.kind === 'comment') {
          const improved = (!!record.parent && !known.parent) || (!known.author && !!record.author) || (!known.published && !!record.published);
          if (record.parent && !known.parent) known.parent = record.parent;
          if (!known.author && record.author) known.author = record.author;
          if (!known.published && record.published) known.published = record.published;
          if (improved) forward.push(known);
        } else if (record.kind === 'video' && known.kind === 'video') {
          // A video's own words do not change; a second sighting is the same record.
          continue;
        }
      }
      while (buffered.size > BUFFER_LIMIT) {
        const oldest = buffered.keys().next().value;
        if (oldest === undefined) break;
        buffered.delete(oldest);
      }
      return forward;
    }

    function harvestValue(parsed: unknown, label: string): void {
      const records: NetRecord[] = [];
      const walk: CommentWalk = { entities: new Map(), nodes: new Map(), found: 0 };
      // One walk for both kinds: the video check is shape-driven and cheap, and a comment walk
      // that never meets a comment costs one traversal of the same object.
      collectComments(parsed, null, 0, walk);
      const video = videoOf(parsed);
      if (video) records.push(video);
      if (walk.found > 0 || walk.entities.size > 0) records.push(...buildComments(walk));
      if (records.length === 0) return;
      console.log(`[misinfo] youtube: ${records.length} record(s) from ${label}`);
      const forward = remember(records);
      if (forward.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: forward }, '*');
    }

    function harvest(text: string, label: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      harvestValue(parsed, label);
    }

    function labelOf(url: string): string {
      if (url.includes('/youtubei/v1/player')) return 'player';
      if (url.includes('/youtubei/v1/next')) return 'next';
      return 'youtubei';
    }

    /** The URL of a fetch call, whichever of the three legal input shapes carries it. A `URL`
     *  has no `.url` property, so reading that property (the obvious spelling) silently
     *  matches nothing. */
    function requestUrl(input: any): string {
      if (typeof input === 'string') return input;
      if (input && typeof input.url === 'string') return input.url;    // Request
      if (input && typeof input.href === 'string') return input.href;  // URL
      return '';
    }

    function isApiUrl(url: string): boolean {
      return API_MARKERS.some((marker) => url.includes(marker));
    }

    function postPending(open: boolean): void {
      window.postMessage({ type: PENDING_MESSAGE, open }, '*');
    }

    const originalFetch = window.fetch;
    window.fetch = function (input: any, init?: any) {
      const promise = originalFetch.call(this, input, init);
      const url = requestUrl(input);
      if (!isApiUrl(url)) return promise;
      postPending(true);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        postPending(false);
      };
      // Read a clone: the response body is a stream, and consuming the original would leave
      // the page's own code with an empty one.
      return promise.then((response: Response) => {
        try {
          // Harvested, then settled, in that order and in one task: the receiver files these
          // records before it is told the hold is over.
          response.clone().text().then(
            (text) => {
              try { harvest(text, labelOf(url)); } finally { settle(); }
            },
            settle,
          );
        } catch { settle(); }
        return response;
      }, (error: unknown) => {
        // A failed request has no records to wait for; the page's rejection is passed on.
        settle();
        throw error;
      });
    };

    /** The API URL an XHR object was opened on, if it was one. `open` only records it; the
     *  hold starts at `send`, because an object opened and never sent would otherwise hold
     *  announcements for a request that does not exist. */
    const apiHref = new WeakMap<XMLHttpRequest, string>();

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (_method: string, url: string | URL) {
      const href = String(url);
      if (isApiUrl(href)) apiHref.set(this, href);
      else apiHref.delete(this);
      return originalOpen.apply(this, arguments as any);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const href = apiHref.get(this);
      apiHref.delete(this);
      if (!href) return originalSend.apply(this, arguments as any);
      postPending(true);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        postPending(false);
      };
      this.addEventListener('load', () => {
        try {
          if (typeof this.responseText === 'string') harvest(this.responseText, labelOf(href));
        } catch {
          /* Unreadable body: nothing to harvest, but the hold still has to end. */
        } finally {
          settle();
        }
      });
      // Every way a sent request can end without a `load`: a send that never reaches the
      // network, a cancel, a timeout. Each one ends the hold too.
      this.addEventListener('error', settle);
      this.addEventListener('abort', settle);
      this.addEventListener('timeout', settle);
      return originalSend.apply(this, arguments as any);
    };

    /** The page's own initial blob.
     *
     *  The mobile reader states a video's description nowhere in its markup and does not
     *  request `/player` at all (measured: only `log_event` and `/next`), so the inline
     *  `ytInitialPlayerResponse` this app is handed is the ONLY place those words exist. It
     *  is assigned by the page's own scripts after this one runs, and replaced on every
     *  in-page navigation, so it is read on arrival and whenever navigation reports one.
     *  Reading is idempotent — the harvest dedupes by record id — and the identity check keeps
     *  a re-read of the same object from walking it again. */
    let lastInitial: unknown = null;

    function readInitial(): void {
      let player: unknown;
      try {
        player = (window as any).ytInitialPlayerResponse;
      } catch {
        return;
      }
      if (!player || player === lastInitial) return;
      lastInitial = player;
      harvestValue(player, 'initial');
    }

    /** The live player's own response.
     *
     *  `ytInitialPlayerResponse` describes the page as it was FIRST loaded and is not refreshed
     *  on an in-page navigation — measured 2026-10-31: after clicking a video out of search it
     *  was gone altogether (`ytplayer` too), and `/player` was not requested again, because the
     *  app served the new video off data it already held. The player element keeps the response
     *  it is playing, so that is the second place to ask. Without it a video reached by an
     *  in-page navigation had no payload at all: its collapsed description is a prefix and the
     *  adapter refuses to file one, so the post never existed and the bar never appeared. */
    let lastPlayer: unknown = null;

    function readPlayer(): void {
      let response: unknown;
      try {
        response = (document.querySelector('#movie_player') as any)?.getPlayerResponse?.();
      } catch {
        return;
      }
      if (!response || response === lastPlayer) return;
      lastPlayer = response;
      const video = videoOf(response);
      // A response for a video the page has already left states words that are not on screen.
      if (!video || (pageVideoId() && video.videoId !== pageVideoId())) return;
      harvestValue(response, 'player element');
    }

    window.addEventListener('load', readInitial);
    // YouTube's own navigation event, fired on both readers once the next page's data is in
    // place. The name is the app's, not a class or a piece of text, so a restyle cannot move it.
    // Registered on the document as well as the window: the app dispatches it on the window
    // today, and listening on both costs nothing.
    window.addEventListener('yt-navigate-finish', readInitial);
    document.addEventListener('yt-navigate-finish', readInitial);
    // The player element is handed the next video's response by the app, not by the event, so
    // it is asked on the same events and the same ladder.
    window.addEventListener('yt-navigate-finish', readPlayer);
    document.addEventListener('yt-navigate-finish', readPlayer);
    // The blob is assigned by a script that may run before or after the events above; a short
    // ladder covers both without watching the whole page.
    for (const delay of [300, 1200, 3000, 6000]) {
      window.setTimeout(readInitial, delay);
      window.setTimeout(readPlayer, delay);
    }

    // The isolated half may not have been listening when the first responses landed.
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.type !== HELLO_MESSAGE) return;
      const known = Array.from(buffered.values());
      if (known.length > 0) window.postMessage({ type: NETWORK_MESSAGE, records: known }, '*');
    });
  },
});
