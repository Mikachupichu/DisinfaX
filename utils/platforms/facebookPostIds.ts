/**
 * The name Facebook's own payload gives a story, and the other names the same payload uses
 *  for it — the join between a post's id and the ids its rendered markup carries.
 *
 *  The payload states a story's id as `post_id`, a plain decimal number, and that number is
 *  the only name that reaches across surfaces. Measured on 2026-09-30, all four of these are
 *  the same number, on one post: the payload's `post_id` (1954546802648883); the
 *  `story_fbid` the same payload states for that story; the `post` half of every comment's
 *  own `comment_id` parameter, which base64-decodes to `comment:1954546802648883_<comment>`;
 *  and the `mediaset_token` of a photo post's album attachment, which spells it `pcb.<id>`.
 *
 *  The rendered markup, by contrast, names the story either by a `pfbid…` in its permalink or
 *  by the id of one of its PHOTOS in an `?fbid=` link — and a photo's id is not the post's.
 *  On that same post the markup offers `?fbid=1954544955982401` and the payload's `post_id`
 *  for it is 1954546802648883; the two numbers are close and never equal, and the post's own
 *  id appears nowhere in the rendered markup at all (measured on five one-photo posts). A
 *  pfbid is a different name again, and it is the payload's `permalink_url` — not the markup
 *  — that joins it to the story's `post_id`.
 *
 *  Two names for one post is what left a post and its own comments unable to join (see
 *  `enclosingPostId` in facebook.ts), so a post root is filed under the id the payload states,
 *  resolved from whichever alias the markup happens to offer.
 *
 *  Read by BOTH halves, so the two agree on what a payload says: the isolated adapter scans the
 *  page's server-rendered `script[type="application/json"]` blobs, the MAIN-world hook parses
 *  the app's own `/api/graphql/` responses (a feed page renders the first screen from blobs and
 *  every later one from XHR — measured: 3 blobs carrying 7 post ids on an initial feed load).
 *
 *  The other half of that agreement is `collectCommentTexts`: the same payloads also state what
 *  each comment says, under the comment's own id, and a comment the page has truncated is
 *  completed from that the way a truncated post is completed from its story's `message`.
 */
export interface NetPostId {
  /** The story's own id, in the decimal space comments and `story_fbid` share. */
  postId: string;
  /** Every other name the payload uses for this same story: its `pfbid…`, and the ids of the
   *  photos it attaches. Never another story's id, and never an album's (`set=a.<id>` is
   *  shared by every photo post in the album, so it names none of them). */
  aliases: string[];
  /** The story's own words as this same payload states them, or null when it states none.
   *
   *  Carried because the markup names a story NOWHERE on some surfaces. Measured on a photo
   *  permalink (`/photo/?fbid=…&set=a.…`): the story's panel holds no permalink of its own, no
   *  `profile_name`, no `story_message` and no id in any attribute — its only roles are the
   *  three footer controls — and the address bar's `?fbid=` names one of its PHOTOS, not the
   *  post. The payload, meanwhile, states the story's `post_id` and its whole text in one
   *  node (`…currMedia.container_story.message.text`, 4063 characters for a post whose photo
   *  id differs from its `post_id` by one digit). So the text is what binds that panel to the
   *  id the payload files it under, the same way a permalink binds a feed post. */
  message: string | null;
}

export interface NetCommentText {
  /** The comment's own id, in the decimal space its permalink states as `comment_id` and its
   *  base64 `id` decodes to (`comment:<post id>_<comment id>`). */
  commentId: string;
  /** The comment's words, whole — the field a truncated comment is completed from. */
  text: string;
}

/** A story's `pfbid…`, wherever the payload spells one out — `permalink_url` carries it, and
 *  so do the story's own `url` fields. */
const PFBID_IN_URL = /\/posts\/(pfbid[0-9A-Za-z]+)/;

/** Deep enough for the shapes these payloads take (a story sits under `data` and a nest of
 *  `comet_sections`), and bounded so a cyclic or unexpectedly deep body costs a walk rather
 *  than a hang.
 *
 *  Measured at 40 rather than guessed: on a group post page whose blob states ten comments,
 *  the comment nodes sit at depths 24 THROUGH 27, and a cap of 24 kept the five at exactly 24
 *  while dropping the ten at 27 — which is what left every truncated comment unfillable while
 *  the map looked populated. Stories run deeper still (a `post_id` was measured at 30). The
 *  cap is a guard against a pathological payload, not a reading of the shape, so it is set well
 *  past the deepest node measured rather than at it — a shape one level deeper must not silently
 *  lose a whole harvest again. */
const MAX_DEPTH = 40;

/** A story has one album's worth of photos; the cap is what keeps a pathological payload from
 *  remembering thousands of aliases for one post. */
const MAX_ALIASES = 32;

/** Every alias inside one story's subtree, into `aliases`.
 *
 *  A DIFFERENT story nested inside this one — a share's `attached_story` — states its own
 *  `post_id`, and its photos and permalink are its own: descending into it would file the
 *  SHARED post's photo under the sharer, so the walk stops there. That node is still walked by
 *  `collectPostIds` itself, which is what files it under its own id.
 *
 *  The same story nested inside itself is walked THROUGH. A payload repeats a story's whole
 *  body under `comet_sections.content.story`, so bailing at any `post_id` would stop at that
 *  copy — and a story whose copy is keyed before its `attachments` then yields no photo id at
 *  all, which is exactly what left three of five posts on a search feed unresolvable while
 *  their payloads stated the join. `ownerId` is what tells the two apart. */
function collectAliases(value: unknown, aliases: Set<string>, depth: number, ownerId: string): void {
  if (depth > MAX_DEPTH || aliases.size >= MAX_ALIASES || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAliases(item, aliases, depth + 1, ownerId);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.post_id === 'string' && node.post_id !== ownerId) return;
  if (node.__typename === 'Photo' && typeof node.id === 'string') aliases.add(node.id);
  for (const child of Object.values(node)) {
    if (typeof child === 'string') {
      const pfbid = child.match(PFBID_IN_URL);
      if (pfbid) aliases.add(pfbid[1]);
      continue;
    }
    collectAliases(child, aliases, depth + 1, ownerId);
  }
}

/** The story's own words, as one story's subtree states them, or null.
 *
 *  The same walk as `collectAliases` and for the same reason: a payload repeats a story's whole
 *  body under `comet_sections.content.story`, so the text may sit one copy below the node that
 *  carries the `post_id`, and a DIFFERENT story nested in this one (a share's `attached_story`)
 *  states words that are not this story's. `ownerId` tells the two apart, and the first
 *  `message.text` found in the owner's own subtree wins. */
function collectMessage(value: unknown, depth: number, ownerId: string): string | null {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = collectMessage(item, depth + 1, ownerId);
      if (found) return found;
    }
    return null;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.post_id === 'string' && node.post_id !== ownerId) return null;
  // A COMMENT's words are not the story's, and a comment nested in the story's own subtree —
  // the payload carries the first few with the post — would otherwise be read as the story's
  // text: the panel would then be filed under this id with a commenter's words, which is the
  // one thing `post-id-names-one-text` refuses. Comments are named by `__typename`, the
  // payload's own vocabulary rather than any rendered label.
  if (typeof node.__typename === 'string' && node.__typename.startsWith('Comment')) return null;
  const message = node.message as Record<string, unknown> | undefined;
  if (message && typeof message === 'object' && typeof message.text === 'string' && message.text.length > 0) {
    return message.text;
  }
  for (const child of Object.values(node)) {
    const found = collectMessage(child, depth + 1, ownerId);
    if (found) return found;
  }
  return null;
}

/** Every comment's own words a payload states, each under the comment's own decimal id.
 *
 *  A comment states its words at `body.text` where a STORY states its own at `message.text`
 *  (`collectMessage`, whose walk this mirrors) — which is why the two cannot be one harvest: a
 *  comment nested in a story's own subtree would otherwise be read as that story's text, the
 *  thing `post-id-names-one-text` refuses. Measured 2026-10-01 on a group post: 10 comment
 *  nodes, every one stating `legacy_fbid` and `body.text`, and none of them stating `message`
 *  at all. So the field carrying the words is what tells the two apart, and `__typename` is
 *  not even needed for it — 190 further nodes on that page name themselves `Comment…` and
 *  carry neither field.
 *
 *  The id is the join the markup already uses: `legacy_fbid` is the decimal a comment's own
 *  permalink spells as `comment_id`, and the same one the base64 `id` beside it decodes to
 *  (`comment:<post id>_<comment id>`). Measured on that post: all ten comments on screen
 *  joined to a node here, ten of ten.
 *
 *  Depth is not a filter: a reply states its own words the same way, under its own id, which
 *  is what lets a reply the page truncated be completed too. The first text seen for an id
 *  wins, so a payload that states the same comment twice costs nothing. */
export function collectCommentTexts(value: unknown): NetCommentText[] {
  const out: NetCommentText[] = [];
  const seen = new Set<string>();
  const walked = new Set<object>();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') continue;
    if (walked.has(node)) continue;
    walked.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    const record = node as Record<string, unknown>;
    const body = record.body as Record<string, unknown> | undefined;
    const text = body && typeof body.text === 'string' ? body.text : '';
    const raw = record.legacy_fbid;
    const commentId = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
    if (text.length > 0 && /^\d+$/.test(commentId) && !seen.has(commentId)) {
      seen.add(commentId);
      out.push({ commentId, text });
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  return out;
}

/** Every story a payload states, each with the aliases and the words the same payload gives it.
 *  Stories that state neither are left out: they are joinable to nothing, and the markup already
 *  states an id for them. */
export function collectPostIds(value: unknown): NetPostId[] {
  const byPostId = new Map<string, { aliases: Set<string>; message: string | null }>();
  // One story is referenced from many places in one response (`edges[node]` plus whatever
  // holds it), so a node is walked once.
  const walked = new Set<object>();
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    if (depth > MAX_DEPTH || !node || typeof node !== 'object') continue;
    if (walked.has(node)) continue;
    walked.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.post_id === 'string') {
      let entry = byPostId.get(record.post_id);
      if (!entry) byPostId.set(record.post_id, (entry = { aliases: new Set<string>(), message: null }));
      for (const child of Object.values(record)) collectAliases(child, entry.aliases, depth + 1, record.post_id);
      entry.message ??= collectMessage(record, depth, record.post_id);
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 });
    }
  }
  const out: NetPostId[] = [];
  for (const [postId, { aliases, message }] of byPostId) {
    if (aliases.size === 0 && !message) continue;
    out.push({ postId, aliases: [...aliases], message });
  }
  return out;
}
