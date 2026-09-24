import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { useT, getUiLocale } from './i18n';
import { Disclaimer } from './Disclaimer';
import { AnnotatedText, RawAnnotations } from './AnnotatedText';
import { VerdictBadge } from './VerdictBadge';
import { SourceLink } from './SourceLink';
import {
  preClassify,
  refreshClaim,
  computeTweetHash,
  backgroundAnnotate,
  translateText,
  setWorkerErrorHandler,
  normalizeText,
} from '../../utils/intelligence';
import { parseWorkerErrorMessage, codeToMessageKey } from '../../utils/errorCodes';
import type { ParsedWorkerError } from '../../utils/errorCodes';
import { fetchTweetAndTouchNetwork, hashToBytea, subscribeRow } from '../../utils/realtime';
import type { ClaimPayload, SubscriptionHandle } from '../../utils/realtime';
import { resolveHighlightRange, selectAnnotationRevision, selectHighlightRevision, sha256HexSync } from '../../utils/textBreakup';
import { sameLanguage } from '../../data/Classification';
import type { Classification, Claim, Source } from '../../data/Classification';
import type { ClaimInput } from '../../data/Tweets';

interface FactCheckTabProps {
  user: User;
}

export interface FactCheckClaimState {
  rawText: string;
  rewritten: string;
  range?: [number, number];
  dbClaimId?: string;
  isClassified: boolean;
  needsReclassify: boolean;
  missingAnnotations: boolean;
  /** Flow A's silent annotation run for this claim is on its way: the research that just
   *  finished asked for it (it ran with locators), so the claim is settled and keyless for
   *  as long as that write takes. Suppresses the Annotate button, which would otherwise
   *  offer to buy a run already in flight — the same window the on-page client marks with
   *  annotateInFlight (see stampAnnotateInFlight / annotateSeededKeys). */
  awaitingAnnotations?: boolean;
  veracity?: number;
  confidence?: number;
  reasoning?: string;
  sources?: Source[];
  annotations?: RawAnnotations;
  cachedResult?: {
    veracity?: number;
    confidence?: number;
    reasoning?: string;
    sources?: Source[];
  };
  claimLocale?: string;
  reasoningLocale?: string;
}

const GlobeIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline-block"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10z" />
  </svg>
);

const CopyIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline-block flex-shrink-0"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const CheckIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline-block flex-shrink-0"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

/** Put text on the clipboard, reporting whether it landed.
 *
 *  `navigator.clipboard` is the right call but not a guaranteed one: a popup document only
 *  counts as focused while it has the user's attention, and Safari's is a sheet behind the
 *  app's own window — so the write can reject with the click sitting right there. The
 *  textarea fallback is the one the on-page copy buttons already use for the same reason
 *  (see the popover's copyBtn in utils/injecting.ts). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the selection-based copy */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copy-to-clipboard button, beside the text it copies. The icon becomes a check for a
 *  moment on success — the feedback the on-page copy button gives, so a click that changed
 *  nothing on screen still says it worked. */
const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        if (!(await copyText(text))) return;
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1500);
      }}
      title={label}
      className="flex items-center gap-1 flex-shrink-0 px-1.5 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors text-[11px] font-medium whitespace-nowrap cursor-pointer"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
};

/** Marks a button whose click runs a piece of work this text has already been through,
 *  rather than a first run — the same icon the on-page refresh buttons use. */
const RefreshIcon = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="inline-block flex-shrink-0"
  >
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

/** Whether a DB claim row is the one this popup claim came from.
 *
 *  The id is the answer whenever it is known. A claim researched for the first time in
 *  this tab has no id until its row comes back — nothing in the research stream carries
 *  one — so the stored claim text is the fallback: it is the text the worker wrote. */
function storedClaimText(row: ClaimPayload, locale: string): string | undefined {
  if (typeof row.claim === 'string') return row.claim;
  const byLocale = row.claim as Record<string, string> | undefined;
  if (!byLocale) return undefined;
  return byLocale[locale] || Object.values(byLocale)[0];
}

/** The span of the displayed text a payload's highlight ranges out, or undefined when there
 *  is no highlight for it, or its highlight binds to some other revision of that text.
 *
 *  A claim this tweet only LINKS to keeps the text of whichever tweet first researched it:
 *  preclassification matched the two and wrote a link, not a second claim row, so the row's
 *  own text is another phrasing of the same claim and names nothing here. Its highlight is
 *  what does — it is this tweet's own range for that claim, measured against this exact text.
 *  Gated on the revision hash for the same reason annotations are: a range taken from a text
 *  this tab is not holding addresses characters that have since moved. */
function highlightedClaimText(row: ClaimPayload, locale: string, body: string): string | undefined {
  if (!row.highlight || body.length === 0) return undefined;
  const displayed = sha256HexSync(body);
  const known = new Set<string>([displayed]);
  const trimmed = body.trim();
  if (trimmed.length > 0) known.add(sha256HexSync(trimmed));
  const kept = selectHighlightRevision(row.highlight, { displayed, known });
  const range = resolveHighlightRange(kept, locale);
  if (!range || range[0] >= range[1] || range[1] > body.length) return undefined;
  return body.slice(range[0], range[1]);
}

/** Every normalized string a payload offers for naming its claim in this tab: the row's own
 *  text, and the span this tweet's highlight covers. Either can be the one that matches —
 *  see highlightedClaimText. The worker normalizes a claim on its way to the row
 *  (normalizeText: NFKC, collapsed whitespace, trimmed) while this tab holds that claim
 *  before the pass, so comparing them raw would miss whenever the tidying changed a
 *  character — which is exactly the case where text is the only thing naming the claim. */
function claimNameCandidates(row: ClaimPayload, locale: string, body: string): string[] {
  const names: string[] = [];
  const stored = storedClaimText(row, locale);
  if (stored) names.push(stored);
  const spanned = highlightedClaimText(row, locale, body);
  if (spanned) names.push(spanned);
  return names.map(normalizeText);
}

/** Whether a payload's names include one of this claim state's own. */
function namesIncludeClaim(names: string[], claim: FactCheckClaimState): boolean {
  const wanted = [normalizeText(claim.rewritten), normalizeText(claim.rawText)];
  return names.some((name) => wanted.includes(name));
}

/** Whether a claim payload describes this claim. By id once the claim has one — preclassified
 *  claims have none until the worker's detached pipeline writes the row — and before that by
 *  text, which is the only thing naming it. */
function claimRowIs(
  row: ClaimPayload,
  claim: FactCheckClaimState,
  locale: string,
  body: string
): boolean {
  if (claim.dbClaimId && row.id === claim.dbClaimId) return true;
  return namesIncludeClaim(claimNameCandidates(row, locale, body), claim);
}

/** Research that is waiting for a preclassified claim's DB row to be broadcast. The claim
 *  is the state as it stood when the wait began, so the arrival check is claimRowIs — the
 *  same test the merge itself uses to decide which claim a payload describes. */
interface ClaimRowWaiter {
  hash: string;
  claim: FactCheckClaimState;
  resolve: (id: string) => void;
  timer: number;
}

/** Which language a stored text is in, read off the locale-keyed column it came from: the
 *  display locale when the row has it, otherwise whichever locale the row does have — a
 *  claim that fell back to another language is exactly the one Translate is for. A bare
 *  string carries no key of its own, so it counts as the locale it was asked for in. */
function storedLocale(
  value: Record<string, string> | string | null | undefined,
  locale: string
): string | undefined {
  if (typeof value === 'string') return locale;
  if (!value) return undefined;
  return value[locale] ? locale : Object.keys(value)[0];
}

/** The clear control that empties the tab. */
const CloseIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    className="block"
  >
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </svg>
);

/** Onboarding state, shared with the on-page charge popovers (utils/injecting.ts):
 *  `mf_onboarding_dismissed` retires every popover at once, `mf_onboarding_clicked_types`
 *  lists the charge types this user has already used. The type strings below are the same
 *  ones the on-page buttons carry in `data-mf-charge`. */
const ONBOARD_DISMISS_KEY = 'mf_onboarding_dismissed';
const ONBOARD_CLICKED_KEY = 'mf_onboarding_clicked_types';

/** The tab's own state, kept both across a switch to another tab and across the popup
 *  being closed and reopened. Neither survives on its own: closing the popup destroys the
 *  document, and Dashboard unmounts this component outright when another tab is selected
 *  (it renders this one conditionally), so React state alone outlives neither.
 *
 *  The blob records the account it was written for. A blob belonging to someone else is
 *  ignored AND dropped, so a claim typed by one signed-in user can never surface in the
 *  next user's session — whatever the order in which a sign-out and a pending write land. */
const FC_STATE_KEY = 'mf_factcheck_state';

/** How long an annotation subscription stays open. Flow A (the annotation agent) runs
 *  server-side in ctx.waitUntil once the research stream has already closed, and it
 *  includes a second LLM call, so its write can land well after the verdict does. This is
 *  the same window the on-page flow allows (ANNOTATION_TIMEOUT_MS in background.ts): long
 *  enough that the write is caught, bounded so a subscription that never hears anything
 *  still tears down. */
const ANNOTATION_TIMEOUT_MS = 5 * 60 * 1000;

/** How long to wait for a freshly preclassified claim's DB row to be broadcast before
 *  researching it. The same window the on-page flow waits (CLAIM_DB_ROW_TIMEOUT_MS in
 *  background.ts) — research launched before the row lands is research the worker cannot
 *  attach to a claim, and the cost of waiting is bounded. */
const CLAIM_DB_ROW_TIMEOUT_MS = 2000;

/** How long a freshly researched claim is held to be awaiting Flow A's annotation write
 *  before the Annotate button comes back. The on-page window for the same wait
 *  (ANNOTATE_AUTO_PENDING_TIMEOUT_MS in utils/injecting.ts). */
const ANNOTATE_AUTO_PENDING_TIMEOUT_MS = 3 * 60 * 1000;

/** How many lines the claim field grows to before it stops and scrolls instead. The same
 *  ceiling the app's editor uses (`editorMaxLines` in FactCheckView.swift): a claim is
 *  regularly a pasted passage, so it is generous, but a field that kept growing would push
 *  the Disinfact button — and the claims — off the bottom of the panel. */
const MAX_TEXTAREA_LINES = 8;

interface PersistedFactCheckState {
  uid: string;
  inputText: string;
  lastPreclassifiedText: string;
  isEditing: boolean;
  tweetHash: string;
  claims: FactCheckClaimState[];
  classificationObj: Classification | null;
}

export const FactCheckTab: React.FC<FactCheckTabProps> = ({ user }) => {
  const t = useT();
  const locale = getUiLocale();

  // Input text and editing focus state
  const [inputText, setInputText] = useState<string>('');
  const [lastPreclassifiedText, setLastPreclassifiedText] = useState<string>('');
  const [isEditing, setIsEditing] = useState<boolean>(true);
  const [tweetHash, setTweetHash] = useState<string>('');

  // Preclassified claims
  const [claims, setClaims] = useState<FactCheckClaimState[]>([]);
  const [classificationObj, setClassificationObj] = useState<Classification | null>(null);

  // Global busy locking
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [busyMessage, setBusyMessage] = useState<string>('');
  const [activeClaimIndex, setActiveClaimIndex] = useState<number | null>(null);

  // Why the last run produced nothing. The workers explain every refusal with a numbered,
  // localized sentence, but the sink that carries those explanations
  // (reportWorkerError → setWorkerErrorHandler) was only ever wired up in the background
  // script — so a popup run that the worker rejected ended in silence: no claims, no
  // message, nothing to act on. This tab owns the popup's worker calls, so it owns the sink.
  const [runError, setRunError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Open annotation subscriptions, keyed by tweet hash — one per run, reused if a second
   *  claim on the same text is fact-checked, and the handle the teardown below closes. */
  const tweetSubsRef = useRef<Map<string, SubscriptionHandle>>(new Map());

  /** Research waiting on a preclassified claim's DB row. See waitForClaimRow — this is the
   *  popup's equivalent of awaitClaimDbRow in background.ts. */
  const claimRowWaitersRef = useRef<Set<ClaimRowWaiter>>(new Set());

  /** Claim rows this session has already seen broadcast, per tweet hash, with the payload
   *  itself. A wait consults this before it starts waiting: the row can land while the caller
   *  is still mid-await — the lone-claim path does a DB check before it researches — and a
   *  wait registered after that broadcast would sit out its whole timeout for an id it
   *  already missed. The payload is kept because it is a whole claim row (build_claim_payload
   *  plus the link's highlight and annotations), so a row that arrives only over the
   *  subscription can be adopted as-is, without a second read asking the DB the same thing. */
  const claimRowsSeenRef = useRef<Map<string, { id: string; names: string[]; row: ClaimPayload }[]>>(new Map());

  /** The timer that ends each claim's wait for Flow A's annotation write, by claim index.
   *  See markAwaitingAnnotations. Held here rather than on the claim so that replacing the
   *  tab's claims can drop them all in one place. */
  const awaitingTimersRef = useRef<Map<number, number>>(new Map());

  // ── State that outlives this component ──
  // Latest snapshot, read by the writer below. Assigning during render is the same
  // ref-mirror idiom the rest of this file uses (tRef, onboardingClickedRef).
  const persistRef = useRef<PersistedFactCheckState | null>(null);
  persistRef.current = {
    uid: user.id,
    inputText,
    lastPreclassifiedText,
    isEditing,
    tweetHash,
    claims,
    classificationObj,
  };

  // Nothing is written before the stored blob has been read back, or the initial empty
  // state would land on top of it before hydration ever ran.
  const hydratedRef = useRef(false);

  /** Claims handed over by hydration, still carrying whatever the tab knew when it was last
   *  closed. Non-null for exactly the render pass that follows a restore, which is what makes
   *  the reconcile below run once per restore instead of once per render. */
  const [restoredClaims, setRestoredClaims] = useState<FactCheckClaimState[] | null>(null);

  const writePersistedState = useCallback(() => {
    const snapshot = persistRef.current;
    if (!snapshot) return;
    try { void browser.storage.local.set({ [FC_STATE_KEY]: snapshot }); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let live = true;
    try {
      browser.storage.local
        .get(FC_STATE_KEY)
        .then((res: any) => {
          if (!live) return;
          const saved = res?.[FC_STATE_KEY];
          if (saved && typeof saved === 'object' && saved.uid === user.id) {
            if (typeof saved.inputText === 'string') setInputText(saved.inputText);
            if (typeof saved.lastPreclassifiedText === 'string') {
              setLastPreclassifiedText(saved.lastPreclassifiedText);
            }
            if (typeof saved.isEditing === 'boolean') setIsEditing(saved.isEditing);
            if (typeof saved.tweetHash === 'string') setTweetHash(saved.tweetHash);
            if (Array.isArray(saved.claims)) {
              // The wait for Flow A's annotation write does not outlive the tab that armed
              // it — that run was asked for by a popup which has since closed, and whatever
              // it wrote is either on the row now or never will be. Restoring the flag would
              // leave the claim offering no button and no way to ask for one.
              setClaims(saved.claims.map((c: FactCheckClaimState) => ({
                ...c,
                awaitingAnnotations: false,
              })));
              // Only a claim that is settled yet claims to have no annotations can have its
              // answer changed by a read — see the reconcile effect below. Anything else and
              // the restore costs nothing.
              if (
                saved.tweetHash &&
                saved.claims.some(
                  (c: FactCheckClaimState) => c.isClassified && c.missingAnnotations
                )
              ) {
                setRestoredClaims(saved.claims);
              }
            }
            if (saved.classificationObj) setClassificationObj(saved.classificationObj);
          } else if (saved) {
            // Another account's claim text — it has no business outliving that session.
            try { void browser.storage.local.remove(FC_STATE_KEY); } catch { /* ignore */ }
          }
        })
        .catch(() => { /* ignore */ })
        .finally(() => { if (live) hydratedRef.current = true; });
    } catch {
      hydratedRef.current = true;
    }
    return () => { live = false; };
  }, [user.id]);

  // Debounced, so a burst of keystrokes costs one write instead of one per character.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const timer = window.setTimeout(writePersistedState, 400);
    return () => window.clearTimeout(timer);
  }, [
    inputText,
    lastPreclassifiedText,
    isEditing,
    tweetHash,
    claims,
    classificationObj,
    writePersistedState,
  ]);

  // Both a switch to another tab and the popup closing unmount this component, and the
  // cleanup above clears the pending write along with its timer — so the newest state
  // would be exactly the state the debounce never got to. Flush on the way out.
  useEffect(() => () => { if (hydratedRef.current) writePersistedState(); }, [writePersistedState]);

  // Auto-resize textarea: one line tall when empty, growing to fit whatever is typed.
  // `height: auto` first so a shrinking text collapses the box as well as growing it —
  // without it the height only ever ratchets up.
  //
  // The height is snapped to whole lines rather than adopted from scrollHeight as-is.
  // scrollHeight is a layout measurement of a fractional line box, so it rounds up past
  // the line it actually holds and the field ends up a line taller than its text — the
  // empty second line under a one-line claim. Counting lines and rebuilding the height
  // from them gives a single line exactly one line's worth of room.
  //
  // Past MAX_TEXTAREA_LINES it stops growing and scrolls. The scrollbar has to be turned
  // back on for that, one inline style against the class's `overflow-hidden`: the class is
  // hidden so that growing to a height that is a fraction of a line never flashes one.
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    const lineHeight = parseFloat(cs.lineHeight);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const border =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);

    el.style.height = 'auto';
    // scrollHeight spans the padding box, so the padding comes back off to leave the text.
    const textHeight = el.scrollHeight - padTop - padBottom;
    if (!(lineHeight > 0)) {
      el.style.height = `${el.scrollHeight + border}px`;
      el.style.overflowY = 'auto';
      return;
    }
    const lines = Math.max(1, Math.round(textHeight / lineHeight));
    const shown = Math.min(lines, MAX_TEXTAREA_LINES);
    el.style.height = `${shown * lineHeight + padTop + padBottom + border}px`;
    el.style.overflowY = lines > shown ? 'auto' : 'hidden';
  }, []);

  const hasAnythingToClear = inputText.length > 0 || claims.length > 0;

  /** Empty the tab: the text, everything derived from it, and the copy on disk. Back to
   *  the editing view, focused, as if nothing had been run here yet. */
  const handleClearAll = () => {
    if (isBusy) return;
    // Nothing is being watched once the tab is empty, and a subscription left open would hold
    // a routing row for a tweet this tab no longer shows.
    closeTweetSubscriptions();
    clearAwaitingTimers();
    setInputText('');
    setLastPreclassifiedText('');
    setTweetHash('');
    setClaims([]);
    setClassificationObj(null);
    setRunError(null);
    setIsEditing(true);
    try { void browser.storage.local.remove(FC_STATE_KEY); } catch { /* ignore */ }
    // The textarea is only in the tree once the editing view is back, so reach for it on
    // the frame after this render — and re-measure, since it is empty again.
    window.setTimeout(() => {
      adjustTextareaHeight();
      textareaRef.current?.focus();
    }, 0);
  };

  // `useT` returns a fresh function on every render, so the handler reads it through a ref
  // instead of making the registration effect below re-run each time.
  const tRef = useRef(t);
  tRef.current = t;

  /** A worker's parsed failure as the text to show. A code this version recognizes is
   *  shown from our own translations; an unrecognized one falls back to the sentence the
   *  worker sent, which the backend already sanitized. */
  const errorText = useCallback((parsed: ParsedWorkerError): string => {
    const key = parsed.code != null ? codeToMessageKey(parsed.code) : null;
    return (key ? tRef.current(key) : parsed.text) || tRef.current('errServiceUnavailable') || '';
  }, []);

  /** Show a caught failure. A throw that never carried a worker's numbered sentence —
  *  hashing, a stream, the DB check — gets the generic service message, not silence. */
  const reportRunError = useCallback((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err);
    setRunError(errorText(parseWorkerErrorMessage(raw, getUiLocale())));
  }, [errorText]);

  useEffect(() => {
    setWorkerErrorHandler((parsed) => setRunError(errorText(parsed)));
    return () => setWorkerErrorHandler(null);
  }, [errorText]);

  /** The body this tab is showing, readable from anywhere — see annotationsForDisplay. */
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;

  /** The revision of a persisted annotations dict this tab can actually paint.
   *
   *  A DB annotations dict is keyed `<text-locale>:<sha256-of-the-body-the-ranges-address>`
   *  and the server appends a key per revision, so one dict can carry ranges measured
   *  against text other than the text on screen — a translation, or a body the tweet has
   *  since been edited away from. Those offsets address characters that no longer sit where
   *  the ranges say. Keep only the revision bound to a body this tab holds, exactly as the
   *  on-page client does (selectAnnotationRevision), and drop the rest: a revision we can't
   *  place is one we must not paint.
   *
   *  Undefined rather than an empty dict when nothing survives — absence is what raises the
   *  Annotate affordance, so a collapsed `{}` would make "annotated, clean" (an empty dict
   *  UNDER a kept key, which does survive here) indistinguishable from "never annotated".
   *
   *  The body is read from a ref rather than closed over, because this runs from a
   *  subscription's callback as well as from render: a subscription opened for one run
   *  outlives an edit that changes the text, and the body to hash at that moment is
   *  whichever one the tab is showing then, not the one the subscription opened against. */
  const annotationsForDisplay = useCallback(
    (raw: Record<string, Record<string, string>> | undefined) => {
      if (!raw || typeof raw !== 'object') return undefined;
      const dict: Record<string, Record<string, string>> = {};
      for (const [key, val] of Object.entries(raw)) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          dict[key] = val as Record<string, string>;
        }
      }
      // Writer and reader have to hash the identical string: the annotate worker hashes the
      // tweet text it was handed, which is this textarea's own text, untrimmed.
      const body = inputTextRef.current;
      const displayed = body.length > 0 ? sha256HexSync(body) : null;
      const known = new Set<string>();
      for (const candidate of [body, body.trim()]) {
        if (candidate.length > 0) known.add(sha256HexSync(candidate));
      }
      const stripped = selectAnnotationRevision(dict, { displayed, known });
      return Object.keys(stripped).length > 0 ? stripped : undefined;
    },
    []
  );

  /** The verdict a DB row contributes to a claim on screen — everything that belongs to the
   *  row rather than to whichever of this tab's claims is showing it.
   *
   *  One mapping for every path that reads a row back (the DB check on submit, the merge
   *  after preclassification, a row that only arrives over the subscription): these fields
   *  have to agree, or the same claim would render differently depending on how it was
   *  found. The caller decides whether the row settles the claim — see claimRowIs and
   *  `reclassify` at each call site. */
  const claimFieldsFromRow = useCallback(
    (row: ClaimPayload) => {
      const reasoning = typeof row.reasoning === 'string'
        ? row.reasoning
        : (row.reasoning as any)?.[locale] || Object.values(row.reasoning || {})[0] || '';
      const sources: Source[] = Array.isArray(row.sources)
        ? row.sources
        : row.sources && typeof row.sources === 'object'
        ? Object.entries(row.sources).map(([title, url]) => ({ title, url: String(url) }))
        : [];
      const annotations = annotationsForDisplay(row.annotations);
      return {
        dbClaimId: row.id,
        veracity: row.veracity,
        confidence: row.probability ?? Math.abs(row.veracity ?? 0),
        reasoning,
        sources,
        annotations,
        missingAnnotations: !annotations,
        claimLocale: storedLocale(row.claim, locale),
        reasoningLocale: storedLocale(row.reasoning, locale),
      };
    },
    [annotationsForDisplay, locale]
  );

  /** Fold one broadcast claim payload into the claim it describes.
   *
   *  The tweet-scoped subscription carries a payload per claim — its id, its highlight and
   *  its annotations — and the claim it belongs to is found the same way the honest-reload
   *  path finds it (claimRowIs: by id once known, by stored text before that).
   *
   *  Only the row-derived fields are taken. Verdict, reasoning and sources stay owned by the
   *  research stream: a broadcast can arrive for a claim mid-classification (is_classifying)
   *  carrying the PREVIOUS verdict, and letting that overwrite what is streaming in would
   *  walk the card backwards. Annotations are the one thing the stream never carries, which
   *  is the whole reason this subscription exists.
   *
   *  A payload also releases any wait for this claim's row (waitForClaimRow): its id is
   *  exactly what that wait is for. Resolved outside the state updater, which React may run
   *  twice, so one payload can't settle the same wait twice. */
  const mergeAnnotationPayload = useCallback(
    (hash: string, payload: ClaimPayload) => {
      const body = inputTextRef.current;
      const names = claimNameCandidates(payload, locale, body);
      const seen = claimRowsSeenRef.current.get(hash) ?? [];
      // REPLACE by id, never skip: a claim's row is written more than once, and the payloads
      // are snapshots of the same row at different moments — the link first (the
      // preclassifier's insert: no reasoning, veracity 0), the classification's own write
      // second (the verdict, the reasoning). Keeping the first froze this cache at the
      // pre-classification snapshot, so `waitForClaimRow`'s lookup below answered `adoptSettledRow`
      // with a row that said nobody had answered the claim, and the tab paid to classify a claim
      // the database had already answered. One entry per claim id, newest wins.
      const at = seen.findIndex((row) => row.id === payload.id);
      if (at >= 0) {
        seen[at] = { id: payload.id, names, row: payload };
      } else {
        seen.push({ id: payload.id, names, row: payload });
      }
      claimRowsSeenRef.current.set(hash, seen);
      for (const waiter of Array.from(claimRowWaitersRef.current)) {
        if (waiter.hash !== hash || !claimRowIs(payload, waiter.claim, locale, body)) continue;
        claimRowWaitersRef.current.delete(waiter);
        window.clearTimeout(waiter.timer);
        waiter.resolve(payload.id);
      }
      setClaims((prev) => {
        const index = prev.findIndex((c) => claimRowIs(payload, c, locale, body));
        if (index < 0) return prev;
        const current = prev[index];
        const annotations = annotationsForDisplay(payload.annotations);
        const wrote = !!payload.annotations && Object.keys(payload.annotations).length > 0;
        const next = [...prev];
        next[index] = {
          ...current,
          // Adopted even when the payload carries no annotations: this is the id a later
          // Annotate tap hands the worker, and what makes the next match exact rather than
          // textual, so a claim first researched in this tab stops being anonymous.
          dbClaimId: current.dbClaimId ?? payload.id,
          annotations,
          missingAnnotations: !(annotations && Object.keys(annotations).length > 0),
          // A key at all — even one this tab cannot paint — is Flow A having written, which
          // ends the wait for it (see awaitingAnnotations).
          awaitingAnnotations: wrote ? false : current.awaitingAnnotations,
        };
        return next;
      });
    },
    [annotationsForDisplay, locale]
  );

  /** Wait for a preclassified claim's DB row, and resolve with its id.
   *
   *  A claim typed into this tab is created by the preclassify worker's DB pipeline —
   *  embed, match, link, insert — which runs detached in ctx.waitUntil AFTER the claim text
   *  has already streamed. So at the moment this tab holds the claim it holds no row id, and
   *  the research it is about to launch has nothing to name but the claim text:
   *  start_claim_classification then looks the row up by text and, if the insert has not
   *  landed yet, raises "Claim not found for the provided parameters" — while Flow A's
   *  get_annotation_context fails the same lookup for the same reason (no_claim), which is
   *  the second half of the same bug: no row, so no annotations, and no error anyone sees.
   *
   *  The tweet subscription is the signal that the row landed, so this is where the popup
   *  waits for it. The on-page flow does exactly this, and waits the same 2s
   *  (pullClaimBeforeClassify → awaitClaimDbRow in background.ts).
   *
   *  Null on timeout, and the caller carries on as before. Waiting forever would be worse
   *  than a text match that misses: the row may never arrive, and research that never starts
   *  is a spinner with no end. */
  const waitForClaimRow = useCallback(
    (hash: string, claim: FactCheckClaimState, timeoutMs: number): Promise<string | null> => {
      if (!hash || claim.dbClaimId) return Promise.resolve(claim.dbClaimId ?? null);
      // Already broadcast while the caller was doing something else — the same name test
      // claimRowIs makes, since that is the only thing naming this claim until it has an id.
      const known = claimRowsSeenRef.current
        .get(hash)
        ?.find((row) => namesIncludeClaim(row.names, claim));
      if (known) return Promise.resolve(known.id);
      return new Promise((resolve) => {
        const waiter: ClaimRowWaiter = {
          hash,
          claim,
          resolve: (id) => resolve(id),
          timer: window.setTimeout(() => {
            claimRowWaitersRef.current.delete(waiter);
            resolve(null);
          }, timeoutMs),
        };
        claimRowWaitersRef.current.add(waiter);
      });
    },
    []
  );

  /** Open a NEW tweet subscription for this hash. Always new — never a handle this tab
   *  already holds, however alive it looks.
   *
   *  What a subscription actually needs is a routing row (internal.broadcasts): every
   *  trigger that can reach this tab finds its audience by looking one up, and only a NEW
   *  subscription writes one. A handle is not a routing row, and the two do not die
   *  together — trg_tweet_preclassification_complete DELETES the tweet's routing rows the
   *  moment preclassification finishes, while the subscription row it leaves behind (which
   *  is all the client can observe, via DELETE on public.subscriptions) survives until
   *  close_after. So a reused handle reports isClosed() === false while being permanently
   *  inert, and every write it was supposed to relay is dropped in silence.
   *
   *  That is not hypothetical here: the popup subscribes during preclassification, on the
   *  far side of that teardown, so its first handle is always dead by the time research runs.
   *  The on-page equivalent (ensureAnnotationSubscription in background.ts) does reuse, and
   *  gets away with it because a human click sits between the two phases — by the time it
   *  opens, the teardown is seconds in the past and no new one is coming. This tab has no
   *  such gap, so it opens on the same condition the teardown leaves behind instead: after
   *  preclassification has certainly finished.
   *
   *  Flow A's write is what needs the route — it annotates in ctx.waitUntil once the research
   *  stream has closed, so unlike the streamed verdict it has no connection to answer on. */
  const openAnnotationSubscription = useCallback(
    async (hash: string) => {
      if (!hash) return;
      const existing = tweetSubsRef.current.get(hash);
      if (existing) {
        existing.close();
        tweetSubsRef.current.delete(hash);
      }
      let handleRef: SubscriptionHandle | null = null;
      const handle = await subscribeRow({
        kind: 'tweet',
        hash,
        timeoutMs: ANNOTATION_TIMEOUT_MS,
        onClaim: (payload) => mergeAnnotationPayload(hash, payload),
        onDone: () => {
          if (tweetSubsRef.current.get(hash) === handleRef) tweetSubsRef.current.delete(hash);
        },
      });
      handleRef = handle;
      if (handle) tweetSubsRef.current.set(hash, handle);
    },
    [mergeAnnotationPayload]
  );

  /** Close every open annotation subscription and forget them. Called when the tab empties
   *  and on unmount — the popup document's death takes the socket with it, but a tab that
   *  was cleared or left while a subscription was open should not hold one open behind it. */
  const closeTweetSubscriptions = useCallback(() => {
    for (const handle of tweetSubsRef.current.values()) handle.close();
    tweetSubsRef.current.clear();
  }, []);

  useEffect(() => closeTweetSubscriptions, [closeTweetSubscriptions]);

  /** Forget every pending annotation wait. Called wherever the claims those waits belong to
   *  are replaced — a timer armed for a claim at index 0 must not end the wait of whatever
   *  claim has since taken that index. */
  const clearAwaitingTimers = useCallback(() => {
    for (const timer of awaitingTimersRef.current.values()) window.clearTimeout(timer);
    awaitingTimersRef.current.clear();
  }, []);

  useEffect(() => clearAwaitingTimers, [clearAwaitingTimers]);

  /** Mark a claim as waiting for Flow A's annotation write, and end the wait once that write
   *  has had its window.
   *
   *  Flow A annotates a freshly researched claim server-side in ctx.waitUntil — silently,
   *  and after the research stream has already closed — so between the verdict landing and
   *  the write arriving the claim is settled, keyless, and offering an Annotate button for a
   *  run that is on its way. Past the window the button comes back, so a write that never
   *  landed doesn't leave a claim that can never be annotated. A payload carrying annotations
   *  ends the wait early (see mergeAnnotationPayload). */
  const markAwaitingAnnotations = useCallback((index: number) => {
    setClaims((prev) => {
      if (index >= prev.length) return prev;
      const next = [...prev];
      next[index] = { ...next[index], awaitingAnnotations: true };
      return next;
    });
    const existing = awaitingTimersRef.current.get(index);
    if (existing !== undefined) window.clearTimeout(existing);
    awaitingTimersRef.current.set(
      index,
      window.setTimeout(() => {
        awaitingTimersRef.current.delete(index);
        setClaims((prev) => {
          if (index >= prev.length) return prev;
          const next = [...prev];
          next[index] = { ...next[index], awaitingAnnotations: false };
          return next;
        });
      }, ANNOTATE_AUTO_PENDING_TIMEOUT_MS)
    );
  }, []);

  /** Read back the annotations of a restored claim that is settled and shows the Annotate
   *  button anyway.
   *
   *  That state is reachable without anything failing: Flow A annotates server-side after the
   *  popup that asked for it is gone, and closing the popup tears down the subscription that
   *  was waiting for the write. What was persisted is then a claim offering Annotate for
   *  annotations the DB already holds. Reopening is this tab's version of the on-page client
   *  re-reading a tweet it reveals, so it reads them back here too. */
  useEffect(() => {
    if (!restoredClaims) return;
    if (!tweetHash) return;
    setRestoredClaims(null);
    let live = true;
    void (async () => {
      try {
        const refetch = await fetchTweetAndTouchNetwork(tweetHash);
        if (!live || !refetch) return;
        setClaims((prev) =>
          prev.map((claim) => {
            const row = refetch.claims.find((c) =>
              claimRowIs(c, claim, locale, inputTextRef.current)
            );
            if (!row) return claim;
            const annotations = annotationsForDisplay(row.annotations);
            return {
              ...claim,
              dbClaimId: claim.dbClaimId ?? row.id,
              annotations,
              missingAnnotations: !(annotations && Object.keys(annotations).length > 0),
            };
          })
        );
      } catch (err) {
        console.error('[FactCheckTab] Annotation reconcile failed:', err);
      }
    })();
    return () => { live = false; };
  }, [restoredClaims, tweetHash, locale, annotationsForDisplay]);

  // ── Onboarding disclaimers ──
  // The same two storage keys, and the same type strings the on-page charge buttons carry
  // in data-mf-charge (utils/injecting.ts). A disclaimer here is shown only while its
  // on-page popover would be, and clicking the button behind one retires it for both — the
  // content script watches these keys, so its popover goes away with the click.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [onboardingClicked, setOnboardingClicked] = useState<string[]>([]);
  const onboardingClickedRef = useRef<string[]>([]);
  onboardingClickedRef.current = onboardingClicked;

  useEffect(() => {
    let live = true;
    try {
      browser.storage.local
        .get([ONBOARD_DISMISS_KEY, ONBOARD_CLICKED_KEY])
        .then((res: any) => {
          if (!live) return;
          setOnboardingDismissed(res?.[ONBOARD_DISMISS_KEY] === true);
          const stored: string[] = Array.isArray(res?.[ONBOARD_CLICKED_KEY])
            ? res[ONBOARD_CLICKED_KEY].map(String)
            : [];
          // Merge, don't replace: a button clicked before this read resolved must not have
          // its type re-opened by a stored value that predates the click.
          setOnboardingClicked((prev) => Array.from(new Set([...stored, ...prev])));
        })
        // Advisory only. A read that fails leaves every disclaimer up, which is what a
        // fresh install looks like — the same default the on-page loader falls back to.
        .catch(() => {});
    } catch { /* ignore */ }
    return () => { live = false; };
  }, []);

  const onboardingActive = (type: string) =>
    !onboardingDismissed && !onboardingClicked.includes(type);

  /** Retire a disclaimer by using what it warns about. Marked on click, whatever the run
   *  does afterwards — the on-page buttons mark the same way, so a failed run still counts
   *  as having shown this user what the button costs. */
  const markOnboardingClicked = useCallback((type: string) => {
    if (onboardingClickedRef.current.includes(type)) return;
    const next = [...onboardingClickedRef.current, type];
    onboardingClickedRef.current = next;
    setOnboardingClicked(next);
    try { void browser.storage.local.set({ [ONBOARD_CLICKED_KEY]: next }); } catch { /* ignore */ }
  }, []);

  // Combined annotations from all classified claims to render on the full text
  const combinedAnnotations = React.useMemo(() => {
    const map: Record<string, string> = {};
    claims.forEach((c) => {
      if (c.annotations && typeof c.annotations === 'object') {
        for (const [key, val] of Object.entries(c.annotations)) {
          if (typeof val === 'string') {
            map[key] = val;
          } else if (val && typeof val === 'object') {
            for (const [k, v] of Object.entries(val)) {
              if (typeof v === 'string') map[k] = v;
            }
          }
        }
      }
    });
    return Object.keys(map).length > 0 ? map : undefined;
  }, [claims]);

  // Has at least one claim classified without needing reclassification
  const hasFreshClassifiedClaim = claims.some(
    (c) => c.isClassified && !c.needsReclassify
  );

  // Re-measure on every change that can change the text area's contents or swap it for the
  // annotated view. Its height is inline, so it survives the element being replaced — a
  // stale number would outlive the text it was measured for.
  useEffect(() => {
    adjustTextareaHeight();
  }, [inputText, isEditing, hasFreshClassifiedClaim, adjustTextareaHeight]);

  // A measurement is only good for the width it was taken at: the moment the field is a
  // different width the text wraps differently, and a height left over from a narrower
  // layout is an empty second line again. Re-measure on width changes only — the observer
  // sees every height this code sets, and reacting to those would loop.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      adjustTextareaHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [adjustTextareaHeight, isEditing, hasFreshClassifiedClaim]);

  // The Disinfact button and its disclaimer stay up for as long as there is text to run on.
  // It used to disappear once claims were showing, which hid a real action: re-runs are
  // possible — the claim set can move, and a second reading costs a second charge — so the
  // button now only changes shape. It carries the refresh icon while the text under it is
  // the text it already ran on; editing the text drops the icon, because then the click
  // would be a first run like any other.
  const showDisinfactButton = inputText.trim().length > 0;
  const isRedisinfact =
    claims.length > 0 && inputText.trim() === lastPreclassifiedText.trim();

  // Handle Disinfact preclassification
  const handleDisinfact = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isBusy) return;

    markOnboardingClicked('disinfact');
    setIsBusy(true);
    setBusyMessage(t('researchingText') || 'Processing…');
    setActiveClaimIndex(null);
    setRunError(null);
    // The claims below replace whatever this tab was showing, so the annotation waits armed
    // for those claims go with them — a timer left running would end the wait of whichever
    // claim lands at the same index here.
    clearAwaitingTimers();

    try {
      const tweetId = `popup_${Date.now()}`;
      // The worker validates its input as a tweet and re-derives the hash from `username` +
      // `fullText`. A claim typed here has no tweet behind it, so the claim itself stands in as
      // one — with no author and no account standing, because there genuinely is neither. Empty
      // rather than a stand-in name, which also keys the cache on the claim text alone, so the
      // same claim fact-checked by anyone shares one result.
      //
      // `text` and `fullText` are NOT empty: they are the text the model fact-checks and the
      // text its highlight offsets are measured against. An empty `fullText` would leave the
      // model nothing to check, which is the one thing emptier than the request that failed.
      const factCheckInput: ClaimInput = {
        id: tweetId,
        text: trimmed,
        fullText: trimmed,
        username: '',
        usertype: '',
        quoting: null,
        replyingTo: null,
      };

      const hash = await computeTweetHash(factCheckInput);
      setTweetHash(hash);
      const byteaHash = hashToBytea(hash);

      // ── Step 1: Check DB FIRST for a match of this raw paragraph/tweet ──
      let foundDbClaims = false;
      try {
        // Not on a re-Disinfact: the refresh-icon button is a deliberate re-run of the same
        // text (see isRedisinfact), and this read would answer it with the rows this tab is
        // already showing — the click would come back with nothing to show, which is what a
        // dead button looks like. The on-page equivalent (the "Re-reveal this tweet's
        // claims" button) dropped its DB check for the same reason. So the run goes ahead:
        // preclassification re-derives the claims and re-links them, and the rows it links
        // to are folded back in below, so the verdicts the tab was showing return with them.
        const tweetResult = isRedisinfact ? null : await fetchTweetAndTouchNetwork(hash);
        if (tweetResult && tweetResult.claims.length > 0) {
          // DB match found! Populate claims directly from the DB without running preClassify
          const dbClaims: FactCheckClaimState[] = tweetResult.claims.map((dc) => {
            let range: [number, number] | undefined;
            if (dc.highlight) {
              const locKey = Object.keys(dc.highlight)[0];
              if (locKey) range = dc.highlight[locKey];
            }
            const raw =
              range && range[0] < range[1] && range[1] <= trimmed.length
                ? trimmed.slice(range[0], range[1])
                : typeof dc.claim === 'string'
                ? dc.claim
                : (dc.claim as any)?.[locale] || Object.values(dc.claim || {})[0] || trimmed;

            const rewritten =
              typeof dc.claim === 'string'
                ? dc.claim
                : (dc.claim as any)?.[locale] || Object.values(dc.claim || {})[0] || raw;

            const hasReasoning =
              typeof dc.reasoning === 'string'
                ? dc.reasoning.trim().length > 0
                : dc.reasoning && Object.keys(dc.reasoning).length > 0;

            const reasoningStr =
              typeof dc.reasoning === 'string'
                ? dc.reasoning
                : (dc.reasoning as any)?.[locale] || Object.values(dc.reasoning || {})[0] || '';

            const sourcesList: Source[] = Array.isArray(dc.sources)
              ? dc.sources
              : dc.sources && typeof dc.sources === 'object'
              ? Object.entries(dc.sources).map(([title, url]) => ({ title, url: String(url) }))
              : [];

            const claimAnnotations = annotationsForDisplay(dc.annotations);
            const hasAnnotations = !!claimAnnotations;

            const claimLocale = storedLocale(dc.claim, locale);
            const reasoningLocale = storedLocale(dc.reasoning, locale);

            if (hasReasoning) {
              if (dc.reclassify) {
                return {
                  rawText: raw,
                  rewritten,
                  range,
                  dbClaimId: dc.id,
                  needsReclassify: true,
                  isClassified: false,
                  missingAnnotations: !hasAnnotations,
                  cachedResult: {
                    veracity: dc.veracity,
                    confidence: dc.probability ?? Math.abs(dc.veracity ?? 0),
                    reasoning: reasoningStr,
                    sources: sourcesList,
                  },
                  annotations: claimAnnotations,
                  claimLocale,
                  reasoningLocale,
                };
              } else {
                return {
                  rawText: raw,
                  rewritten,
                  range,
                  dbClaimId: dc.id,
                  needsReclassify: false,
                  isClassified: true,
                  missingAnnotations: !hasAnnotations,
                  veracity: dc.veracity,
                  confidence: dc.probability ?? Math.abs(dc.veracity ?? 0),
                  reasoning: reasoningStr,
                  sources: sourcesList,
                  annotations: claimAnnotations,
                  claimLocale,
                  reasoningLocale,
                };
              }
            } else {
              return {
                rawText: raw,
                rewritten,
                range,
                dbClaimId: dc.id,
                needsReclassify: false,
                isClassified: false,
                missingAnnotations: false,
                claimLocale,
              };
            }
          });

          setClaims(dbClaims);
          const dbCls = {
            id: tweetResult.tweetId || `popup_${Date.now()}`,
            batchId: 'popup_db_batch',
            claims: dbClaims.map((c) => ({
              text: c.rawText,
              rewritten: c.rewritten,
              verdict: c.isClassified
                ? c.veracity
                  ? c.veracity > 0
                    ? 'true'
                    : 'false'
                  : 'research required'
                : 'research required',
              note: c.reasoning || null,
              veracity: c.veracity,
              confidence: c.confidence,
              sources: c.sources,
              annotations: c.annotations,
              dbClaimId: c.dbClaimId,
            })),
            quoting: null,
          } as any;
          setClassificationObj(dbCls);
          setLastPreclassifiedText(trimmed);
          setIsEditing(false);
          foundDbClaims = true;

          // A lone claim skips the second click: classify it right away unless the DB
          // already holds a settled verdict for it.
          if (dbClaims.length === 1 && (!dbClaims[0].isClassified || dbClaims[0].needsReclassify)) {
            setBusyMessage(t('researchingText') || 'Fact-Checking…');
            setActiveClaimIndex(0);
            await classifyClaim(0, dbClaims[0], dbCls, { hash, text: trimmed, allClaims: dbClaims });
          }
        }
      } catch (dbErr) {
        console.error('[FactCheckTab] DB check before preclassification failed:', dbErr);
      }

      // ── Step 2: If NOT in DB, run preClassify ──
      if (!foundDbClaims) {
        const stream = preClassify(factCheckInput, byteaHash, locale, locale);

        // Put the worker request on the wire FIRST, then open the subscription alongside it.
        // An async generator runs nothing until its first next(), so the line above sends no
        // request at all — this is the line that starts it. Nothing is awaited on the
        // subscription either, so it delays the request by however long a synchronous call
        // takes and not a microsecond more; the ordering is here to keep the request first,
        // not to make it wait.
        //
        // It has to be open before the worker's claim insert, which is what the routing row
        // is for: subscribe parks a tweet that does not exist yet on its hash and
        // insert_tweet resolves it into a real routing row, and that row is the only way the
        // claim-row broadcast — the one carrying the id waitForClaimRow waits for — can
        // reach this tab. The worker will not insert anything until an LLM pass that has not
        // started yet, so a few milliseconds either way is nothing against that.
        const head = stream.next();
        openAnnotationSubscription(hash).catch((e) =>
          console.error('[FactCheckTab] annotation subscription failed:', e)
        );

        let latestCls: Classification | null = null;
        for (let chunk = await head; !chunk.done; chunk = await stream.next()) {
          latestCls = chunk.value;
        }

        setClassificationObj(latestCls);
        setLastPreclassifiedText(trimmed);
        setIsEditing(false);

        if (latestCls?.claims && latestCls.claims.length > 0) {
          // Build initial claim states
          const initialClaims: FactCheckClaimState[] = latestCls.claims.map((cl) => {
            let range: [number, number] | undefined;
            if (cl.highlight) {
              const locKey = Object.keys(cl.highlight)[0];
              if (locKey) range = cl.highlight[locKey];
            }
            return {
              rawText: cl.text,
              rewritten: cl.rewritten || cl.text,
              range,
              dbClaimId: cl.dbClaimId,
              isClassified: false,
              needsReclassify: false,
              // The preclassifier rewrites claims in the UI locale and does not annotate
              // them, so it hands back no annotation key — which is "never annotated",
              // not "annotated and clean". Hardcoding false here is what left a claim with
              // no annotations and no Annotate button to ask for them.
              missingAnnotations: !(cl.annotations && Object.keys(cl.annotations).length > 0),
              veracity: cl.veracity,
              confidence: cl.confidence,
              reasoning: cl.note || undefined,
              sources: cl.sources,
              annotations: cl.annotations,
              claimLocale: locale,
              reasoningLocale: cl.note ? locale : undefined,
            };
          });

          setClaims(initialClaims);

          // Rows this text already has. Preclassification answers a claim it already knows
          // by LINKING to the row that holds it — and on a re-Disinfact those are the very
          // rows the tab was showing — and a verdict the DB holds is not one to ask for
          // again.
          //
          // Read only where it can hold something. A lone claim always reads: that is how it
          // avoids researching a claim the DB has already settled, and it is also the read
          // that catches a link still being written (see below). A re-Disinfact reads for the
          // same reason it re-runs at all: to get back the verdicts it was showing, which
          // preclassification does not return (makePreclassification yields claims with no
          // verdict and no id). A fresh multi-claim run does neither — Step 1 has just asked
          // the DB for this hash's rows, found none, and there were no verdicts to restore —
          // so it skips the read, which is metered: fetch_tweet_and_touch_network bills a
          // fetch against a rate limit that ends in a ban. What it gives up by skipping is the
          // read, not the row: the link the worker writes still arrives over the
          // subscription, and the wait below is where it is picked up.
          //
          // The tweet lookup, not get_full_claim: that RPC's row carries no annotations
          // column at all, so a claim that had already been annotated came back looking
          // untouched — the Annotate button reappeared on a claim the DB says was reviewed,
          // which is the same defect the Flow A refetch below fixes. This RPC carries the
          // per-link annotations (and the highlight) alongside the verdict.
          let rows: ClaimPayload[] = [];
          if (isRedisinfact || initialClaims.length === 1) {
            try {
              rows = (await fetchTweetAndTouchNetwork(hash))?.claims ?? [];
            } catch (dbErr) {
              console.error('[FactCheckTab] DB check after preclassification failed:', dbErr);
            }
          }
          const rowFor = (claim: FactCheckClaimState) =>
            rows.find((row) => claimRowIs(row, claim, locale, trimmed));

          // What makes a row an answer worth taking. Reasoning is what a verdict is made of —
          // the preclassifier's own insert writes the row with veracity 0 and no reasoning, so
          // "a row exists" is not "the claim is answered" — and `reclassify` is a row that has
          // expired: a result to keep showing while a fresh run lands, not a claim to call done.
          const rowHasReasoning = (row: ClaimPayload | undefined): boolean =>
            typeof row?.reasoning === 'string'
              ? row.reasoning.trim().length > 0
              : !!row?.reasoning && Object.keys(row.reasoning).length > 0;
          const rowAnswers = (row: ClaimPayload | undefined): boolean =>
            rowHasReasoning(row) && !row?.reclassify;

          // What a row does to a claim — whichever way the row arrived, and whichever claim it
          // is. Pure, so the state updater below may run it twice. One function for every path,
          // because these shapes have to agree: a row that settles a claim standing alone has to
          // settle the same claim standing second in a list of four.
          const foldRow = (
            claim: FactCheckClaimState,
            row: ClaimPayload | undefined
          ): FactCheckClaimState => {
            if (!row || !rowHasReasoning(row)) return claim;
            const fields = claimFieldsFromRow(row);
            return row.reclassify
              ? // Past its reclassification date and still the best verdict there is: it stays
                // on screen — marked stale, with the re-research affordance the DB-hit path
                // gives it — rather than as a claim never researched. (See classifyClaim, which
                // shows this cached result while the fresh run lands.)
                {
                  ...claim,
                  ...fields,
                  cachedResult: {
                    veracity: fields.veracity,
                    confidence: fields.confidence,
                    reasoning: fields.reasoning,
                    sources: fields.sources,
                  },
                  needsReclassify: true,
                }
              : { ...claim, ...fields, isClassified: true, needsReclassify: false };
          };

          setClaims((prev) => prev.map((claim) => foldRow(claim, rowFor(claim))));

          // A claim the read did not answer may still have a row on the way, and waiting for it
          // is what keeps this tab from paying for a verdict the DB already holds.
          // Preclassification answers by LINKING, and the write that links — the worker's claim
          // insert — runs detached from the stream this tab just consumed, so the read above can
          // beat it and a claim the DB holds reads as untouched. Researching on that reading is
          // not a wasted round trip: it is a charge for a verdict that already exists, and it
          // brings Flow A's silent annotation along with it. The claim-row broadcast is that
          // write landing, so wait for it and adopt what it carries. (Adopted rather than
          // re-read: the payload IS the row, annotations and all.)
          //
          // Every claim, not just the lone one — and that is the fix, not a generalisation for
          // its own sake. This wait used to sit inside an `initialClaims.length === 1` branch,
          // so a fresh multi-claim run had no cover at all: its read is skipped as metered, and
          // the wait did not reach it either, which is why two claims the DB already held came
          // back with both unanswered while the worker's log showed matchedId and
          // link_tweet_claim OK for each. A wait is a broadcast, not a request, so widening it
          // costs the rate limit nothing.
          //
          // Concurrently, because the wait is a fixed window whenever no row arrives: a text
          // with four unrun claims would otherwise sit behind four of these in a row. They all
          // resolve against the same subscription, and a payload answers whichever waiter it
          // describes.
          const arrived: ClaimPayload[] = [];
          await Promise.all(
            initialClaims
              .filter((claim) => !rowFor(claim))
              .map(async (claim) => {
                const id = await waitForClaimRow(hash, claim, CLAIM_DB_ROW_TIMEOUT_MS);
                const row = id
                  ? claimRowsSeenRef.current.get(hash)?.find((seen) => seen.id === id)?.row
                  : undefined;
                if (row) arrived.push(row);
              })
          );
          // Matched on the link's highlight as well as the row's text (claimRowIs): the linked
          // row keeps the wording of whichever tweet first researched it, and that row is this
          // claim's verdict — and the id that lets the research, and Flow A after it, name the
          // row instead of the new wording, which matches none. Missing it is not a missed
          // optimisation: the run then goes out id-less, and both lookups that follow fail on
          // text that was never stored.
          if (arrived.length > 0) {
            setClaims((prev) =>
              prev.map((claim) => {
                const row = arrived.find((r) => claimRowIs(r, claim, locale, trimmed));
                return row ? foldRow(claim, row) : claim;
              })
            );
          }

          // A lone claim skips the second click — but a settled row for it settles it here. The
          // wait above has already given it every chance a row has, so what is left is what the
          // DB has: an answer and nothing to do, a stale answer to re-run, or a claim genuinely
          // never researched. Several claims are left to the user, as this tab does with any
          // claim it did not set out to research.
          if (initialClaims.length === 1) {
            const row =
              rowFor(initialClaims[0]) ??
              arrived.find((r) => claimRowIs(r, initialClaims[0], locale, trimmed));
            if (!rowAnswers(row)) {
              setBusyMessage(t('researchingText') || 'Fact-Checking…');
              setActiveClaimIndex(0);
              // The folded claim, so a stale row reaches classifyClaim as the cached result it
              // is — and so its id travels: a reclassification re-runs the row that exists, and
              // an id-less run makes both lookups that follow fail on text never stored.
              await classifyClaim(0, foldRow(initialClaims[0], row), latestCls, {
                hash,
                text: trimmed,
                allClaims: initialClaims,
              });
            }
          }
        } else {
          setClaims([]);
        }
      }
    } catch (err) {
      console.error('[FactCheckTab] Disinfact error:', err);
      reportRunError(err);
    } finally {
      setIsBusy(false);
      setBusyMessage('');
    }
  };

  /** Research one claim. Touches that claim's state only — the CALLER owns the global
   *  busy flag, so an auto-triggered run can share the busy window the Disinfact call
   *  already opened (its state setters would otherwise be stale in this render). */
  const classifyClaim = async (
    index: number,
    claim: FactCheckClaimState,
    cls: Classification | null | undefined,
    opts?: { hash?: string; text?: string; allClaims?: FactCheckClaimState[] }
  ) => {
    const hash = opts?.hash ?? tweetHash;
    const sourceText = opts?.text ?? inputText;

    // If it needs reclassification, temporarily display the cached results while fresh research runs
    if (claim.needsReclassify && claim.cachedResult) {
      setClaims((prev) => {
        const next = [...prev];
        next[index] = {
          ...next[index],
          veracity: claim.cachedResult?.veracity,
          confidence: claim.cachedResult?.confidence,
          reasoning: claim.cachedResult?.reasoning,
          sources: claim.cachedResult?.sources,
        };
        return next;
      });
    }

    try {
      // Name the claim before researching it. A claim the preclassifier has just created
      // has no id yet — its row is written by a pipeline running detached from the stream
      // this tab already read — so wait for the subscription to carry it, rather than
      // letting the worker look the row up by text and lose that race.
      // (See waitForClaimRow; the on-page flow waits the same way.)
      const dbClaimId =
        claim.dbClaimId ??
        (await waitForClaimRow(hash, claim, CLAIM_DB_ROW_TIMEOUT_MS)) ??
        undefined;
      if (dbClaimId && dbClaimId !== claim.dbClaimId) {
        setClaims((prev) => {
          const next = [...prev];
          if (index < next.length) next[index] = { ...next[index], dbClaimId };
          return next;
        });
      }
      /** This classification with the claim's id attached, so refreshClaim hands the worker
       *  an exact row to attach the research to instead of the text it matches on otherwise. */
      const withClaimId = (c: { text?: string; dbClaimId?: string | null }) =>
        dbClaimId && c.text === claim.rawText ? { ...c, dbClaimId } : c;

      const baseCls = cls || {
        id: `popup_${Date.now()}`,
        batchId: 'popup_batch',
        claims: (opts?.allClaims ?? claims).map((c) => ({
          text: c.rawText,
          rewritten: c.rewritten,
          verdict: 'research required',
          note: null,
          dbClaimId: c.dbClaimId,
        })),
        quoting: null,
      };
      const clsToUse = { ...baseCls, claims: baseCls.claims?.map(withClaimId) };

      const researchCache = new Map<string, any>();
      const annotLocators = {
        tweetHash: hash,
        tweetText: sourceText,
        textLocale: locale,
        claimIndex: index,
      };

      const stream = refreshClaim(
        clsToUse as any,
        claim.rawText,
        researchCache,
        locale,
        undefined,
        undefined,
        annotLocators
      );

      let sawUpdate = false;
      for await (const updatedCls of stream) {
        sawUpdate = true;
        const found = updatedCls.claims?.find(
          (c) => c.text === claim.rawText || c.rewritten === claim.rewritten
        );
        if (found) {
          setClaims((prev) => {
            const next = [...prev];
            next[index] = {
              ...next[index],
              isClassified: true,
              needsReclassify: false,
              veracity: found.veracity,
              confidence: found.confidence,
              reasoning: found.note || next[index].reasoning,
              // Research writes its reasoning in the UI locale; a claim that kept the
              // reasoning it already had keeps the locale that goes with it.
              reasoningLocale: found.note ? locale : next[index].reasoningLocale,
              sources: found.sources || next[index].sources,
            };
            return next;
          });
        }
      }

      // A stream that ends without yielding once said nothing at all. streamResearch
      // yields nothing when the worker's answer carries no verdict it can read, and
      // returns without throwing — so the click left no badge change, no error and no
      // explanation: it simply looked like the button did nothing. Say so instead. A
      // worker refusal (a 4xx) is a different case: streamResearch reports it through the
      // sink above, and the banner is already up.
      if (!sawUpdate) {
        setRunError(tRef.current('errServiceUnavailable'));
      }

      // Annotations. Flow A writes them server-side in ctx.waitUntil, after this stream has
      // closed, so they never appear on the stream this component reads and there is nothing
      // to await — the write arrives afterwards, over the subscription, and mergeAnnotationPayload
      // folds it into this claim. Opening that subscription HERE, and not before research, is
      // the point: the routing row it creates has to outlive the one
      // trg_tweet_preclassification_complete deletes, and the only moment that is certainly
      // past is this one — the popup's classify runs within a round trip of that teardown,
      // while Flow A is still an LLM pass away. (openAnnotationSubscription explains why a
      // handle opened earlier cannot simply be reused — this call closes that one and takes
      // its place.)
      //
      // Reading the row back from the DB here would not do instead: the read would fire the
      // instant this stream ends, while Flow A is still making its second LLM call, so it
      // would answer with the pre-annotation row every time.
      openAnnotationSubscription(hash).catch((e) =>
        console.error('[FactCheckTab] annotation subscription failed:', e)
      );

      // And say so on the claim itself: research that ran with locators is research Flow A
      // will annotate, so until its write lands this claim must not offer to buy an
      // annotation run that is already in flight. See markAwaitingAnnotations.
      if (!claim.annotations || Object.keys(claim.annotations).length === 0) {
        markAwaitingAnnotations(index);
      }
    } catch (err) {
      console.error('[FactCheckTab] Fact-check error:', err);
      reportRunError(err);
    }
  };

  // Fact-Check specific claim
  const handleFactCheckClaim = async (
    index: number,
    override?: { claim?: FactCheckClaimState; cls?: Classification | null }
  ) => {
    const claim = override?.claim ?? claims[index];
    if (!claim || isBusy) return;

    markOnboardingClicked('factcheck');
    setIsBusy(true);
    setActiveClaimIndex(index);
    setBusyMessage(t('researchingText') || 'Fact-Checking…');
    setRunError(null);

    try {
      await classifyClaim(index, claim, override?.cls ?? classificationObj);
    } finally {
      setIsBusy(false);
      setActiveClaimIndex(null);
      setBusyMessage('');
    }
  };

  // Annotate specific claim (Flow B)
  const handleAnnotateClaim = async (index: number) => {
    const claim = claims[index];
    if (!claim || isBusy) return;

    markOnboardingClicked('annotate');
    setIsBusy(true);
    setActiveClaimIndex(index);
    setBusyMessage(t('annotatingText') || 'Annotating…');
    setRunError(null);

    try {
      const result = await backgroundAnnotate(
        tweetHash,
        inputText,
        locale,
        claim.dbClaimId,
        index,
        locale,
        (partial) => {
          setClaims((prev) => {
            const next = [...prev];
            next[index] = {
              ...next[index],
              annotations: { [locale]: partial },
            };
            return next;
          });
        }
      );

      if (result) {
        setClaims((prev) => {
          const next = [...prev];
          next[index] = {
            ...next[index],
            // Keyed by locale like the DB's own column, so both outcomes keep their
            // meaning: ranges to paint, or an empty dict under a locale key — the
            // worker's "annotated, nothing wrong", which is a reviewed claim and not an
            // unchecked one.
            annotations: { [locale]: result },
            missingAnnotations: false,
          };
          return next;
        });
      }
    } catch (err) {
      console.error('[FactCheckTab] Annotate error:', err);
      reportRunError(err);
    } finally {
      setIsBusy(false);
      setActiveClaimIndex(null);
      setBusyMessage('');
    }
  };

  // Translate rewritten claim
  const handleTranslateRewritten = async (index: number) => {
    const claim = claims[index];
    if (!claim || isBusy) return;

    markOnboardingClicked('translate-inner');
    setIsBusy(true);
    setActiveClaimIndex(index);
    setBusyMessage(t('processing') || 'Translating…');
    setRunError(null);

    try {
      const targetLang = locale.split('-')[0];
      const translated = await translateText(
        claim.rewritten,
        targetLang,
        (partial) => {
          setClaims((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], rewritten: partial };
            return next;
          });
        },
        'https://translate-claim.michael-pouget01.workers.dev/',
        { claim: claim.rewritten, source_locale: claim.claimLocale || 'auto' }
      );

      if (translated) {
        setClaims((prev) => {
          const next = [...prev];
          next[index] = {
            ...next[index],
            rewritten: translated,
            claimLocale: targetLang,
          };
          return next;
        });
      }
    } catch (err) {
      console.error('[FactCheckTab] Translate rewritten error:', err);
      reportRunError(err);
    } finally {
      setIsBusy(false);
      setActiveClaimIndex(null);
      setBusyMessage('');
    }
  };

  // Translate reasoning
  const handleTranslateReasoning = async (index: number) => {
    const claim = claims[index];
    if (!claim || !claim.reasoning || isBusy) return;

    markOnboardingClicked('translate-inner');
    setIsBusy(true);
    setActiveClaimIndex(index);
    setBusyMessage(t('processing') || 'Translating…');
    setRunError(null);

    try {
      const targetLang = locale.split('-')[0];
      const translated = await translateText(
        claim.reasoning,
        targetLang,
        (partial) => {
          setClaims((prev) => {
            const next = [...prev];
            next[index] = { ...next[index], reasoning: partial };
            return next;
          });
        },
        'https://translate-reasoning.michael-pouget01.workers.dev/',
        {
          claim: claim.rewritten,
          source_locale: claim.reasoningLocale || 'auto',
        }
      );

      if (translated) {
        setClaims((prev) => {
          const next = [...prev];
          next[index] = {
            ...next[index],
            reasoning: translated,
            reasoningLocale: targetLang,
          };
          return next;
        });
      }
    } catch (err) {
      console.error('[FactCheckTab] Translate reasoning error:', err);
      reportRunError(err);
    } finally {
      setIsBusy(false);
      setActiveClaimIndex(null);
      setBusyMessage('');
    }
  };

  return (
    <div className="flex flex-col flex-1 gap-4">
      {/* ── Top Text Area / Annotated Text View ──
          The clear control rides inside the field, at the end of the line the text starts
          on, so it reads as part of the input rather than as a second column beside it. The
          text is kept clear of it by the field's own right padding, and the control stays
          in the layout while there is nothing to clear — only dimmed and inert — because a
          control that came and went would resize the field under the caret on the first
          keystroke, and the height was measured at the old width. */}
      <div className="relative w-full">
        {hasFreshClassifiedClaim && !isEditing ? (
          <div
            onClick={() => {
              setIsEditing(true);
              setTimeout(() => {
                textareaRef.current?.focus();
              }, 0);
            }}
            className="w-full min-h-[80px] p-3 pr-9 rounded-xl border border-zinc-800 bg-zinc-900/40 text-sm text-white font-medium leading-relaxed cursor-text transition-colors hover:border-zinc-700 select-text whitespace-pre-wrap break-words"
            title="Click to edit claim"
          >
            <AnnotatedText
              text={inputText}
              annotations={combinedAnnotations}
              segStart={0}
            />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              adjustTextareaHeight();
            }}
            onFocus={() => {
              setIsEditing(true);
            }}
            onKeyDown={(e) => {
              // Enter is the Disinfact button, so a claim can be run without reaching for
              // the mouse. Shift+Enter stays what it is in a text field — a newline — which
              // is what keeps a claim writable over several lines.
              //
              // A composing Return does neither: it belongs to the input method, and it is
              // what accepts a marked candidate. Submitting there would run the check against
              // half a word, with the rest of it still marked in the field.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleDisinfact();
              }
            }}
            onBlur={() => {
              // If text didn't change and we have preclassified claims, exit editing
              if (
                inputText.trim() === lastPreclassifiedText.trim() &&
                claims.length > 0
              ) {
                setIsEditing(false);
              }
            }}
            disabled={isBusy}
            placeholder={t('enterClaimPlaceholder') || 'Enter a claim'}
            rows={1}
            className="w-full p-3 pr-9 rounded-xl border border-zinc-800 bg-zinc-900/40 text-sm text-white font-medium placeholder-zinc-500 leading-relaxed outline-none focus:border-zinc-600 disabled:opacity-50 resize-none overflow-hidden transition-colors"
          />
        )}

        {/* Centred on the field's first line: its own height against the field's p-3
            padding plus half a leading-relaxed line of text-sm. Emptying an empty field is
            a no-op, so the control is offered only when there is something to empty — and
            then takes no pointer events at all, leaving no dead corner over the text. */}
        <button
          type="button"
          // Keep the caret where it is: without this the field blurs on mousedown, which
          // is what the Disinfact button below guards against too.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // Above the text view's own click, which would otherwise reopen the editor
            // this click is closing.
            e.stopPropagation();
            handleClearAll();
          }}
          disabled={isBusy || !hasAnythingToClear}
          title={t('clearButton')}
          aria-label={t('clearButton')}
          className="absolute right-2 top-3 p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-0 disabled:pointer-events-none"
        >
          <CloseIcon />
        </button>
      </div>

      {/* ── Disinfact Button & Disclaimer ── */}
      {showDisinfactButton && (
        <div className="flex flex-col gap-2">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleDisinfact}
            disabled={isBusy || !inputText.trim()}
            className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm transition-colors cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
          >
            {isBusy && activeClaimIndex === null ? (
              busyMessage || t('processing') || 'Disinfacting…'
            ) : (
              <>
                {isRedisinfact && <RefreshIcon />}
                {t('disinfactButton') || 'Disinfact'}
              </>
            )}
          </button>

          {onboardingActive('disinfact') && (
            <Disclaimer
              template={t('onboardDisinfactClick')}
              buttonLabel={t('disinfactButton')}
            />
          )}
        </div>
      )}

      {/* A run that produced no claims says why, here. Without this the worker's refusal —
          balance, session, an outage — landed nowhere and the tab simply went blank. */}
      {runError && (
        <div className="p-2 text-xs bg-red-950/50 border border-red-900 rounded-xl text-red-400 text-center">
          {runError}
        </div>
      )}

      {/* ── Preclassified Claims List ── */}
      {claims.length > 0 && !isEditing && (
        <div className="flex flex-col gap-3">
          {/* Top of list Fact-Check disclaimer */}
          {onboardingActive('factcheck') && (
            <Disclaimer
              template={t('onboardFactcheck')}
              buttonLabel={t('factCheckButton')}
              className="text-[11px] text-zinc-400 bg-zinc-900/40 border border-zinc-800/80 p-2 rounded-xl text-center"
            />
          )}

          {claims.map((claim, idx) => {
            const isOperating = isBusy && activeClaimIndex === idx;
            const segStart = claim.range ? claim.range[0] : 0;
            // Translate is offered only for a text in some other language than the one it is
            // being read in — the same condition the on-page popovers use. A claim the worker
            // rewrote in the UI locale has nothing to translate, and a button that is always
            // there invites a charge for a no-op.
            const canTranslateClaim =
              !!claim.claimLocale && !sameLanguage(claim.claimLocale, locale);
            const canTranslateReasoning =
              !!claim.reasoningLocale && !sameLanguage(claim.reasoningLocale, locale);
            // Research has already run for this claim, so this click runs it again.
            const isReclassification = claim.isClassified || claim.needsReclassify;

            return (
              <div
                key={idx}
                className="flex flex-col gap-2.5 p-3 rounded-xl border border-zinc-800 bg-zinc-900/30 text-left"
              >
                {/* 1. Rewritten claim text */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-white leading-snug break-words">
                      {claim.rewritten}
                    </span>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <CopyButton
                        text={claim.rewritten}
                        label={t('copyTooltip') || 'Copy'}
                      />
                      {canTranslateClaim && (
                        <button
                          onClick={() => handleTranslateRewritten(idx)}
                          disabled={isBusy}
                          title={t('translateClaimButton') || 'Translate'}
                          className="flex items-center gap-1 flex-shrink-0 px-1.5 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-40 text-[11px] font-medium whitespace-nowrap"
                        >
                          <GlobeIcon />
                          {t('translateClaimButton') || 'Translate'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Disclaimer directly below rewritten claim translation. It names the
                      button in words, matching the button itself — the globe alone left
                      the reader to guess what would be charged for. */}
                  {canTranslateClaim && onboardingActive('translate-inner') && (
                    <Disclaimer
                      template={t('onboardTranslations')}
                      buttonLabel={t('translateClaimButton')}
                      className="text-[10px] text-zinc-500 text-left"
                    />
                  )}
                </div>

                {/* 2. Raw claim text with inline annotations */}
                <div className="p-2 rounded-lg bg-zinc-950/60 border border-zinc-800/80 text-xs text-zinc-300 leading-relaxed break-words">
                  <AnnotatedText
                    text={claim.rawText}
                    annotations={claim.annotations}
                    segStart={segStart}
                  />
                  {claim.awaitingAnnotations && claim.isClassified && (
                    <div className="text-[10px] text-zinc-500">{t('annotatingText')}</div>
                  )}
                </div>

                {/* 3. Action buttons: the re-run, and Annotate beside it */}
                <div className="flex flex-col gap-1">
                  {/* Annotate is for a claim that has been researched and has no annotations
                      yet — the same gate the on-page badges use. Before research there is
                      nothing to annotate, and the worker skips such a run anyway.
                      Not while Flow A's own annotation of this claim is in flight, though
                      (awaitingAnnotations): that button would buy the run already on its way,
                      and the card says so in the claim box instead.

                      It is shown BESIDE the re-run, not instead of it as it used to be: the
                      either/or left a researched claim with no annotations yet — the one state
                      Annotate appears in — with no way to be researched again. Re-research stays
                      offered in every state; the wait can last minutes, and that is not a reason
                      to withhold it. The on-page popover has no such hole: a claim's refresh
                      control sits in its reasoning row whatever its annotation state is. */}
                  <div className="flex gap-2">
                    {claim.missingAnnotations && claim.isClassified && !claim.awaitingAnnotations && (
                      <button
                        onClick={() => handleAnnotateClaim(idx)}
                        disabled={isBusy}
                        className="flex-1 py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-medium text-xs transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                      >
                        {isOperating ? busyMessage : t('annotateButton') || 'Annotate'}
                      </button>
                    )}
                    <button
                      onClick={() => handleFactCheckClaim(idx)}
                      disabled={isBusy}
                      className="flex-1 py-1.5 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-medium text-xs transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    >
                      {/* The card's own busy text, as on the Annotate button: the popup runs one
                          operation at a time and both buttons are disabled while it does. */}
                      {isOperating ? (
                        busyMessage
                      ) : (
                        <>
                          {isReclassification && <RefreshIcon />}
                          {t('factCheckButton') || 'Fact-Check'}
                        </>
                      )}
                    </button>
                  </div>
                  {claim.missingAnnotations && claim.isClassified && !claim.awaitingAnnotations
                    && onboardingActive('annotate') && (
                    <Disclaimer
                      template={t('onboardAnnotate')}
                      buttonLabel={t('annotateButton')}
                      className="text-[10px] text-zinc-500 text-center"
                    />
                  )}
                </div>

                {/* 4. Classification Results (Verdict, Reasoning, Sources) */}
                {(claim.isClassified || (claim.needsReclassify && isOperating)) && (
                  <div className="flex flex-col gap-2 pt-2 border-t border-zinc-800/80 text-xs">
                    {/* Verdict Badge */}
                    <div className="flex items-center gap-2">
                      <VerdictBadge
                        confidence={claim.confidence}
                        veracity={claim.veracity}
                      />
                    </div>

                    {/* Reasoning */}
                    {claim.reasoning && (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">
                            {t('reasoningLabel') || 'Reasoning'}
                          </span>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <CopyButton
                              text={claim.reasoning}
                              label={t('copyTooltip') || 'Copy'}
                            />
                            {canTranslateReasoning && (
                              <button
                                onClick={() => handleTranslateReasoning(idx)}
                                disabled={isBusy}
                                title={t('translateClaimButton') || 'Translate'}
                                className="flex items-center gap-1 flex-shrink-0 px-1.5 py-0.5 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-40 text-[11px] font-medium whitespace-nowrap"
                              >
                                <GlobeIcon />
                                {t('translateClaimButton') || 'Translate'}
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="text-zinc-300 leading-relaxed whitespace-pre-wrap break-words text-xs">
                          {claim.reasoning}
                        </p>
                        {canTranslateReasoning && onboardingActive('translate-inner') && (
                          <Disclaimer
                            template={t('onboardTranslations')}
                            buttonLabel={t('translateClaimButton')}
                            className="text-[10px] text-zinc-500 text-left"
                          />
                        )}
                      </div>
                    )}

                    {/* Sources */}
                    {claim.sources && claim.sources.length > 0 && (
                      <div className="flex flex-col gap-1 pt-1 border-t border-zinc-800/50">
                        <span className="text-[10px] uppercase tracking-wider font-semibold text-zinc-400">
                          {t('sourcesLabel') || 'Sources'}
                        </span>
                        <ul className="flex flex-col gap-1">
                          {claim.sources.map((src, sIdx) => {
                            if (!src.url && !src.title) return null;
                            const title = src.title || src.url || '';
                            return (
                              <li key={sIdx} className="min-w-0">
                                {src.url ? (
                                  <SourceLink url={src.url} title={title} />
                                ) : (
                                  <span className="text-zinc-400 text-xs truncate inline-block max-w-full">
                                    {title}
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
