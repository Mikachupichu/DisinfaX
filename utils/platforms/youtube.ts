/** The YouTube adapter.
 *
 *  Two surfaces are integrated on a video's watch page, and nothing else is: the video's own
 *  metadata block — filed as ONE post, the title above the description, the shape Reddit and
 *  Quora already give a submission — and every comment under it, replies included. Every
 *  comment's ancestor chain ends at that description post, which is the root of its thread.
 *  Deliberately NOT integrated: Shorts (`/shorts/<id>`), and the feed, search and channel
 *  cards — those are links into a watch page rather than posts, the same boundary
 *  [[index-rows-are-not-posts]] draws elsewhere. Live and premiere chats are not claimed
 *  either: they are a different renderer whose markup was never measured.
 *
 *  ## Why the payload, on a platform with a DOM
 *
 *  YouTube's web client is fed by its own internal API — `/youtubei/v1/player` and
 *  `/youtubei/v1/next` — and both rendered readers (desktop `www.` and mobile `m.`) are
 *  clients of it. Measured 2026-10-31, the payload is the only place three things exist:
 *
 *  - A video's own words. `videoDetails.title` and `videoDetails.shortDescription`, with
 *    `microformat.playerMicroformatRenderer.uploadDate` for the date the description post is
 *    filed under. On desktop the description is in the markup too, but COLLAPSED: the snippet
 *    is a prefix of the authored text, and the rest is behind "…more". On the mobile reader it
 *    is not rendered at all (only a zero-sized `ytm-crawler-description`), so there is
 *    nothing to read.
 *  - A comment's own words on the mobile reader, which renders NO ID anywhere in its markup
 *    — the payload's `commentRenderer.commentId` is the only name a comment has there.
 *  - A comment's parent, stated by the payload's thread tree (`commentThreadRenderer` nesting
 *    on desktop, `commentRepliesRenderer` on mobile) and by its dotted id (`<root>.<reply>`)
 *    where the tree is flat, which is what a reply-continuation response hands back.
 *
 *  So comments are filed from the payload and the markup is asked only where to paint, the
 *  same split Threads and Facebook use. The DOM path below stays as the fallback for a
 *  comment no response covered.
 *
 *  ## Translations
 *
 *  A desktop comment carries YouTube's own translate control (`ytd-tri-state-button-view-model`)
 *  and flipping it REPLACES the comment's words in place — the source is then in no text node
 *  and in no attribute. Measured: the control states which side is up at its own `state`
 *  attribute (`toggled` / `untoggled`), which is what `displayedTranslationLocale` reads, and
 *  the payload keeps carrying the SOURCE, so a comment the reader translated after it was
 *  filed is already dual-sided and needs no flip at all. `revealSource` exists for the one
 *  case the payload does not cover — a comment no response described — and it puts the page
 *  back on the side the reader left it on before returning.
 *
 *  The mobile reader has no translate control at all (measured across 20 comments, zero
 *  controls), so nothing there can be showing a side it did not author.
 *
 *  ## The clamp
 *
 *  A comment body is clamped by CSS on both readers with every word in the DOM, so it is
 *  painted as it stands and this adapter implements neither `bodyClipped` nor `revealClipped`
 *  — the host's own box does the clipping, and a highlight past the cut is hidden with it. A
 *  DESCRIPTION is different: the collapsed snippet withholds words from the page entirely,
 *  which is why the post is filed from the payload and why `textRegions` paints only the
 *  prefix the page actually shows. Nothing is ever hashed from that snippet (see `capture`).
 */
import type { MainTweet } from '../../data/Tweets';
import { Usertype as UsertypeEnum } from '../../data/Tweets';
import { isoDatetime, isoDatetimeFromAge } from '../datetime';
import { passageTextContent } from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { CapturedPost, PlatformAdapter, PostRef, TextRegion } from './types';

const ID_PREFIX = 'youtube:';
/** A video id, as it appears in `/watch?v=`. Fixed-length, so nothing else is claimed. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** A comment id: `<id>` at the top level, `<rootId>.<replyId>` for a reply. Bounded so a
 *  page-authored string cannot become a file name. */
const COMMENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The comment id a desktop comment's age link carries, as `?v=…&lc=<id>`. */
const LC_RE = /[?&]lc=([^&#]+)/;

const DESKTOP_METADATA = 'ytd-watch-metadata';
const MOBILE_METADATA = 'ytm-slim-video-metadata-section-renderer';
const DESKTOP_COMMENT = 'ytd-comment-view-model';
const MOBILE_COMMENT = 'ytm-comment-renderer';
const COMMENT_SELECTOR = `${DESKTOP_COMMENT}, ${MOBILE_COMMENT}`;

/** The separator between a video's title and its description in the one post they form.
 *  A blank line, the same join Reddit and Quora give a submission's heading and body. */
const JOIN = '\n\n';

const MAX_VIDEOS = 16;
const MAX_COMMENTS = 800;
const MAX_SOURCES = 200;
const MAX_IDS_PER_KEY = 4;
/** How many times a translated comment may be flipped for its source before the adapter
 *  stops pressing. Two covers a control the host had not hydrated on the first pass. */
const MAX_REVEAL_ATTEMPTS = 2;
const REVEAL_POLL_MS = 50;
const REVEAL_POLL_TRIES = 24;

function isRecord(value: unknown): value is Record<string, any> {
    return !!value && typeof value === 'object';
}

/** Collapse runs of whitespace, for comparing a payload's words with the page's. */
function squeeze(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function isSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function namespaced(id: string): string {
    return ID_PREFIX + id;
}

/* ── Page-wide state ────────────────────────────────────────────────────────────────
 *
 *  A video's description, a comment, and the joins between them, all as the page's own API
 *  stated them. Keyed by the ids the payload uses, so nothing here is positional and a
 *  re-render does not invalidate any of it. */

interface VideoRecord {
    videoId: string;
    title: string;
    description: string;
    author: string;
    published: string;
}

interface CommentRecord {
    id: string;
    videoId: string;
    text: string;
    author: string;
    published: string;
    /** The comment this one answers, or null for a top-level one (whose parent is the video). */
    parent: string | null;
}

const videos = new Map<string, VideoRecord>();
const comments = new Map<string, CommentRecord>();
/** `author \0 body` -> comment ids, and `body` -> ids. The mobile reader names no comment id
 *  in its markup, so this is how a rendered comment is matched back to the record that
 *  describes it. Most specific first; `mobileIdOf` falls back only when the key is unique. */
const idsByKey = new Map<string, string[]>();
const idsByText = new Map<string, string[]>();
/** Source text recovered by flipping a translated comment back, by comment id. */
const sources = new Map<string, string>();
/** Comment ids already claimed by one rendered root, so a duplicate render cannot take the
 *  same record twice. */
const claimed = new Map<string, Element>();
const idByRoot = new WeakMap<Element, string>();
const revealAttempts = new WeakMap<Element, number>();

function keyOf(author: string, text: string): string {
    return `${squeeze(author)}\u0000${squeeze(text)}`;
}

function pushUnique(map: Map<string, string[]>, key: string, id: string): void {
    const list = map.get(key);
    if (!list) {
        map.set(key, [id]);
        return;
    }
    if (list.includes(id)) return;
    list.push(id);
    if (list.length > MAX_IDS_PER_KEY) list.shift();
}

function rememberVideo(record: VideoRecord): void {
    videos.delete(record.videoId);
    videos.set(record.videoId, record);
    while (videos.size > MAX_VIDEOS) {
        const oldest = videos.keys().next().value;
        if (oldest === undefined) break;
        videos.delete(oldest);
    }
}

function rememberComment(record: CommentRecord): void {
    const known = comments.get(record.id);
    // One comment reaches this twice when the same response carries both its entity and its
    // thread node, and once more when a later response repeats it. Keep the better reading:
    // a parent is the field that can arrive second, since a reply's node and its entity are
    // stated by different parts of the payload.
    const merged: CommentRecord = known
        ? {
            id: record.id,
            videoId: record.videoId || known.videoId,
            text: record.text || known.text,
            author: record.author || known.author,
            published: record.published || known.published,
            parent: record.parent ?? known.parent,
        }
        : record;
    comments.delete(merged.id);
    comments.set(merged.id, merged);
    pushUnique(idsByKey, keyOf(merged.author, merged.text), merged.id);
    pushUnique(idsByText, squeeze(merged.text), merged.id);
    while (comments.size > MAX_COMMENTS) {
        const oldest = comments.keys().next().value;
        if (oldest === undefined) break;
        comments.delete(oldest);
    }
}

/** The video the page is showing, memoized on the URL it was read from. In-page navigation
 *  changes only the query, so this is asked a great many times per sweep. */
let scopeKey = '';
let scopeVideo: string | null = null;

function currentVideoId(): string | null {
    const key = location.pathname + location.search;
    if (key === scopeKey) return scopeVideo;
    scopeKey = key;
    const value = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    scopeVideo = value && VIDEO_ID_RE.test(value) ? value : null;
    return scopeVideo;
}

/* ── The roots ────────────────────────────────────────────────────────────────────── */

function descriptionRoot(): Element | null {
    return document.querySelector(DESKTOP_METADATA) ?? document.querySelector(MOBILE_METADATA);
}

function isDescriptionRoot(root: Element): boolean {
    return root.localName === DESKTOP_METADATA || root.localName === MOBILE_METADATA;
}

function isMobileDescription(root: Element): boolean {
    return root.localName === MOBILE_METADATA;
}

function isDesktopComment(root: Element): boolean {
    return root.localName === DESKTOP_COMMENT;
}

function isMobileComment(root: Element): boolean {
    return root.localName === MOBILE_COMMENT;
}

/** Every comment currently laid out. A root the host has not sized yet is one the reader
 *  cannot see, and it is picked up on a later mutation once it is. */
function commentRoots(): Element[] {
    const out: Element[] = [];
    for (const el of Array.from(document.querySelectorAll(COMMENT_SELECTOR))) {
        if (el.getBoundingClientRect().width <= 0) continue;
        out.push(el);
    }
    return out;
}

/* ── A video's own words ─────────────────────────────────────────────────────────── */

/** The one text a video is filed under: its title, then its description. A video with no
 *  description is its title alone — never the title plus a blank line. */
function videoText(record: VideoRecord): string {
    const title = record.title.trim();
    const description = record.description.trim();
    if (title && description) return title + JOIN + description;
    return title || description;
}

function desktopTitleEl(root: Element): Element | null {
    return root.querySelector('#title h1');
}

/** The block a desktop description renders into once the reader has opened it, or null while
 *  it is still collapsed (the host renders the element empty until then). */
function expandedDescriptionEl(root: Element): Element | null {
    const expanded = root.querySelector('#expanded yt-attributed-string') ?? root.querySelector('#expanded');
    return expanded && squeeze(expanded.textContent ?? '') ? expanded : null;
}

/** The element a desktop description's BODY is rendered into: the expanded block when the
 *  reader has opened it, the snippet otherwise. Both are measured to match the payload's
 *  words character for character (the expanded block exactly, the snippet as a prefix). */
function desktopDescriptionBodyEl(root: Element): Element | null {
    return expandedDescriptionEl(root) ?? root.querySelector('#snippet > span#snippet-text');
}

function desktopChannelName(root: Element): string {
    const link = root.querySelector('#owner #channel-name a') ?? root.querySelector('#owner a');
    return link ? squeeze(link.textContent ?? '') : '';
}

/** The description as the DOM states it, or null when the DOM cannot state it whole.
 *
 *  A snippet with an expander beside it is a PREFIX of the authored text, and a prefix names
 *  no post — so this refuses rather than filing one. The payload is what covers that case;
 *  this is only reached when no response described the video at all. */
function domDescriptionText(root: Element): string | null {
    if (isMobileDescription(root)) return null;
    const titleEl = desktopTitleEl(root);
    const title = titleEl ? passageTextContent(titleEl as HTMLElement).trim() : '';
    const expanded = expandedDescriptionEl(root);
    const expandedText = expanded ? passageTextContent(expanded as HTMLElement).trim() : '';
    const join = (body: string): string => (title && body ? title + JOIN + body : title || body);
    if (expandedText) return join(expandedText);
    const snippet = root.querySelector('#snippet > span#snippet-text');
    const snippetText = snippet ? passageTextContent(snippet as HTMLElement).trim() : '';
    if (root.querySelector('#expand') || root.querySelector('#collapse')) return null;
    return join(snippetText) || null;
}

/* ── A comment's own words ───────────────────────────────────────────────────────── */

/** A desktop comment's id, read off the age link's `lc` parameter — the same id the payload
 *  states at `properties.commentId`. */
function desktopCommentId(root: Element): string | null {
    for (const anchor of Array.from(root.querySelectorAll('#published-time-text a, a[href*="lc="]'))) {
        const match = LC_RE.exec(anchor.getAttribute('href') ?? '');
        if (!match) continue;
        let id = match[1];
        try {
            id = decodeURIComponent(id);
        } catch {
            /* A malformed escape leaves the raw value, which is then validated below. */
        }
        if (COMMENT_ID_RE.test(id)) return id;
    }
    return null;
}

function desktopBodyElement(root: Element): Element | null {
    return root.querySelector('#content-text');
}

function desktopBodyText(root: Element): string {
    const el = desktopBodyElement(root);
    return el ? passageTextContent(el as HTMLElement).trim() : '';
}

function desktopAuthor(root: Element): string {
    const el = root.querySelector('#author-text');
    return el ? squeeze(el.textContent ?? '') : '';
}

function desktopPublished(root: Element): string {
    const el = root.querySelector('#published-time-text');
    return el ? (el.textContent ?? '').trim() : '';
}

/** YouTube's own translate control on a desktop comment, or null where it has none (every
 *  comment with nothing to translate, and every mobile comment). */
function desktopTranslateControl(root: Element): Element | null {
    return root.querySelector('ytd-tri-state-button-view-model');
}

function desktopTranslated(root: Element): boolean {
    return desktopTranslateControl(root)?.getAttribute('state') === 'toggled';
}

/** The mobile reader's content column: the `button` a comment's words live in. */
function mobileContent(root: Element): Element | null {
    for (const child of Array.from(root.children)) {
        if (child.localName === 'button') return child;
    }
    return null;
}

/** The span a mobile comment's body is rendered into. The body sits in a `p` the host clamps
 *  by height, with every word inside it. */
function mobileBodyElement(root: Element): Element | null {
    const content = mobileContent(root);
    if (!content) return null;
    const paragraph = content.querySelector('p');
    if (!paragraph) return null;
    return paragraph.querySelector('span[role="text"]') ?? paragraph;
}

function mobileBodyText(root: Element): string {
    const el = mobileBodyElement(root);
    return el ? passageTextContent(el as HTMLElement).trim() : '';
}

/** The author and age spans of a mobile comment's header. They are the `role=text` spans
 *  OUTSIDE the body's own `p`, which is what makes this structural rather than a class name:
 *  the reader's own order is author, then age, then the body. */
function mobileHeaderSpans(root: Element): Element[] {
    const content = mobileContent(root);
    if (!content) return [];
    return Array.from(content.querySelectorAll('span[role="text"]')).filter((span) => !span.closest('p'));
}

function mobileAuthor(root: Element): string {
    const spans = mobileHeaderSpans(root);
    return spans.length > 0 ? squeeze(spans[0].textContent ?? '') : '';
}

function mobilePublished(root: Element): string {
    const spans = mobileHeaderSpans(root);
    return spans.length > 1 ? (spans[1].textContent ?? '').trim() : '';
}

function recordIsCurrent(record: CommentRecord | undefined): boolean {
    const video = currentVideoId();
    if (!record) return false;
    return !record.videoId || record.videoId === video;
}

/** The record a rendered mobile comment is, claimed for this root.
 *
 *  The mobile markup names no id at all, so the join is the comment's own (author, words) —
 *  exact, and only ever when the payload stated it for the video on screen. A comment whose
 *  key is shared (one person posting the same words twice) still resolves, because the claim
 *  is what keeps two roots off one record. */
function mobileIdOf(root: Element): string | null {
    const video = currentVideoId();
    if (!video) return null;
    const body = mobileBodyText(root);
    if (!body) return null;
    const memo = idByRoot.get(root);
    if (memo) {
        const record = comments.get(memo);
        if (record && recordIsCurrent(record) && squeeze(record.text) === squeeze(body)) return memo;
        idByRoot.delete(root);
    }
    const author = mobileAuthor(root);
    const byKey = (idsByKey.get(keyOf(author, body)) ?? []).filter((id) => recordIsCurrent(comments.get(id)));
    const candidates = byKey.length > 0
        ? byKey
        : (idsByText.get(squeeze(body)) ?? []).filter((id) => recordIsCurrent(comments.get(id)));
    for (const id of candidates) {
        const owner = claimed.get(id);
        if (owner && owner !== root && owner.isConnected) continue;
        claimed.set(id, root);
        idByRoot.set(root, id);
        while (claimed.size > MAX_COMMENTS) {
            const oldest = claimed.keys().next().value;
            if (oldest === undefined) break;
            claimed.delete(oldest);
        }
        return id;
    }
    return null;
}

/** The id a root is filed under, or null when it is not a post this adapter can address. */
function idOf(root: Element): string | null {
    if (isDescriptionRoot(root)) {
        const video = currentVideoId();
        return video ? namespaced(video) : null;
    }
    if (isDesktopComment(root)) {
        const id = desktopCommentId(root);
        return id ? namespaced(id) : null;
    }
    if (isMobileComment(root)) {
        const id = mobileIdOf(root);
        return id ? namespaced(id) : null;
    }
    return null;
}

/* ── Turning a record into a post ───────────────────────────────────────────────── */

/** The comment a reply answers: the payload's own edge where it stated one, the id's dotted
 *  prefix where it did not (a reply continuation states its replies flat, and the prefix
 *  names the THREAD ROOT rather than the direct parent — every ancestor is in the post's
 *  hash, so the thread root is the one the payload exists to correct), and the video, which
 *  is what every comment's chain ends at. */
function parentOf(record: CommentRecord): string | null {
    const parent = record.parent ?? dottedParent(record.id);
    if (parent) return namespaced(parent);
    const video = record.videoId || currentVideoId();
    return video ? namespaced(video) : null;
}

function dottedParent(id: string): string | null {
    const dot = id.indexOf('.');
    return dot > 0 ? id.slice(0, dot) : null;
}

function videoPost(record: VideoRecord): CapturedPost {
    const id = namespaced(record.videoId);
    const text = videoText(record);
    const datetime = isoDatetime(record.published);
    return {
        post: {
            id,
            text,
            fullText: text,
            username: record.author.trim(),
            usertype: UsertypeEnum.Regular,
            conversationId: id,
            quoting: null,
            replyingTo: null,
            ...(datetime ? { datetime } : {}),
        },
        replyParentId: null,
    };
}

function commentPost(record: CommentRecord, translatedText?: string): CapturedPost {
    const id = namespaced(record.id);
    const parent = record.parent ?? dottedParent(record.id);
    const conversation = parent ? namespaced(parent) : record.videoId ? namespaced(record.videoId) : id;
    const datetime = isoDatetimeFromAge(record.published);
    const post: MainTweet = {
        id,
        text: record.text,
        // The payload's words ARE the authored ones: nothing here is a rendering of them.
        fullText: record.text,
        username: record.author,
        usertype: UsertypeEnum.Regular,
        conversationId: conversation,
        quoting: null,
        replyingTo: null,
        ...(datetime ? { datetime } : {}),
    };
    if (translatedText) {
        post.translatedText = translatedText;
        // The host translates into a target chosen in its own UI and states nothing about
        // which — so the side is named by its BODY, never by a guessed language.
        post.destinationLanguage = 'und';
    }
    return { post, replyParentId: parentOf(record) };
}

/* ── Capture ─────────────────────────────────────────────────────────────────────── */

function captureDescription(root: Element): CapturedPost | null {
    const video = currentVideoId();
    if (!video) return null;
    // The box outlives the video it was seated for, and `placeButtons` only prunes when it is
    // seating a new bar — so a video that files no post would otherwise leave the previous
    // video's pill standing. This runs on every sweep, which is what makes it the one place a
    // stale pill is always caught. Our own chrome only, and only inside this one box.
    const here = namespaced(video);
    for (const bar of Array.from(root.querySelectorAll('.mf-btn-container'))) {
        if (bar.getAttribute('mf-top-bar-id') !== here) bar.remove();
    }
    const record = videos.get(video);
    const text = record ? videoText(record) : domDescriptionText(root);
    if (!text || !text.trim()) return null;
    if (record) return videoPost(record);
    const id = namespaced(video);
    return {
        post: {
            id,
            text,
            fullText: text,
            username: desktopChannelName(root),
            usertype: UsertypeEnum.Regular,
            conversationId: id,
            quoting: null,
            replyingTo: null,
            // No date: a payload that states one is what `videoPost` files, and the markup
            // this read came from states none.
        },
        replyParentId: null,
    };
}

/** A desktop comment, read off the page.
 *
 *  A comment the platform is showing a translation of has no readable source, so it is
 *  REFUSED rather than filed under the translation's words — the hash would name a post
 *  nobody wrote. `revealSource` is what gives it a source on a later pass. */
function captureDesktopComment(root: Element): CapturedPost | null {
    const id = desktopCommentId(root);
    if (!id) return null;
    const shown = desktopBodyText(root);
    if (!shown) return null;
    const translated = desktopTranslated(root);
    const record = comments.get(id);
    const source = record?.text || sources.get(id) || '';
    if (translated && !source) return null;
    if (translated && squeeze(source) === squeeze(shown)) {
        return commentPost({ id, videoId: currentVideoId() ?? '', text: shown, author: desktopAuthor(root), published: desktopPublished(root), parent: record?.parent ?? dottedParent(id) });
    }
    return commentPost(
        {
            id,
            videoId: currentVideoId() ?? '',
            text: translated ? source : shown,
            author: desktopAuthor(root),
            published: desktopPublished(root),
            parent: record?.parent ?? dottedParent(id),
        },
        translated ? shown : undefined,
    );
}

function captureMobileComment(root: Element): CapturedPost | null {
    const id = mobileIdOf(root);
    if (!id) return null;
    const record = comments.get(id);
    if (!record) return null;
    return commentPost(record);
}

/** Records forwarded by `youtube.capture.content.ts`. Validated field by field, because a
 *  response is page-controlled data. */
function recordsOf(value: unknown): { videos: VideoRecord[]; comments: CommentRecord[] } {
    const outVideos: VideoRecord[] = [];
    const outComments: CommentRecord[] = [];
    if (!Array.isArray(value)) return { videos: outVideos, comments: outComments };
    const pageVideo = currentVideoId() ?? '';
    for (const raw of value) {
        if (!isRecord(raw)) continue;
        if (raw.kind === 'video') {
            if (typeof raw.videoId !== 'string' || !VIDEO_ID_RE.test(raw.videoId)) continue;
            const record: VideoRecord = {
                videoId: raw.videoId,
                title: typeof raw.title === 'string' ? raw.title : '',
                description: typeof raw.description === 'string' ? raw.description : '',
                author: typeof raw.author === 'string' ? raw.author : '',
                published: typeof raw.published === 'string' ? raw.published : '',
            };
            if (!record.title.trim() && !record.description.trim()) continue;
            outVideos.push(record);
            continue;
        }
        if (raw.kind !== 'comment') continue;
        if (typeof raw.id !== 'string' || !COMMENT_ID_RE.test(raw.id)) continue;
        if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
        // A comment is never its own ancestor: a self-edge would make the post its own chain.
        const parent = typeof raw.parent === 'string' && COMMENT_ID_RE.test(raw.parent) && raw.parent !== raw.id
            ? raw.parent
            : null;
        const videoId = typeof raw.videoId === 'string' && VIDEO_ID_RE.test(raw.videoId) ? raw.videoId : pageVideo;
        const record: CommentRecord = {
            id: raw.id,
            videoId,
            // Trimmed for the same reason the markup path trims: a trailing newline would
            // otherwise be part of the hash and none of the body's offsets.
            text: raw.text.trim(),
            author: typeof raw.author === 'string' ? raw.author : '',
            published: typeof raw.published === 'string' ? raw.published : '',
            parent,
        };
        outComments.push(record);
    }
    return { videos: outVideos, comments: outComments };
}

/* ── The flip ───────────────────────────────────────────────────────────────────── */

/** Press a host control. `.click()` is what the reader's press does; a disabled control
 *  ignores it, which is the same outcome as not pressing at all. */
function pressControl(el: Element): void {
    const button = el.querySelector('button') ?? el;
    (button as HTMLElement).click();
}

/** Poll a comment's body until it differs from `before` (or stops differing). Bounded, and
 *  abandoned the moment the root leaves the page. */
async function waitForBody(root: Element, before: string, wantDifferent: boolean): Promise<string | null> {
    const wanted = squeeze(before);
    for (let attempt = 0; attempt < REVEAL_POLL_TRIES; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, REVEAL_POLL_MS));
        if (!root.isConnected) return null;
        const now = desktopBodyText(root);
        if ((squeeze(now) !== wanted) === wantDifferent) return now;
    }
    return null;
}

let revealQueue: Promise<void> = Promise.resolve();

/** Flip one comment to its own words, read them, and put the page back. */
async function flipForSource(root: Element, id: string): Promise<void> {
    if (!root.isConnected || sources.has(id)) return;
    const before = desktopBodyText(root);
    if (!before) return;
    const control = desktopTranslateControl(root);
    if (!control || control.getAttribute('state') !== 'toggled') return;
    pressControl(control);
    const revealed = await waitForBody(root, before, true);
    if (revealed && squeeze(revealed) !== squeeze(before)) {
        sources.set(id, revealed);
        while (sources.size > MAX_SOURCES) {
            const oldest = sources.keys().next().value;
            if (oldest === undefined) break;
            sources.delete(oldest);
        }
    }
    // The press did not take — the control still says a translation is up, so the page is
    // exactly as it was found and there is nothing to put back.
    const after = desktopTranslateControl(root);
    if (!after || after.getAttribute('state') === 'toggled') return;
    pressControl(after);
    await waitForBody(root, before, false);
}

/* ── Placement ──────────────────────────────────────────────────────────────────── */

/** How long a bar waits for a date line the metadata box has not built yet. */
const LINE_WAIT_MS = 20000;

/** The element on the video's fact line that holds the words — the LAST of the two the
 *  current and the older markup use, since `#info` carries the whole line today and
 *  `#date-text` fills on the older one. */
function dateHolderOf(line: Element): Element | null {
    const holders = Array.from(line.querySelectorAll('#date-text, #info')).filter((el) => (el.textContent ?? '').trim());
    return holders[holders.length - 1] ?? line.querySelector('#info, #date-text');
}

function seatOnDateLine(container: HTMLElement, date: Element): void {
    container.style.marginLeft = '8px';
    container.style.alignSelf = 'center';
    container.style.flexShrink = '0';
    date.insertAdjacentElement('afterend', container);
}

/** Bars waiting for a line that has not been built yet. */
const waitingForLine = new WeakSet<HTMLElement>();

/** Move a bar that was seated before the metadata box held a line.
 *
 *  On an in-page navigation the bar is built the moment the video's payload lands, which is
 *  before `ytd-watch-metadata` has rendered anything — so the seat fell through to the action
 *  row, and nothing revisits a bar that is already connected. Watched once per bar, and only
 *  until the line appears or the bar leaves the page. */
function seatOnLineWhenBuilt(container: HTMLElement, root: Element): void {
    if (waitingForLine.has(container)) return;
    waitingForLine.add(container);
    let timer = 0;
    const stop = (): void => {
        waitingForLine.delete(container);
        observer.disconnect();
        window.clearTimeout(timer);
    };
    const observer = new MutationObserver(() => {
        // A bar replaced by the next video's must not be moved back into this one's box.
        if (!container.isConnected) { stop(); return; }
        const line = root.querySelector('#info-container') ?? root.querySelector('ytd-watch-info-text');
        const date = line ? dateHolderOf(line) : null;
        if (!line || !date) return;
        stop();
        seatOnDateLine(container, date);
    });
    observer.observe(root, { childList: true, subtree: true });
    timer = window.setTimeout(stop, LINE_WAIT_MS);
}

function placeDescriptionButtons(container: HTMLElement, root: Element): void {
    if (isMobileDescription(root)) {
        // The byline row — handle, likes, views, age — is one nowrap line the host clips at its
        // own edge, with its expander in the tail. Measured 2026-10-31 at 412 CSS px: the spans
        // end at 322 and the expander runs to 396, so an 85px pill has nowhere to go on a
        // phone; from ~480 px the row is short enough to hold it. Where it fits, the pill rides
        // the row straight after the age, the seat it takes on every other platform. Where it
        // cannot, it becomes the line directly under the byline — still the video's own block,
        // where the reader is already looking, rather than the end of the action row.
        // The spans are asked for by position, never by wording: every one of them is localized.
        container.style.flexShrink = '0';
        container.style.alignSelf = 'center';
        const content = root.querySelector('.ytVideoSubtitleViewModelSubtitleContent');
        const spans = content ? Array.from(content.querySelectorAll('span[role="text"]')) : [];
        const age = spans[spans.length - 1];
        if (content && age) {
            container.style.marginLeft = '8px';
            container.style.marginRight = '0';
            container.style.marginTop = '0';
            age.insertAdjacentElement('afterend', container);
            if (content.scrollWidth <= content.clientWidth) return;
            container.remove();
        }
        container.style.marginLeft = '0';
        container.style.marginTop = '4px';
        const under = root.querySelector('.ytVideoMetadataViewModelContent')
            ?? root.querySelector('yt-video-metadata-view-model');
        if (under) {
            under.appendChild(container);
            return;
        }
        const host = root.querySelector('ytm-slim-video-action-bar-renderer') ?? root;
        host.appendChild(container);
        return;
    }
    // Desktop: the video's own line of facts — views and the date — is the description box's
    // `#info-container`, and the pill goes straight after that text on the same line, not at
    // the far end of the action row above. Measured 2026-10-31: the line's text ends at 329 of
    // a 943px box, so the pill sits right beside the date with the rest of the line empty.
    const line = root.querySelector('#info-container') ?? root.querySelector('ytd-watch-info-text');
    const date = line ? dateHolderOf(line) : null;
    if (line && date) {
        seatOnDateLine(container, date);
        return;
    }
    // The box exists but its line does not yet: this seat is a stand-in, and the bar moves to
    // the line the moment it is rendered.
    seatOnLineWhenBuilt(container, root);
    const host = root.querySelector('#actions') ?? root.querySelector('#top-row');
    if (!host) return;
    container.style.marginLeft = 'auto';
    container.style.alignSelf = 'center';
    container.style.flexShrink = '0';
    host.appendChild(container);
}

/* ── The adapter ────────────────────────────────────────────────────────────────── */

/** Every rendered element a post id covers. The video's description is one post; every
 *  comment is another, and its root is found by asking the markup which id it belongs to
 *  rather than by keeping a second index of our own. */
function rootsOf(id: string): Element[] {
    if (!id.startsWith(ID_PREFIX)) return [];
    const key = id.slice(ID_PREFIX.length);
    const out: Element[] = [];
    if (key === currentVideoId()) {
        const root = descriptionRoot();
        if (root) out.push(root);
    }
    for (const root of commentRoots()) {
        if (idOf(root) === id) out.push(root);
    }
    return out;
}

export const youtubeAdapter: PlatformAdapter = {
    id: 'youtube',
    hosts: PLATFORM_HOSTS.youtube ?? [],

    postIdFromUrl(url: URL): string | null {
        if (url.pathname !== '/watch') return null;
        const video = url.searchParams.get('v');
        return video && VIDEO_ID_RE.test(video) ? namespaced(video) : null;
    },

    postRoots(id: string): Element[] {
        return rootsOf(id);
    },

    postIdOf(root: Element): string | null {
        return idOf(root);
    },

    textElement(root: Element, _ref: PostRef): Element | null {
        if (isDescriptionRoot(root)) {
            // The mobile reader renders no description at all, so there is nothing there to
            // paint into — the post is still filed and still carries its buttons.
            if (isMobileDescription(root)) return null;
            return desktopDescriptionBodyEl(root) ?? desktopTitleEl(root);
        }
        if (isDesktopComment(root)) return desktopBodyElement(root);
        if (isMobileComment(root)) return mobileBodyElement(root);
        return null;
    },

    /** The mobile reader renders no description, so that post has nowhere to paint — but it
     *  is filed from the payload and still carries its buttons. */
    buttonsWithoutText(root: Element, _ref: PostRef): boolean {
        return isDescriptionRoot(root) && isMobileDescription(root);
    },

    /** A video is ONE post spread over two blocks — its title and its description — so the
     *  claim segments are cut between them the way Reddit's are. Only the run the page
     *  actually shows is named, which is what keeps a collapsed description paintable. */
    textRegions(root: Element, ref: PostRef): TextRegion[] | null {
        if (!isDescriptionRoot(root) || isMobileDescription(root)) return null;
        const classified = ref.text;
        if (!classified) return null;
        const titleEl = desktopTitleEl(root);
        const titleText = titleEl ? passageTextContent(titleEl as HTMLElement).trim() : '';
        const bodyEl = desktopDescriptionBodyEl(root);
        const bodyText = bodyEl ? passageTextContent(bodyEl as HTMLElement).trim() : '';
        // A title-only video is the single-element case: `textElement` names the title.
        if (!titleEl || !titleText || !bodyEl || !bodyText) return null;
        // Both offsets are checked against the string the claims were measured against, so a
        // shifted slice can never paint a claim over words it never named.
        if (!classified.startsWith(titleText)) return null;
        const bodyStart = titleText.length + JOIN.length;
        if (classified.slice(titleText.length, bodyStart) !== JOIN) return null;
        // The page never renders the payload's words character for character. The collapsed
        // snippet stops at the clamp, and an OPENED description draws a link as the path it
        // points at (`  / jaydonelive`) where the payload carries the whole `https://…` URL —
        // so an exact slice test failed on any description with a link in it, and the whole
        // post then fell back to painting the full classified text (title included) into the
        // body alone, which the painter refuses: every highlight lost, and a Localize button
        // over text that had just been classified, while the SAME post collapsed still read
        // Reveal. So the region covers the longest leading run the two agree on, whitespace
        // aside — the same tolerance the in-place painter allows — and a claim past that run
        // is left unpainted rather than taking the rest of the post down with it. That is
        // what "cut off at the clamp" is: the visible prefix is painted, the withheld tail is
        // not, and the post keeps its identity (always the payload's full text).
        const rest = classified.slice(bodyStart);
        let c = 0;
        let d = 0;
        while (c < rest.length && d < bodyText.length) {
            const want = rest[c];
            const shown = bodyText[d];
            if (want === shown || (isSpace(want) && isSpace(shown))) { c++; d++; continue; }
            if (isSpace(want)) { c++; continue; }
            if (isSpace(shown)) { d++; continue; }
            break;
        }
        // Nothing of the payload's description leads the element: this body is some other
        // text (a translation, or a renderer we do not know), and no prefix is safe to name.
        if (c === 0) return null;
        return [
            { el: titleEl, start: 0, end: titleText.length },
            { el: bodyEl, start: bodyStart, end: bodyStart + c },
        ];
    },

    highlightInPlace: true,

    placeButtons(container: HTMLElement, root: Element, ref: PostRef): void {
        if (isDescriptionRoot(root)) {
            // YouTube reuses ONE description box across a video switch, so the bar seated for
            // the video the reader left is still in this line. Injection finds a bar by its own
            // post id, so that bar is neither reused nor replaced — each new video seats
            // another beside it. Measured 2026-10-31, clicking through nine sidebar videos:
            // nine pills on one line, and none of the stale ids were ever torn down because
            // `rootsOf` answers [] for a video that is no longer current. One box shows one
            // video, so a bar naming any other post is stale and goes.
            for (const stale of Array.from(root.querySelectorAll('.mf-btn-container'))) {
                if (stale !== container && stale.getAttribute('mf-top-bar-id') !== ref.id) stale.remove();
            }
            placeDescriptionButtons(container, root);
            return;
        }
        if (isDesktopComment(root)) {
            // The comment's own head line — the pinned badge, the author, the age — is
            // `#header-author`; `#header` only WRAPS that line, so a container appended there
            // drops onto its own row underneath (measured 2026-10-31). Seated in the head
            // line, the pill follows the age on the same row, which is the seat it takes on
            // every other platform here.
            const host = root.querySelector('#header-author') ?? root.querySelector('#header') ?? root.querySelector('#main');
            if (!host) return;
            container.style.marginLeft = '8px';
            container.style.alignSelf = 'center';
            container.style.flexShrink = '0';
            host.appendChild(container);
            return;
        }
        if (isMobileComment(root)) {
            // A mobile comment's header is one flex row holding the author, then the age,
            // laid out `space-between` (measured 2026-10-31: author at 68..153, age at
            // 278..388 of a 412px phone). The row is the parent of the header's own two
            // `role=text` spans — asked for by position, never by wording, since both are
            // localized. The pill drops between them: after the author, and with its right
            // margin taking the free space so the age stays hard against the far edge.
            // The reader wraps the whole comment in one `button`; the shared bar code seals
            // our container against that press.
            const spans = mobileHeaderSpans(root);
            const author = spans[0];
            if (!author) return;
            // Each header span is wrapped in an element of its own, so the row is the nearest
            // ancestor holding both; the pill sits after the author's wrapper, before the age.
            const age = spans[1];
            const holds = (row: Element) => !!age && row.contains(age);
            let branch: Element = author;
            let row: Element | null = author.parentElement;
            while (row && row !== root && !holds(row)) {
                branch = row;
                row = row.parentElement;
            }
            container.style.marginLeft = '8px';
            container.style.marginRight = 'auto';
            container.style.alignSelf = 'center';
            container.style.flexShrink = '0';
            if (row) branch.insertAdjacentElement('afterend', container);
            else author.insertAdjacentElement('afterend', container);
        }
    },

    feedCenter(): number | null {
        const description = descriptionRoot();
        const roots = description ? [description, ...commentRoots().slice(0, 12)] : commentRoots().slice(0, 12);
        let left = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        for (const root of roots) {
            const rect = root.getBoundingClientRect();
            if (rect.width <= 0) continue;
            left = Math.min(left, rect.left);
            right = Math.max(right, rect.right);
        }
        return right > left ? (left + right) / 2 : null;
    },

    isPostTarget(id: string): boolean {
        return rootsOf(id).length > 0;
    },

    /** A description is judged on its whole authored text, whether or not the page happens to
     *  be showing all of it; a comment is never long-form, whatever its length — the same rule
     *  every platform's comments follow. */
    isLongForm(root: Element): boolean {
        if (!isDescriptionRoot(root)) return false;
        if (isMobileDescription(root)) {
            const video = currentVideoId();
            const record = video ? videos.get(video) : undefined;
            return record ? videoText(record).length > LONG_FORM_CHARS : false;
        }
        const video = currentVideoId();
        const record = video ? videos.get(video) : undefined;
        const text = record ? videoText(record) : domDescriptionText(root);
        return (text?.length ?? 0) > LONG_FORM_CHARS;
    },

    postElementFor(node: Node): Element | null {
        const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
        if (!el) return null;
        const root = el.closest(COMMENT_SELECTOR) ?? el.closest(`${DESKTOP_METADATA}, ${MOBILE_METADATA}`);
        if (!root) return null;
        // A root we cannot name is not one of ours: the selection over it stays a web
        // selection, exactly as it would on any other page.
        return idOf(root) ? root : null;
    },

    captureRoots(): Element[] {
        const out: Element[] = [];
        const description = descriptionRoot();
        if (description) out.push(description);
        for (const root of commentRoots()) out.push(root);
        return out;
    },

    capture(root: Element): CapturedPost | null {
        if (isDescriptionRoot(root)) return captureDescription(root);
        if (isDesktopComment(root)) return captureDesktopComment(root);
        if (isMobileComment(root)) return captureMobileComment(root);
        return null;
    },

    captureNetwork(records: unknown[]): CapturedPost[] {
        const { videos: videoRecords, comments: commentRecords } = recordsOf(records);
        for (const record of videoRecords) rememberVideo(record);
        for (const record of commentRecords) rememberComment(record);
        const pageVideo = currentVideoId();
        const out: CapturedPost[] = [];
        for (const record of videoRecords) {
            if (pageVideo && record.videoId !== pageVideo) continue;
            out.push(videoPost(record));
        }
        for (const record of commentRecords) {
            if (pageVideo && record.videoId && record.videoId !== pageVideo) continue;
            out.push(commentPost(record));
        }
        return out;
    },

    /** Which side a desktop comment is showing, read off the host's own control — the one
     *  place the platform states it. Null for every other root: a description is never
     *  translated in place, and the mobile reader has no control at all. */
    displayedTranslationLocale(root: Element): string | null | undefined {
        if (!isDesktopComment(root)) return null;
        return desktopTranslated(root) ? 'und' : null;
    },

    translationLocaleIsGuessed: true,

    displayedText(root: Element): string | null {
        if (isDesktopComment(root)) return desktopBodyText(root) || null;
        if (isMobileComment(root)) return mobileBodyText(root) || null;
        return null;
    },

    async revealSource(root: Element): Promise<void | boolean> {
        if (!isDesktopComment(root)) return false;
        const id = desktopCommentId(root);
        if (!id) return false;
        // The payload carries the source for every comment it described, so there is nothing
        // to flip for. Only a comment no response covered can be stuck on its translation.
        if (comments.has(id) || sources.has(id)) return false;
        if (desktopTranslateControl(root)?.getAttribute('state') !== 'toggled') return false;
        const attempts = revealAttempts.get(root) ?? 0;
        if (attempts >= MAX_REVEAL_ATTEMPTS) return false;
        revealAttempts.set(root, attempts + 1);
        const run = revealQueue.then(() => flipForSource(root, id));
        revealQueue = run.catch(() => {});
        await revealQueue;
        return !sources.has(id) && (revealAttempts.get(root) ?? 0) < MAX_REVEAL_ATTEMPTS;
    },
};
