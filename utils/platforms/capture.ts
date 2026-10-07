/** Shared plumbing for DOM-fed platforms.
 *
 *  Platform adapters differ in how they read markup; they do not differ in what the
 *  classify pipeline then needs. Anything here is deliberately the same for every
 *  DOM-fed platform, so a fix lands once instead of fifteen times. */
import { hydrateReplyChains } from '../parsing';
import { UNKNOWN_LANGUAGE, type MainTweet } from '../../data/Tweets';
import type { CapturedPost } from './types';

/** Name the language of a captured post, going to the platform only when the platform
 *  has something to say.
 *
 *  Every highlight range is keyed by the language of the text it addresses, and a post
 *  whose language nobody can name has no key to file them under — so the background falls
 *  back to the reader's UI locale (see `runPreclassification`), which files the same post
 *  under a different key for every reader whose browser is in another language. Between the
 *  two, one stable key for "we don't know" is what keeps a post's highlights findable — and
 *  it is what X does with the same problem (`und` out of `legacy.lang`).
 *
 *  Applied here rather than in the background so it covers every captured path at once —
 *  a DOM sweep and a platform API both land on the batch this way — and so a platform added
 *  later inherits it without anyone remembering to. Only the post itself is named: a
 *  quoted post or a reply parent is keyed by the ROOT's language everywhere downstream (the
 *  worker computes one locale per batch and the segment builder reads `classification.
 *  textLocale`), so naming a context node would give it a key nothing looks it up by. */
export function nameCapturedLanguage(post: MainTweet): MainTweet {
  if (!post.sourceLanguage) post.sourceLanguage = UNKNOWN_LANGUAGE;
  return post;
}

/** The app's own UI language, which is what a host translates a post INTO when it shows a
 *  translation at all.
 *
 *  Shared because more than one platform's translate control is like this: nothing on the
 *  page states a post's target language — it is a setting in the host's own UI, and it
 *  leaves no mark on the post it applies to. Telegram's picker under the menu's "Change
 *  language" marks nothing (measured), and Threads' inline control does not either, so on
 *  both this is the app's language rather than the post's. The difference only ever costs
 *  the name a highlight range is filed under: the text itself is read from the DOM and
 *  never inferred.
 *
 *  The base subtag, because the document's tag can carry a region the classifier's locale
 *  keys do not. Null when the document states no language, which is read as "no translation
 *  to describe" rather than as a language named nothing.
 *
 *  The extension's own locale is a different thing entirely and is deliberately not consulted. */
export function appLanguage(): string | null {
  const tag = document.documentElement.lang.trim().split('-')[0].toLowerCase();
  return tag || null;
}

/** Turn a captured batch into the payload the background classifies, with reply
 *  context linked.
 *
 *  The `__replyParentId` marker is an implementation detail of the chain builder —
 *  X's `parseTweet` sets the same one — so adapters describe their thread structure as
 *  a plain parent id and this function is the only place that knows the marker exists.
 *
 *  Linking across the batch is what keeps the payload linear. Resolving each post's
 *  ancestors at capture time would instead embed a full copy of every ancestor in every
 *  descendant: on a ten-deep comment chain that is ten copies of the submission, all of
 *  them billed as prompt tokens. */
export function hydrateCapturedChains(captured: CapturedPost[]): MainTweet[] {
  const posts = captured.map(({ post, replyParentId }) => {
    if (replyParentId) (post as { __replyParentId?: string | null }).__replyParentId = replyParentId;
    return post;
  });
  hydrateReplyChains(posts);
  return posts;
}
