import Foundation

/// Supabase Realtime, in the shape the popup's `utils/realtime.ts` gives it.
///
/// The popup is *told* when a write it did not wait for lands. That matters for one flow in
/// particular: Flow A annotates a freshly researched claim server-side in `ctx.waitUntil`, after
/// the research stream that caused it has already closed — so there is no stream left to carry
/// the result and no read that could be timed to catch it. This app had no such channel at all,
/// which is why it could only wait out a fixed window for annotations that may have arrived
/// seconds in. This is that channel.
///
/// Phoenix over a websocket, protocol version 2.0.0, where a message is the JSON array
/// `[join_ref, ref, topic, event, payload]`. The array shape is not a guess and not a detail to
/// get wrong: it is what `@supabase/realtime-js` sends for vsn 2.0.0 (its `Serializer`), and the
/// object shape `{topic, event, payload, ref}` is what it sends for vsn 1.0.0 only.
@MainActor
final class SupabaseRealtime {
    static let shared = SupabaseRealtime()

    /// One channel for `public.subscriptions`, opened once and never removed.
    ///
    /// Not one channel per logical subscription, and the popup learned this the hard way
    /// (`utils/realtime.ts`): Realtime registers `postgres_changes` listeners per TABLE on the
    /// server side, so every channel filtered to its own row registers its own listener — and
    /// unsubscribing any one of them forces a server-side renegotiation that drops every sibling
    /// channel still listening on that table. Each survivor then sits inert until its own
    /// timeout runs out, with the underlying socket still healthy and nothing logged. One
    /// channel, and every logical subscription dispatches through it by row id.
    private static let topic = "realtime:sub:shared:subscriptions"

    /// The version this client speaks, and with it the message shape. See the type's note.
    private static let vsn = "2.0.0"

    /// How often to ping. The server closes an idle socket, and a heartbeat that goes unanswered
    /// is also how a half-dead connection is noticed: the socket can stay open at the transport
    /// level while delivering nothing.
    private static let heartbeatInterval: TimeInterval = 30

    /// Which server-side routing row a subscription wants. `tweet` parks the hash, so a
    /// preclassification that has not written anything yet is still covered; `claim` names one
    /// row, directly or by text.
    enum Kind {
        case tweet
        case claim
    }

    // MARK: - Connection state

    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var heartbeat: Task<Void, Never>?
    private var reconnect: Task<Void, Never>?
    private var ref = 0
    private var joinRef: String?
    private var joined = false
    private var connecting = false
    private var pendingHeartbeat: String?
    private var joinWaiters: [CheckedContinuation<Void, Never>] = []

    /// The token the open channel was joined with. A session that has rolled since is a channel
    /// the server will no longer deliver to — row-level security filters the broadcast by
    /// `auth.uid()` — and a stale one fails by silence rather than by error, so the token is
    /// part of what makes a connection current.
    private var joinedToken: String?

    /// Whether the caller's own funds row is wanted on this channel. Set by anything with a reason
    /// to show a live balance, and cleared with the last of those reasons — see
    /// `releaseFundsChannel`.
    ///
    /// It used to be a latch, on the grounds that it dies with the process. It does not outlive a
    /// *reason* the way it does not outlive the process, and the process is the ordinary thing to
    /// outlive here: a window left open, a debug build still resident, a machine that is simply not
    /// restarted. Held past its reason it is not harmless — `scheduleReconnect` reads it, so every
    /// drop drags the channel back up for as long as the app runs, and each join that lands reads
    /// the row again with `get_funds`. That RPC bills a `funds` unit every time it is called
    /// (`get_funds.sql`), and the units are what ban the account: a day of appends with nothing
    /// watching is how an account with no work in flight bans itself.
    private var fundsWanted = false

    /// The wait before rejoining a channel that has dropped, doubled after each attempt and reset
    /// by a join that lands. Three seconds is right for a socket that was up and genuinely dropped;
    /// it is wrong for one that cannot stay up — a session revoked under it, an identity the server
    /// keeps refusing — where the wait is a read of the funds row every time, twenty a minute, for
    /// as long as the failure lasts.
    private var reconnectDelay: TimeInterval = 3
    private static let initialReconnectDelay: TimeInterval = 3
    private static let maxReconnectDelay: TimeInterval = 60

    /// When this client last read the funds row to cover a join. `get_funds` is billed, so a join
    /// arriving within `fundsReadFloor` of the last read does not read again: the value it would
    /// fetch is the one the connection it is replacing was carrying.
    private var lastFundsRead: Date?
    private static let fundsReadFloor: TimeInterval = 30

    /// Whether this connection has actually delivered a funds change.
    ///
    /// Deliberately evidence rather than intent. A join that carries the funds row in its config
    /// is not the same as a subscription that delivers: row-level security filters a broadcast to
    /// the identity the channel joined with, so a token that has rolled since — or any of the
    /// server-side listener drops the popup's client documents — leaves a channel that is joined,
    /// healthy and silent. Nothing here can tell those apart from a row that has not changed, so
    /// the only honest signal is one that has arrived.
    ///
    /// Read by `FactCheckNotifier`: it is what lets the notifier's own poll of the same figure
    /// slow down without assuming anything works, and cleared with the connection so the next one
    /// has to earn it again.
    private(set) var fundsDelivered = false

    // MARK: - Subscriptions

    private struct Entry {
        let kind: Kind
        let onClaim: ([String: Any]) -> Void
        let onDone: () -> Void
        let handle: RealtimeRowSubscription
        var timeout: Task<Void, Never>?
    }

    private var entries: [String: Entry] = [:]

    /// Ids this client registered and has since closed, kept only so an event that matches
    /// nothing can say WHY it matched nothing. A broadcast arriving after our own timeout is
    /// indistinguishable at the channel from one addressed to an id we never knew — and the two
    /// mean opposite things ("we gave up too early" vs "the id the DB stored is not the one we
    /// are listening for"), so the silence has to be breakable. Bounded; a diagnostic, not state.
    private var recentlyClosed: [String] = []

    private init() {}

    // MARK: - Public API

    /// Ask for the caller's own funds row to be delivered, opening the channel if it is not
    /// already up. Idempotent, and deliberately not `async`: it is called from a view's ticker, so
    /// it must not park a task per tick waiting on a join that may never be acknowledged.
    ///
    /// Silent when there is no live token. That is the same condition that puts the refresh
    /// sentence in front of the user on the tab that can act on it, and a balance notice here
    /// would be the third voice saying it.
    func ensureFundsChannel() {
        fundsWanted = true
        guard let token = FactCheckClient.liveToken else { return }
        if joined {
            // Already listening for this identity.
            guard joinedToken != token else { return }
            // Joined under a token that has since rolled. The server filters the broadcast by the
            // identity the channel joined with, so this one receives nothing and would keep
            // receiving nothing — silently, with the socket healthy and no error anywhere. Start
            // over, exactly as `start` does and for the same reason: the rejoin `dropped`
            // schedules reads the token again when it fires, so it cannot rejoin with the dead one.
            dropped()
            return
        }
        // An attempt already in flight, or a reconnect already scheduled, is left to finish: the
        // backoff exists so a server that keeps refusing is not asked once per tick.
        if connecting || reconnect != nil || socket != nil { return }
        connect(token: token)
    }

    /// The last caller that wanted a live balance has stopped wanting one. The socket itself is
    /// left alone — it is up, and the next view that shows a figure asks for it again through
    /// `ensureFundsChannel` — but nothing is owed a rejoin any more: a channel that drops from here
    /// stays down instead of being dragged back up every few seconds to read a row no one is
    /// looking at. See `fundsWanted`.
    func releaseFundsChannel() {
        fundsWanted = false
        guard entries.isEmpty else { return }
        reconnect?.cancel()
        reconnect = nil
        reconnectDelay = Self.initialReconnectDelay
    }

    /// One `get_funds` read, written into the shared container, to cover what a dropped socket
    /// could not deliver. The notifier's own RPC rather than a second implementation of it: it
    /// already returns balance + hold, and already answers nil rather than guessing.
    private static func refreshFundsIntoStore() async {
        guard let total = await FactCheckNotifier.fetchTotal() else { return }
        SharedTopUpStore.balance = total
        print("[realtime] funds re-read on join: total=\(total)")
    }

    /// Register a subscription and return its handle, or nil when there is nothing to
    /// authenticate with or the server refused to register it.
    ///
    /// The handle is returned live: the routing row exists server-side and pushed payloads are
    /// dispatched to `onClaim` from that moment. `onDone` fires once, on the row's DELETE or on
    /// the timeout, and never both.
    func subscribeRow(
        kind: Kind,
        hash: String? = nil,
        claimId: String? = nil,
        claimText: String? = nil,
        timeout: TimeInterval,
        onClaim: @escaping ([String: Any]) -> Void,
        onDone: @escaping () -> Void
    ) async -> RealtimeRowSubscription? {
        guard let token = FactCheckClient.liveToken else {
            // Named rather than silent. An expired token is not refused by the server, it is
            // filtered by row-level security, so this would otherwise look exactly like a
            // subscription that is working and simply has nothing to say — and the caller would
            // spend its full wait window on a channel that cannot deliver. Every other path in
            // this app is stopped by a stale token; the socket is the one that used to pretend.
            print("[realtime] no annotations: the session has expired — open the DisinfaX popup to hand over a new one")
            return nil
        }
        await start(token: token)
        guard joined else { return nil }

        let id = UUID().uuidString.lowercased()
        let handle = RealtimeRowSubscription(id: id)
        handle.onClose = { [weak self] in self?.finish(id) }

        // Registered before the RPC, not after: the routing row can produce its first payload
        // the instant it is written, and a dispatch entry added afterwards would drop it on the
        // floor with nothing to show for it.
        entries[id] = Entry(kind: kind, onClaim: onClaim, onDone: onDone, handle: handle)
        arm(id, after: timeout)

        guard await register(id: id, kind: kind, hash: hash, claimId: claimId, claimText: claimText, token: token) else {
            finish(id)
            return nil
        }
        return handle
    }

    // MARK: - Connecting

    /// Ensure there is a joined channel for `token`, opening or reopening as needed.
    private func start(token: String) async {
        if joined && joinedToken == token { return }
        // Joined, but under a token that has since rolled. RLS filters the broadcast by the
        // channel's identity, so this one is receiving nothing and will keep receiving nothing —
        // and it fails by silence, with no error and no close. Start over rather than reuse it.
        if joined { dropped() }
        if connecting || socket != nil { await awaitJoin(); return }
        connect(token: token)
        await awaitJoin()
    }

    private func awaitJoin() async {
        if joined { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            if joined { continuation.resume() } else { joinWaiters.append(continuation) }
        }
    }

    private func connect(token: String) {
        guard let url = Self.websocketURL else { return }
        // A deliberate connect supersedes a scheduled one: `dropped` schedules its reconnect for a
        // moment later, and a caller arriving in the meantime gets there first.
        reconnect?.cancel()
        reconnect = nil
        connecting = true
        joinedToken = token

        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()

        let join = nextRef()
        joinRef = join
        // The join payload the client sends: channel config first, then the token, which is what
        // the server authenticates the channel with.
        send([
            join,
            join,
            Self.topic,
            "phx_join",
            [
                "config": [
                    "broadcast": ["ack": false, "self": false],
                    "presence": ["key": "", "enabled": false],
                    "private": false,
                    "postgres_changes": Self.changesConfig(),
                ],
                "access_token": token,
            ],
        ])

        receive(on: task)
        startHeartbeat()
    }

    private static var websocketURL: URL? {
        let base = FactCheckClient.supabaseBase
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
        var components = URLComponents(string: "\(base)/realtime/v1/websocket")
        components?.queryItems = [
            URLQueryItem(name: "apikey", value: FactCheckClient.supabaseAnonKey),
            URLQueryItem(name: "vsn", value: SupabaseRealtime.vsn),
        ]
        return components?.url
    }

    /// The tables this one channel carries, as the join's `postgres_changes` config.
    ///
    /// Two tables on one channel, deliberately. The server registers this config per TABLE per
    /// channel, which is the hazard the type's own note describes — but that hazard is a second
    /// channel on the *same* table, where unsubscribing one renegotiates the server-side listener
    /// its siblings sit on. A different table has no siblings to disturb, and one channel means
    /// one join, one heartbeat and one reconnect rather than two of each.
    ///
    /// The funds row carries the user filter the popup uses, and is omitted entirely when no
    /// account is known: an unfiltered subscription to that table would ask the server for a
    /// broadcast it will only ever refuse.
    private static func changesConfig() -> [[String: Any]] {
        var config: [[String: Any]] = [["event": "*", "schema": "public", "table": "subscriptions"]]
        if let uid = SharedTopUpStore.userId, !uid.isEmpty {
            config.append([
                "event": "*",
                "schema": "public",
                "table": "funds",
                "filter": "user_id=eq.\(uid)",
            ])
        }
        return config
    }

    private func nextRef() -> String {
        ref += 1
        return String(ref)
    }

    // MARK: - Sending

    private func send(_ message: [Any]) {
        guard let socket,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        socket.send(.string(text)) { _ in }
    }

    private func startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.heartbeatInterval * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                // A beat still unanswered when the next is due means the connection is not
                // delivering, whatever the transport thinks. Reconnect rather than keep talking
                // into it: every subscription outstanding is waiting on this channel.
                if self.pendingHeartbeat != nil {
                    self.dropped()
                    return
                }
                let beat = self.nextRef()
                self.pendingHeartbeat = beat
                self.send([NSNull(), beat, "phoenix", "heartbeat", [String: Any]()])
            }
        }
    }

    // MARK: - Receiving

    private func receive(on task: URLSessionWebSocketTask) {
        receiver?.cancel()
        receiver = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await task.receive()
                    guard let self, !Task.isCancelled else { return }
                    self.handle(message)
                } catch {
                    // A closed or failed socket surfaces here and nowhere else. Every
                    // outstanding subscription is affected at once, so the recovery is for the
                    // connection rather than for any one of them.
                    self?.dropped()
                    return
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        guard let array = try? JSONSerialization.jsonObject(with: data) as? [Any], array.count >= 5 else { return }

        let event = array[3] as? String ?? ""
        let payload = array[4] as? [String: Any] ?? [:]

        switch event {
        case "phx_reply":
            reply(ref: array[1] as? String, payload: payload)
        case "postgres_changes":
            change(payload)
        default:
            break
        }
    }

    private func reply(ref: String?, payload: [String: Any]) {
        if let ref, ref == joinRef {
            joinRef = nil
            joined = true
            connecting = false
            // The backoff was waiting for exactly this.
            reconnectDelay = Self.initialReconnectDelay
            let waiters = joinWaiters
            joinWaiters = []
            for waiter in waiters { waiter.resume() }
            // Whatever the socket was not there to see. One read per join, in the order the
            // extension's own funds hub uses: subscribe first, then fetch once, so a value that
            // arrived before the channel was listening is not lost.
            //
            // Held off `fundsReadFloor` apart rather than taken every time: the read is billed, and
            // a channel being rejoined in a loop would otherwise spend a unit per attempt to learn
            // a figure that has not had time to change.
            let due = lastFundsRead.map { Date().timeIntervalSince($0) >= Self.fundsReadFloor } ?? true
            if fundsWanted, due {
                lastFundsRead = Date()
                Task { await Self.refreshFundsIntoStore() }
            }
            return
        }
        if let ref, ref == pendingHeartbeat { pendingHeartbeat = nil }
    }

    private func change(_ payload: [String: Any]) {
        guard let data = payload["data"] as? [String: Any] else { return }
        let type = data["type"] as? String ?? ""
        // Which table the row belongs to, asked before the id is: a funds row has no `id`, and a
        // missing one would otherwise read as a subscriptions event for an id this client never
        // registered — a diagnostic that lies about what happened.
        if Self.isFundsChange(data) {
            funds(type: type, data: data)
            return
        }
        // DELETE carries the row in `old_record` only — the client's own `new` is empty for it,
        // which is why the popup reads `msg.new?.id ?? msg.old?.id`.
        let row = (type == "DELETE" ? data["old_record"] : data["record"]) as? [String: Any] ?? [:]
        guard let id = row["id"] as? String else { return }

        guard let entry = entries[id] else {
            rememberUnmatched(id)
            return
        }
        if type == "DELETE" {
            finish(id)
            return
        }
        // The row's payload is the claim the server wrote; a jsonb column arrives decoded, but a
        // json column can arrive as the text of one.
        if let claim = row["payload"] as? [String: Any] {
            entry.onClaim(claim)
        } else if let text = row["payload"] as? String,
                  let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] {
            entry.onClaim(parsed)
        }
        // A claim subscription exists to await exactly one result, and the DB stops broadcasting
        // to it once that result is delivered — so the payload is terminal. A tweet subscription
        // is left alone: more claims may still come, and the client cannot know which was last.
        if entry.kind == .claim { finish(id) }
    }

    /// Whether a `postgres_changes` payload is the funds row rather than a subscriptions one.
    ///
    /// By name first, since the server sends the table on every message. The row's own shape is
    /// the fallback, so a payload that arrives without one is still routed by what it carries:
    /// a balance belongs to the funds row and to nothing else this channel listens for, and
    /// dropping the message instead would leave the balance quietly un-updated.
    private static func isFundsChange(_ data: [String: Any]) -> Bool {
        if let table = data["table"] as? String { return table == "funds" }
        return (data["record"] as? [String: Any])?["balance"] != nil
    }

    /// A change to the caller's own `funds` row: the same row the popup reads its balance from,
    /// delivered here instead of being polled for.
    ///
    /// Written into the shared container as balance + hold, which is the figure the extension
    /// writes under the same key and the one every reader of it expects. Through `balance` rather
    /// than `setAccount` on purpose: that stamps the identity, and the stamp is the extension's
    /// liveness signal — the thing that decides whether the app may take money at all. The app
    /// reporting its own balance must not be able to say "the extension just checked in", or the
    /// top-up card would come back on the strength of a socket rather than a hand-over.
    private func funds(type: String, data: [String: Any]) {
        guard type != "DELETE", let row = data["record"] as? [String: Any] else { return }
        // Rounded to the database's own 4-dp precision, exactly as the extension rounds what it
        // syncs: `balance + hold` is exact NUMERIC server-side, and re-adding the two as doubles
        // leaves a residue that would otherwise show as a figure nobody was ever charged.
        let total = ((row["balance"] as? Double ?? 0) + (row["hold"] as? Double ?? 0))
        let rounded = (total * 10000).rounded() / 10000
        SharedTopUpStore.balance = rounded
        // A delivery, which is the only proof this subscription has that it can deliver at all.
        fundsDelivered = true
        // And the same figure handed to the notifier, which is watching for a charge to attribute
        // to its own tab. It ignores this with its watch shut: this socket delivers the app every
        // change to the row, including the ones the browser caused, and those are not its news.
        FactCheckNotifier.shared.observe(total: rounded)
        print("[realtime] funds push: total=\(rounded)")
    }

    /// The connection is gone. Everything waiting on it is not cancelled — the routing rows
    /// still exist server-side, so a rejoin resumes delivery — but the join has to be redone
    /// before anyone can be told anything.
    private func dropped() {
        receiver?.cancel()
        receiver = nil
        heartbeat?.cancel()
        heartbeat = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        joined = false
        connecting = false
        joinRef = nil
        pendingHeartbeat = nil
        joinedToken = nil
        // The delivery this connection proved does not carry over to the next one: a rejoin is a
        // new identity, a new subscription and a new chance for either to be the silent kind.
        fundsDelivered = false
        // Waiters are left suspended on purpose: they are callers inside subscribeRow, and the
        // rejoin that resolves them is what they were waiting for.
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        // Nothing outstanding means nothing to reconnect for: the channel is opened on demand
        // by the next subscribeRow — or kept for the funds row, which is why that is asked about
        // here and not only the subscriptions.
        guard !entries.isEmpty || fundsWanted, reconnect == nil else { return }
        // Read out, then doubled for the attempt after this one: the first rejoin is as prompt as
        // it has always been, and only a channel that keeps failing is asked to wait. A join that
        // lands puts it back to three seconds. See `reconnectDelay`.
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, Self.maxReconnectDelay)
        reconnect = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.reconnect = nil
            // Already back — a caller reconnected in the meantime.
            guard self.socket == nil, !self.connecting else { return }
            // No live token is no rejoin: retrying would only rejoin an expired identity and wait
            // out the backoff to do it again. `ensureFundsChannel` is what picks this up once the
            // popup has handed over a token that can authenticate.
            guard let token = FactCheckClient.liveToken else { return }
            self.connect(token: token)
        }
    }

    // MARK: - Teardown

    private func arm(_ id: String, after interval: TimeInterval) {
        entries[id]?.timeout?.cancel()
        entries[id]?.timeout = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.finish(id)
        }
    }

    private func finish(_ id: String) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        entry.timeout?.cancel()
        entry.handle.markClosed()
        rememberClosed(id)
        entry.onDone()
    }

    private func rememberClosed(_ id: String) {
        recentlyClosed.append(id)
        if recentlyClosed.count > 50 { recentlyClosed.removeFirst() }
    }

    private func rememberUnmatched(_ id: String) {
        // Only a diagnostic, and cheap: it exists so "Realtime never delivered it" can be told
        // apart from "delivered under an id we are not listening for", which need opposite fixes.
        if recentlyClosed.contains(id) {
            print("[realtime] event for id=\(id) arrived after this client closed it — the broadcast worked, we gave up first")
        } else {
            print("[realtime] event for an id this client never registered: \(id)")
        }
    }

    // MARK: - Server-side registration

    /// The `subscribe` RPC: writes the routing row every trigger looks up to find its audience.
    /// Returns false when the row could not be registered, in which case no payload will ever
    /// arrive for this id and the caller should not hold a live subscription.
    private func register(id: String, kind: Kind, hash: String?, claimId: String?, claimText: String?, token: String) async -> Bool {
        guard let url = URL(string: "\(FactCheckClient.supabaseBase)/rest/v1/rpc/subscribe") else { return false }

        var body: [String: Any] = ["p_subscription_id": id]
        switch kind {
        case .tweet:
            // The RPC's argument is `bytea`, and the popup sends the postgres literal. Idempotent.
            let hex = hash ?? ""
            body["p_tweet_hash"] = hex.hasPrefix("\\x") ? hex : "\\x\(hex)"
        case .claim:
            if let claimId {
                body["p_row_id"] = claimId
                body["p_table"] = "claims"
            } else {
                body["p_claim_text"] = claimText ?? ""
            }
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(FactCheckClient.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return false }

        // The RPC returns the id it stored, which is meant to be the one passed in and is what
        // the dispatch map is keyed by. If the two ever diverge, every event for this
        // subscription routes to nothing and the caller just times out — so say so.
        if let text = String(data: data, encoding: .utf8) {
            let stored = text.trimmingCharacters(in: CharacterSet(charactersIn: "\"\n "))
            if !stored.isEmpty, stored != id {
                print("[realtime] subscribe id mismatch — sent \(id), stored \(stored)")
            }
        }
        return true
    }
}

/// A live row subscription. Close it when the claim it belongs to leaves the screen; the
/// server-side routing row outlives it and is reaped by the database's own `close_after`.
@MainActor
final class RealtimeRowSubscription {
    let id: String
    private(set) var isClosed = false
    fileprivate var onClose: (() -> Void)?

    fileprivate init(id: String) {
        self.id = id
    }

    fileprivate func markClosed() {
        isClosed = true
    }

    func close() {
        guard !isClosed else { return }
        onClose?()
    }
}
