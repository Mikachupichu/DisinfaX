import { supabase, ensureRealtimeAuth } from './supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

/**
 * Realtime subscriptions + direct-RPC data access for the preclassification /
 * classification pipelines.
 *
 * The client GENERATES a subscription UUID, opens a Supabase Realtime channel on
 * `public.subscriptions` filtered to that id, and only THEN calls the `subscribe`
 * RPC (passing the id). Opening the channel first guarantees no early payload is
 * missed. The server writes each claim into `subscriptions.payload` (one UPDATE per
 * claim) and DELETEs the row when the tweet/claim is done — that DELETE is our
 * teardown signal, backed by a generous timeout.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Claims & tweets — subscription channels + direct RPC reads
// ─────────────────────────────────────────────────────────────────────────────

/** Normalized shape of a claim delivered by build_claim_payload (Realtime),
 *  fetch_tweet_and_touch_network, or get_full_claim. Field names differ slightly
 *  across those sources; the parsers below normalize into this. */
export interface ClaimPayload {
  /** claims.id (uuid) — the dedup key and the handle for get_full_claim / subscribe. */
  id: string;
  /** Locale-keyed claim text, e.g. {"en": "..."} (or a plain string). */
  claim: Record<string, string> | string;
  veracity: number;
  /** Present only from get_full_claim; elsewhere derive confidence from |veracity|. */
  probability?: number;
  /** True when the claim's reclassify_after has passed (change-prone). */
  reclassify?: boolean;
  /** Locale-keyed reasoning, e.g. {"en": "..."} (or a plain string / null). */
  reasoning: Record<string, string> | string | null;
  /** {url: title} dictionary (or array) of sources. */
  sources: any;
  last_classification?: string;
  /** True when another classification is currently in flight for this claim. */
  is_classifying: boolean;
  /** Locale-keyed highlight ranges {"en": [start, end]} — only on tweet-scoped payloads. */
  highlight?: Record<string, [number, number]>;
}

export interface TweetFetchResult {
  tweetId: string;
  /** True when the tweet is still being preclassified server-side (more claims to come). */
  isPreclassifying: boolean;
  claims: ClaimPayload[];
}

/** Convert a 64-char hex tweet hash into the Postgres bytea literal (`\x…`) the
 *  RPCs expect for their `bytea` hash arguments. Idempotent. */
export function hashToBytea(hexHash: string): string {
  return hexHash.startsWith('\\x') ? hexHash : `\\x${hexHash}`;
}

/** Normalize an RPC result to an array of rows. Depending on the function, Supabase
 *  hands back a jsonb array, a single row object, or null. */
function asRows(data: any): any[] {
  return Array.isArray(data) ? data : (data != null ? [data] : []);
}

/** Normalize a raw claim record (build_claim_payload / get_full_claim shape) into
 *  a ClaimPayload. `claims_localized_reasoning` (Realtime/tweet fetch) and
 *  `reasoning` (get_full_claim) both map to `reasoning`. */
function normalizeClaimRecord(raw: any, highlight?: Record<string, [number, number]>): ClaimPayload | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  return {
    id: String(raw.id),
    claim: raw.claim ?? {},
    veracity: Number(raw.veracity ?? 0),
    probability: raw.probability != null ? Number(raw.probability) : undefined,
    reclassify: raw.reclassify === true,
    reasoning: raw.claims_localized_reasoning ?? raw.reasoning ?? null,
    sources: raw.sources ?? {},
    last_classification: raw.last_classification ?? undefined,
    is_classifying: raw.is_classifying === true,
    highlight: highlight ?? raw.highlight ?? undefined,
  };
}

/** Pull a tweet and its already-linked claims directly (also touches last_accessed).
 *  Returns null when the tweet is not in the DB yet. */
export async function fetchTweetAndTouchNetwork(hexHash: string): Promise<TweetFetchResult | null> {
  console.log(`[fetches-usage] fetch_tweet_and_touch_network hash=${hexHash}`);
  const { data, error } = await supabase.rpc('fetch_tweet_and_touch_network', {
    input_hash: hashToBytea(hexHash),
  });
  if (error) {
    console.error('[realtime] fetch_tweet_and_touch_network error:', error.message);
    return null;
  }
  // An empty result (or [null]) means the tweet is not in the DB.
  const row = asRows(data)[0];
  if (!row || !row.id) return null;

  const claims: ClaimPayload[] = [];
  const tweetClaims = Array.isArray(row.tweet_claims) ? row.tweet_claims : [];
  for (const tweetClaim of tweetClaims) {
    // Each entry: { highlight, claims: {<claim fields>} }
    const highlight = (tweetClaim?.highlight && typeof tweetClaim.highlight === 'object') ? tweetClaim.highlight : undefined;
    const parsed = normalizeClaimRecord(tweetClaim?.claims, highlight);
    if (parsed) claims.push(parsed);
  }
  return {
    tweetId: String(row.id),
    isPreclassifying: row.is_preclassifying === true,
    claims,
  };
}

/** Pull a single claim directly (also touches last_accessed). Match by id, or by
 *  (locale, text), or by text across all locales. Returns null if not found. */
export async function getFullClaim(opts: { id?: string; text?: string; locale?: string }): Promise<ClaimPayload | null> {
  console.log(`[fetches-usage] get_full_claim id=${opts.id ?? 'none'} text="${(opts.text ?? '').slice(0, 40)}"`);
  const { data, error } = await supabase.rpc('get_full_claim', {
    target_id: opts.id ?? null,
    target_locale: opts.locale ?? null,
    target_text: opts.text ?? null,
  });
  if (error) {
    console.error('[realtime] get_full_claim error:', error.message);
    return null;
  }
  // get_full_claim returns a SETOF; at most one row is relevant.
  const row = asRows(data)[0];
  return row ? normalizeClaimRecord(row) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Funds (balance) — direct table subscription + get_funds RPC
// ─────────────────────────────────────────────────────────────────────────────

export interface Funds {
  balance: number;
  hold: number;
}

/** The balance the dashboard/notifications track is balance + hold, so moving money
 *  into a hold never changes the displayed amount. */
export function visibleTotal(funds: Funds | null | undefined): number {
  if (!funds) return 0;
  return (Number(funds.balance) || 0) + (Number(funds.hold) || 0);
}

function parseFundsRow(row: any): Funds | null {
  if (!row || typeof row !== 'object') return null;
  if (row.balance == null && row.hold == null) return null;
  return { balance: Number(row.balance ?? 0), hold: Number(row.hold ?? 0) };
}

/** Fetch the caller's funds row once via the get_funds RPC. */
export async function getFunds(): Promise<Funds | null> {
  const { data, error } = await supabase.rpc('get_funds');
  if (error) {
    console.error('[realtime] get_funds error:', error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return parseFundsRow(row);
}

export interface FundsSubscription {
  close: () => void;
}

/** Open a Realtime channel on public.funds for the current user. Per the flow, the
 *  caller opens this channel FIRST, then calls getFunds() once, then keeps listening.
 *  onChange fires on every funds row change (INSERT/UPDATE). */
export async function subscribeFunds(
  onChange: (funds: Funds) => void,
  onError?: (message: string) => void
): Promise<FundsSubscription | null> {
  await ensureRealtimeAuth();
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) {
    onError?.('Not signed in');
    return null;
  }

  let channel: RealtimeChannel | null = supabase
    .channel(`funds:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'funds', filter: `user_id=eq.${userId}` },
      (msg: any) => {
        const parsed = parseFundsRow(msg.new);
        if (parsed) {
          try { onChange(parsed); } catch (e) { console.error('[realtime] funds onChange error:', e); }
        }
      }
    )
    .subscribe();

  return {
    close: () => {
      if (channel) {
        try { supabase.removeChannel(channel); } catch { /* ignore */ }
        channel = null;
      }
    },
  };
}

export interface SubscriptionHandle {
  subscriptionId: string;
  close: () => void;
  /** True once the channel has been torn down (DELETE received or timed out). */
  isClosed: () => boolean;
  /** Restart the teardown timer (used when the Disinfact button is clicked while
   *  the tweet subscription is still open — keep it alive a bit longer). */
  resetTimeout: (ms: number) => void;
  /** Resolves once the channel is SUBSCRIBED and the `subscribe` RPC has been sent
   *  (or once the subscription errors/closes). Await this before fetching so no
   *  broadcast is missed in the gap between fetch and an active subscription. Never
   *  rejects — it resolves on failure too so callers never hang. */
  ready: Promise<void>;
}

export interface SubscribeOptions {
  /** 'tweet' → pass p_tweet_hash; 'claim' → pass p_claim_text / p_row_id. */
  kind: 'tweet' | 'claim';
  /** Tweet hash (hex) for kind 'tweet'. */
  hash?: string;
  /** Claim text for kind 'claim' (used when no claim id is known). */
  claimText?: string;
  /** Claim row id (uuid) for kind 'claim' — preferred over claimText when known. */
  claimId?: string;
  /** Teardown fallback if no DELETE arrives (10s preclassification, 25s classification). */
  timeoutMs: number;
  /** Called for each claim payload written to subscriptions.payload. */
  onClaim: (payload: ClaimPayload) => void;
  /** Called once when the subscription ends (row DELETEd or timed out). */
  onDone: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared subscriptions-table channel
// ─────────────────────────────────────────────────────────────────────────────
//
// Supabase Realtime manages `postgres_changes` listeners per TABLE on the server
// side. Opening one channel per logical subscription (each filtered to its own row,
// `id=eq.<subscriptionId>`) means every one of them registers its own listener on
// `public.subscriptions` — and unsubscribing ANY one of them was observed to force a
// server-side renegotiation that drops every OTHER channel still listening on that
// same table (confirmed via logging: one channel's normal, expected DELETE+unsubscribe
// was reliably followed by every sibling channel reporting CLOSED, one by one, with
// the underlying socket itself staying connected throughout — a table-level listener
// disruption, not a socket-level one). With dozens of tweets watched concurrently on
// a busy page, this meant nearly every in-flight subscription's channel got silently
// killed the moment any ONE of them finished, and its awaiting caller would just run
// out its own independent timeout with nothing ever arriving.
//
// The fix: exactly ONE channel for this table, opened once and never removed for the
// life of the service worker. Every logical "subscription" dispatches through it by
// row id instead of getting its own channel — so finishing one never touches another.
const subscriptionDispatch = new Map<string, (msg: any) => void>();
let sharedSubscriptionsChannelReady: Promise<void> | null = null;
// [ttft-ext] Monotonic counter stamped on every dispatch invocation, so two genuinely
// separate deliveries of the "same" event are visibly distinct in the console instead
// of risking DevTools collapsing identical consecutive lines into one.
let dispatchCallCounter = 0;

function ensureSharedSubscriptionsChannel(): Promise<void> {
  if (sharedSubscriptionsChannelReady) return sharedSubscriptionsChannelReady;
  sharedSubscriptionsChannelReady = new Promise<void>((resolve) => {
    supabase
      .channel('sub:shared:subscriptions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'subscriptions' },
        (msg: any) => {
          const id = msg.new?.id ?? msg.old?.id;
          if (!id) return;
          const dispatch = subscriptionDispatch.get(id);
          if (dispatch) {
            try { dispatch(msg); } catch (e) { console.error('[realtime] shared channel dispatch error:', e); }
          }
        }
      )
      .subscribe((status: string) => {
        // [ttft-ext] The one channel's status — if this ever shows CHANNEL_ERROR/
        // TIMED_OUT/CLOSED after an initial SUBSCRIBED, every pending subscription is
        // affected at once, unlike the old per-subscription channels.
        console.log(`[ttft-ext] shared subscriptions channel: status ${status}`);
        if (status === 'SUBSCRIBED') resolve();
      });
  });
  return sharedSubscriptionsChannelReady;
}

/**
 * Register a fresh subscription id against the shared subscriptions-table channel,
 * then register it server-side via the `subscribe` RPC. The dispatch entry is added
 * BEFORE the RPC call so the initial burst of existing-claim payloads is never missed.
 */
export async function subscribeRow(opts: SubscribeOptions): Promise<SubscriptionHandle | null> {
  await ensureRealtimeAuth();
  await ensureSharedSubscriptionsChannel();

  const subscriptionId = crypto.randomUUID();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Resolves once the subscription is live (dispatch registered + subscribe RPC sent)
  // or has failed/closed — callers await it before fetching. Resolve-only so it never hangs.
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    subscriptionDispatch.delete(subscriptionId);
    markReady();
  };

  const finish = () => {
    if (closed) return;
    cleanup();
    try { opts.onDone(); } catch (e) { console.error('[realtime] onDone error:', e); }
  };

  subscriptionDispatch.set(subscriptionId, (msg: any) => {
    // [ttft-ext] Every event this subscription receives, unconditionally (even once
    // closed) — distinguishes "nothing ever arrived" from "got the DELETE teardown but
    // never the earlier UPDATE with the payload". #${dispatchCallCounter} makes each
    // invocation's log line unique, so two real deliveries can't visually collapse into
    // what looks like one in the console.
    const callNum = ++dispatchCallCounter;
    console.log(`[ttft-ext] subscribeRow ${opts.kind} ${subscriptionId}: event ${msg.eventType} #${callNum}, closed=${closed}, hasPayload=${!!msg.new?.payload}`);
    if (closed) return;
    if (msg.eventType === 'DELETE') {
      finish();
      return;
    }
    // INSERT/UPDATE: emit the payload if present.
    const payload = msg.new?.payload;
    if (payload) {
      const parsed = normalizeClaimRecord(payload);
      if (parsed) {
        try { opts.onClaim(parsed); } catch (e) { console.error('[realtime] onClaim error:', e); }
      }
      // A CLAIM subscription exists to await exactly one result, and the DB stops
      // broadcasting to it once that result is delivered — so treat the payload as
      // terminal and close locally. This keeps isClosed() honest, so a later need for
      // this claim opens a fresh subscription instead of waiting on a channel that will
      // never fire again. Tweet subscriptions are left alone: more claims may still come,
      // and the client can't know when the last one has arrived.
      if (opts.kind === 'claim') finish();
    }
  });

  // Shared channel is already live at this point — register server-side.
  const args: Record<string, any> = { p_subscription_id: subscriptionId };
  if (opts.kind === 'tweet') {
    args.p_tweet_hash = opts.hash ? hashToBytea(opts.hash) : null;
  } else if (opts.claimId) {
    args.p_row_id = opts.claimId;
    args.p_table = 'claims';
  } else {
    args.p_claim_text = opts.claimText ?? null;
  }

  try {
    console.log(`[fetches-usage] subscribe kind=${opts.kind} hash=${opts.hash ?? 'none'} claimId=${opts.claimId ?? 'none'} claimText="${(opts.claimText ?? '').slice(0, 40)}"`);
    const { error } = await supabase.rpc('subscribe', args);
    if (error) {
      console.error('[realtime] subscribe RPC error:', error.message);
      finish();
    } else {
      // Live and registered — callers may now fetch.
      markReady();
    }
  } catch (e: any) {
    console.error('[realtime] subscribe RPC threw:', e?.message ?? e);
    finish();
  }

  timer = setTimeout(finish, opts.timeoutMs);

  return {
    subscriptionId,
    close: cleanup,
    isClosed: () => closed,
    resetTimeout: (ms: number) => {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, ms);
    },
    ready,
  };
}
