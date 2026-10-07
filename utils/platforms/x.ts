/** The X (Twitter) adapter.
 *
 *  Deliberately a façade, not a port: every method calls the same function the X
 *  integration has always called, so routing X through the adapter seam cannot change
 *  X behaviour. Anything platform-specific that X needs and other platforms do not —
 *  quoted-tweet cards, the Grok translation row, `primaryColumn` centering — stays in
 *  `utils/injecting.ts` and is reached from here.
 *
 *  If a future change needs X to behave differently, change it in `injecting.ts` (the
 *  one place it has always lived) rather than growing this file into a second
 *  implementation that can drift out of sync with it.
 */
import {
  classificationRoots,
  findGrokRow,
  findTweetTextElement,
  getArticleMainStatusId,
  getTimelineColumnCenter,
  isTweetTargetOnX,
  placeButtonContainer,
} from '../injecting';
import { PLATFORM_HOSTS } from './hosts';
import { LONG_FORM_CHARS } from './types';
import type { PlatformAdapter, PostRef } from './types';

/** X post ids are bare numeric status ids — see the note on `PlatformId`. */
const STATUS_ID_RE = /\/status\/(\d+)/;

/** X's own post container. A quoted-tweet card lives inside it, so this covers the
 *  whole post including anything it quotes. */
const POST_SELECTOR = 'article[data-testid="tweet"]';

/** The length at which X stops showing a post whole.
 *
 *  Measured 2026-10-01 on a signed-in home timeline: the shortest tweet carrying X's own
 *  "Show more" ran to 280 characters, and the longest tweet without one ran to 279. That
 *  measurement is why this platform's number used to be 280 — and why it no longer is: a
 *  per-host number made the same length mean two things on two platforms, so every platform
 *  reads the universal `LONG_FORM_CHARS` instead.
 *
 *  Applied to the post's own text and never to what it quotes: a short post quoting a long
 *  one is still a post the reader takes in at a glance. */

export const xAdapter: PlatformAdapter = {
  id: 'x',
  hosts: PLATFORM_HOSTS.x ?? [],

  postIdFromUrl(url) {
    return url.pathname.match(STATUS_ID_RE)?.[1] ?? null;
  },

  postRoots(id) {
    return classificationRoots(id);
  },

  postIdOf(root) {
    return getArticleMainStatusId(root);
  },

  /** A post, judged for length — see LONG_FORM_CHARS.
   *
   *  This decides the SELECTION and nothing else. A long post gets a pill like every other
   *  post and the pill behaves like every other pill; what it keeps is the passage, so a
   *  selection inside it is read with the post's own boundaries, its author and its chain
   *  rather than firing the post whole. `entrypoints/selection.ts` is where that is
   *  resolved — on X it cannot be read off the DOM the way "does this post have our
   *  chrome" can, which is why the count has to come from here.
   *
   *  There is no "See more" to key on: X renders the whole text and clamps it with CSS, so
   *  the expander is markup rather than a cut in the string — which is why the test is on
   *  the text. */
  isLongForm(root, ref) {
    const text = findTweetTextElement(root, false, ref?.id);
    return (text?.textContent?.trim().length ?? 0) >= LONG_FORM_CHARS;
  },

  textElement(root, ref: PostRef) {
    return findTweetTextElement(root, ref.isQuoted ?? false, ref.id);
  },

  placeButtons(container, root, ref: PostRef) {
    // The timestamp permalink is X's last-resort anchor when neither an action row
    // nor a Grok row is present — same three-step fallback placeButtonContainer runs
    // for every X build today.
    const time = root.querySelector<HTMLElement>(`a[href*="/status/${ref.id}"]`);
    placeButtonContainer(container, root, time as Element, findGrokRow(root));
  },

  feedCenter() {
    return getTimelineColumnCenter();
  },

  isPostTarget(id) {
    return isTweetTargetOnX(id);
  },

  postElementFor(node) {
    const el = node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
    return el?.closest(POST_SELECTOR) ?? null;
  },
};
