import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// The only channel between the Safari extension and the containing app.
///
/// Why it exists: `Product.purchase()` must present a payment sheet, and an app extension has
/// no window or scene to present it in — measured, not assumed: the appex resolves products
/// fine (`fetch returned 1 product(s)`) and then throws `StoreKitError.unknown` 36 ms later,
/// before any network call. App Review guideline 4.4 ("extensions may not include ... in-app
/// purchases") points the same way. So the purchase happens in the app, and the two processes
/// need somewhere to exchange state.
///
/// An App Group container is that somewhere. Both targets must declare the group below in
/// Signing & Capabilities or every read returns nil and every write is silently dropped —
/// `UserDefaults(suiteName:)` does not fail loudly when the entitlement is missing, which is
/// why `isAvailable` exists and why the UI surfaces it rather than showing a blank balance.
///
/// Directions of travel:
///   extension → app   userId, balance, lastAmount   (written whenever the popup opens)
///   app → extension   pendingTransaction            (written the moment StoreKit returns)
///   app → extension   pendingAuthCallback           (written when an OAuth redirect lands here)
///   both ways         the session record            (see `AppSession` — one copy, either side refreshes)
enum SharedTopUpStore {

    /// The group identifier differs by platform, which is not a style choice: on macOS the
    /// App Groups value MUST carry the team identifier prefix, and since Sequoia the container is
    /// SIP-protected and refuses access without it. Getting this wrong does not throw — it logs
    /// "Using kCFPreferencesAnyUser with a container is only allowed for System Containers,
    /// detaching from cfprefsd" and then silently discards every write, which is exactly how a
    /// completed purchase ended up crediting nothing.
    ///
    /// Both spellings are tried, most-likely-first per platform, because the alternative is
    /// hard-coding one and finding out from a lost payment that it was the wrong one.
    private static let candidateIdentifiers: [String] = {
#if os(macOS)
        ["WJFG5784YR.group.app.disinfax", "group.app.disinfax"]
#else
        ["group.app.disinfax", "WJFG5784YR.group.app.disinfax"]
#endif
    }()

    /// Whichever candidate actually works, or the first as a label when none do.
    static var appGroupIdentifier: String { resolved?.identifier ?? candidateIdentifiers[0] }

    private static var defaults: UserDefaults? { resolved?.defaults }

    /// Resolved once by writing a value and reading it back. A mere non-nil `UserDefaults` proves
    /// nothing here: `UserDefaults(suiteName:)` hands back an object whether or not the entitlement
    /// grants access, so the only honest test is a round trip.
    private static let resolved: (identifier: String, defaults: UserDefaults)? = {
        for identifier in candidateIdentifiers {
            guard let candidate = UserDefaults(suiteName: identifier) else { continue }
            let probeKey = "topup.probe"
            let probeValue = "ok"
            candidate.set(probeValue, forKey: probeKey)
            let readBack = candidate.string(forKey: probeKey)
            candidate.removeObject(forKey: probeKey)
            if readBack == probeValue {
                return (identifier, candidate)
            }
        }
        return nil
    }()

    /// False when no candidate survived the round trip: the entitlement is missing, or the
    /// identifier is not the one this platform requires. Distinguishes "not signed in" from
    /// "misconfigured build", which otherwise look identical in the UI.
    static var isAvailable: Bool { resolved != nil }

    /// How long an identity written by the extension is trusted.
    ///
    /// The app cannot ask the server who is signed in — it has no session — so it believes what
    /// the extension last told it. That belief has to expire, or an identity written months ago
    /// would still authorise a purchase after the extension was removed, disabled, or simply never
    /// run again. Sign-out clears this explicitly; the stamp is the backstop for every path that
    /// does not reach us at all.
    ///
    /// Seven days is long enough that a normal user is never asked to re-open the popup — the
    /// background rewrites it on every balance change — and short enough that a dead extension
    /// stops the app selling.
    private static let accountMaxAge: TimeInterval = 7 * 24 * 60 * 60

    /// How fresh the stamp must be before the app will SELL. Separate from
    /// accountMaxAge above: that is the outer backstop for a dead extension,
    /// this is the everyday gate. The background rewrites the stamp on every
    /// balance change and the popup on every open, so a healthy setup stays
    /// seconds old; anything older means the extension has not reported in a
    /// while — possibly signed out with nothing alive to send the clear — and
    /// selling on it would charge against a stale identity. Failing closed
    /// costs at most a trip to the popup.
    private static let accountFreshnessWindow: TimeInterval = 60

    /// Supabase's project URL and *publishable* (anon) key — the same pair the extension
    /// ships, and not a secret: it grants nothing on its own, and every table and RPC is gated
    /// by row-level security keyed on `auth.uid()`.
    ///
    /// They live here rather than in `FactCheckClient` because the extension targets compile
    /// this file and not that one, and `AppSession` below needs the token endpoint in every
    /// target that can refresh. `FactCheckClient` forwards to these, so there is still exactly
    /// one copy of each value in the project.
    static let supabaseBase = "https://pofekzkirnysbuqbxmvp.supabase.co"
    static let supabaseAnonKey = "sb_publishable_4ZX8ljVPNImnvcpLl60Q_g_zgOK77Ua"

    /// The two darkened guide overlays the app can show. Named here rather than in the view
    /// because the dismissal outlives the view: it is a fact about the account, stored beside
    /// the two facts that decide whether each overlay is due at all.
    enum GuideOverlayKind {
        case safari, factCheck
    }

    private enum Key {
        static let userId = "topup.userId"
        static let accountSyncedAt = "topup.accountSyncedAt"
        static let balance = "topup.balance"
        static let requestedAmount = "topup.requestedAmount"
        static let autoStartPurchase = "topup.autoStartPurchase"
        static let lastAmount = "topup.lastAmount"
        static let pendingRecords = "topup.pending.records"
        static let finishable = "topup.finishable"
        static let accessToken = "topup.accessToken"
        static let accessTokenExpiresAt = "topup.accessTokenExpiresAt"
        static let refreshToken = "auth.refreshToken"
        static let sessionUserId = "auth.userId"
        static let sessionGeneration = "auth.generation"
        static let signedOutAt = "auth.signedOutAt"
        static let popupOpened = "auth.popupOpened"
        static let selectionFactCheck = "auth.selectionFactCheck"
        static let safariGuideDismissed = "guide.safariOverlayDismissed"
        static let factCheckGuideDismissed = "guide.factCheckOverlayDismissed"
        static let pendingAuthCallback = "auth.pendingCallback"
        static let pendingAuthCallbackAt = "auth.pendingCallbackAt"
        static let spendNotifyEnabled = "notify.spend.enabled"
        static let spendNotifyThreshold = "notify.spend.threshold"
    }

    /// Field names inside one stored record. A dictionary rather than a Codable struct because
    /// the extension handler passes these straight out to JavaScript, where they have to be
    /// plain property-list types anyway.
    private enum Field {
        static let jws = "jws"
        static let transactionId = "transactionId"
        static let amount = "amount"
    }

    // MARK: - Written by the extension, read by the app

    /// Forces a re-read of what the OTHER process wrote.
    ///
    /// Each process keeps its own cache of a suite's contents, so the app can hold a snapshot
    /// taken before the extension credited the balance and keep serving it. That is the difference
    /// between "the popup shows the new figure and the app does not" and both agreeing.
    static func reloadFromDisk() {
        defaults?.synchronize()
    }

    /// Supabase user id. Without it the app cannot bind the purchase to an account
    /// (`appAccountToken`) and the backend cannot credit anyone, so the app refuses to sell.
    /// The signed-in user, or nil if nobody is — including when the last word we had on the
    /// subject is too old to act on. Deliberately not a plain stored property: a getter that can
    /// only say "here is what was written" cannot express "signed out", and that is exactly the
    /// distinction that decides whether the app may take money.
    static var userId: String? {
        guard let d = defaults, let id = d.string(forKey: Key.userId), !id.isEmpty else { return nil }
        guard let stamp = d.object(forKey: Key.accountSyncedAt) as? Date else {
            // Written by a build that predates the stamp. Treated as unknown rather than trusted:
            // failing closed costs the user one trip to the popup, failing open sells to a
            // signed-out account.
            return nil
        }
        if Date().timeIntervalSince(stamp) > accountMaxAge {
            return nil
        }
        return id
    }

    /// The user id, gated on FRESHNESS as well as presence: non-nil only when the
    /// extension reported in within accountFreshnessWindow. `userId` answers "who
    /// was last reported"; this answers "who may be sold to right now". The
    /// distinction matters because revocation is a best-effort push (CLEAR_ACCOUNT
    /// needs a live extension process to send it), while staleness is observable
    /// locally — the moment the stamp goes quiet, selling stops, no message needed.
    static var freshUserId: String? {
        guard let d = defaults, let id = d.string(forKey: Key.userId), !id.isEmpty else { return nil }
        guard let stamp = d.object(forKey: Key.accountSyncedAt) as? Date else { return nil }
        if Date().timeIntervalSince(stamp) > accountFreshnessWindow {
            return nil
        }
        return id
    }


    /// Written by the extension whenever it knows who is signed in. Stamped, so the value can
    /// expire on its own if the extension stops reporting.
    static func setAccount(userId: String, balance: Double?) {
        guard let d = defaults else { return }
        d.set(userId, forKey: Key.userId)
        d.set(Date(), forKey: Key.accountSyncedAt)
        if let balance { d.set(balance, forKey: Key.balance) }
    }

    // MARK: - Spend notifications

    /// The popup's spend-notification floor, mirrored here because `FactCheckNotifier`
    /// raises the app's own charge notices and cannot read extension storage. Without
    /// it the app would keep announcing charges the reader has asked the browser to
    /// stop announcing. Defaults match the popup's: on, above US$0.001.
    private static let defaultSpendNotifyEnabled = true
    private static let defaultSpendNotifyThreshold = 0.001

    static var spendNotifyEnabled: Bool {
        defaults?.object(forKey: Key.spendNotifyEnabled) as? Bool ?? defaultSpendNotifyEnabled
    }

    static var spendNotifyThreshold: Double {
        guard let value = defaults?.object(forKey: Key.spendNotifyThreshold) as? Double else {
            return defaultSpendNotifyThreshold
        }
        return min(1, max(0.0001, value))
    }

    /// Written alongside the account sync, from the background's `SYNC_ACCOUNT`.
    static func setSpendNotifications(enabled: Bool, threshold: Double) {
        guard let d = defaults else { return }
        d.set(enabled, forKey: Key.spendNotifyEnabled)
        d.set(min(1, max(0.0001, threshold)), forKey: Key.spendNotifyThreshold)
    }

    // MARK: - The shared session

    /// The device's copy of the Supabase session, whichever process minted it.
    ///
    /// Both the app and the extension hold a session and either may refresh it, so there is
    /// exactly one record and every refresh is a compare-and-swap on it — see `AppSession` for
    /// why two independent copies would sign the user out of the browser.
    ///
    /// `refreshToken` is optional for one reason only: a record written by a build that
    /// predates it carries an access token and nothing else. That token is still good until it
    /// expires, so it is honoured, but it cannot be renewed.
    struct StoredSession: Equatable {
        let accessToken: String
        let refreshToken: String?
        let expiresAt: Date
        let userId: String?
        let generation: Int
    }

    /// How long an access token is minted for. The server's number (Supabase's default), written
    /// here because it is what turns a record's expiry back into the moment it was minted — and
    /// that moment is the only thing that tells a session from before a sign-out apart from one
    /// started after it. The extension carries the same constant for the same reason; the two
    /// have to move together.
    static let accessTokenLifetime: TimeInterval = 3600

    /// When this device last ended its session, in device time.
    ///
    /// Written by `clearAccount`, so it is stamped whichever side did the signing out. The app
    /// can act on it directly — it is where the identity comes from — but the extension cannot
    /// be told anything by the app, so the extension reads this instead (see the native
    /// `SIGNED_OUT_AT` action and its poller in the background).
    static var signedOutAt: Date? {
        defaults?.object(forKey: Key.signedOutAt) as? Date
    }

    /// What is stored right now, without refreshing anything.
    ///
    /// A record minted at or before the last sign-out is not a session, however it came to be
    /// written: a refresh the extension had in flight when the app signed out can land in the
    /// shared record afterwards, and offering it here would sign the user straight back in to
    /// the account they just left. The same rule, in the same terms, is what the extension
    /// applies to a record after a sign-out here — a session started since is minted later than
    /// the sign-out, so it is the only kind that survives.
    static var storedSession: StoredSession? {
        guard let d = defaults,
              let token = d.string(forKey: Key.accessToken), !token.isEmpty,
              let expiresAt = d.object(forKey: Key.accessTokenExpiresAt) as? Date else { return nil }
        if let signedOutAt = d.object(forKey: Key.signedOutAt) as? Date,
           expiresAt.timeIntervalSince1970 - accessTokenLifetime <= signedOutAt.timeIntervalSince1970 {
            return nil
        }
        let refresh = d.string(forKey: Key.refreshToken)
        let sessionUserId = d.string(forKey: Key.sessionUserId)
        return StoredSession(
            accessToken: token,
            refreshToken: refresh.flatMap { $0.isEmpty ? nil : $0 },
            expiresAt: expiresAt,
            userId: sessionUserId.flatMap { $0.isEmpty ? nil : $0 },
            generation: d.integer(forKey: Key.sessionGeneration)
        )
    }

    /// The only writer of the record. A record that names a user also refreshes the account
    /// identity, because every caller that had an identity had it from the same response the
    /// token came from — writing the two apart is what let them disagree.
    @discardableResult
    static func writeStoredSession(_ session: StoredSession) -> Bool {
        guard let d = defaults else { return false }
        d.set(session.accessToken, forKey: Key.accessToken)
        d.set(session.expiresAt, forKey: Key.accessTokenExpiresAt)
        if let refresh = session.refreshToken { d.set(refresh, forKey: Key.refreshToken) }
        else { d.removeObject(forKey: Key.refreshToken) }
        if let id = session.userId, !id.isEmpty {
            d.set(id, forKey: Key.sessionUserId)
            d.set(id, forKey: Key.userId)
            d.set(Date(), forKey: Key.accountSyncedAt)
        } else {
            d.removeObject(forKey: Key.sessionUserId)
        }
        d.set(session.generation, forKey: Key.sessionGeneration)
        return true
    }

    /// Drops the tokens and everything that only made sense alongside them. The account
    /// identity goes too: a record that survives a sign-out is a session the app can still act
    /// on, which is exactly what a sign-out is supposed to end.
    static func clearSessionRecord() {
        guard let d = defaults else { return }
        d.removeObject(forKey: Key.accessToken)
        d.removeObject(forKey: Key.accessTokenExpiresAt)
        d.removeObject(forKey: Key.refreshToken)
        d.removeObject(forKey: Key.sessionUserId)
        d.removeObject(forKey: Key.sessionGeneration)
    }

    /// A Supabase access token the extension last handed over, with the moment it stops working.
    struct Session {
        let accessToken: String
        let expiresAt: Date
    }

    /// What the app may authenticate to the workers with, or nil if it cannot.
    ///
    /// The workers verify the Supabase JWT directly, so this is the whole of what the app needs
    /// to fact-check on its own — but only while the token is live. A caller that can wait
    /// should ask `AppSession.current` instead, which renews it; this stays for the reads that
    /// cannot be async.
    static var session: Session? {
        guard let stored = storedSession else { return nil }
        return Session(accessToken: stored.accessToken, expiresAt: stored.expiresAt)
    }

    /// The user the app may act for, derived from the session rather than from a stamp that
    /// expires on its own.
    ///
    /// This is stricter than the old `freshUserId` and for a different reason: an identity is
    /// only worth anything while a session backs it, because that session is what the backend
    /// authenticates the purchase as. A record the app can keep alive is proof; a stamp that
    /// went quiet is not.
    static var signedInUserId: String? {
        guard let record = storedSession else { return nil }
        if let id = record.userId, !id.isEmpty { return id }
        return userId
    }

    /// Records that the popup has been opened at least once on this install.
    ///
    /// Never cleared — not on sign-out, not by `clearAccount`. The guide's choice depends on it
    /// being a fact about the installation, and a user who signed out and back in has still
    /// enabled the extension.
    static func markPopupOpened() {
        defaults?.set(true, forKey: Key.popupOpened)
    }

    static var popupOpenedEver: Bool {
        defaults?.bool(forKey: Key.popupOpened) ?? false
    }

    /// Records that a fact-check was started on a page selection — through the popup over a
    /// selection, or the right-click menu — rather than on a post through the injected
    /// buttons.
    ///
    /// Written by the extension when the run actually begins, which is after the popup's
    /// one-time charge confirmation and after the sign-in check: a selection the user
    /// declined, or started while signed out, is not a selection fact-check they performed.
    /// Never cleared, like `popupOpened`, because the guide overlay it dismisses is about
    /// whether the user has ever done this at all.
    static func markSelectionFactCheck() {
        defaults?.set(true, forKey: Key.selectionFactCheck)
    }

    static var selectionFactCheckEver: Bool {
        defaults?.bool(forKey: Key.selectionFactCheck) ?? false
    }

    /// Whether the user has dismissed a guide overlay by tapping it. Two flags, because the
    /// two overlays describe different instructions and never appear at the same time: an
    /// account that has done one of the things still needs telling about the other.
    static func markGuideOverlayDismissed(_ overlay: GuideOverlayKind) {
        defaults?.set(true, forKey: overlay == .safari ? Key.safariGuideDismissed : Key.factCheckGuideDismissed)
    }

    static func guideOverlayDismissed(_ overlay: GuideOverlayKind) -> Bool {
        defaults?.bool(forKey: overlay == .safari ? Key.safariGuideDismissed : Key.factCheckGuideDismissed) ?? false
    }

    /// Clears the guide's two lifetime facts and both dismissals, for testing.
    ///
    /// Nothing in the UI can undo these — never coming back is what they are for — and on macOS
    /// deleting the app does not clear them the way it does on iOS: they live in the app group,
    /// which outlives the bundle, and the container is protected from the shell. So the app clears
    /// them at launch when asked, by a flag that exists only in the argument domain:
    /// `open -n DisinfaX.app --args -MFResetGuide YES`.
    static func resetGuideOverlaysIfAsked() {
        guard UserDefaults.standard.bool(forKey: "MFResetGuide") else { return }
        defaults?.removeObject(forKey: Key.popupOpened)
        defaults?.removeObject(forKey: Key.selectionFactCheck)
        defaults?.removeObject(forKey: Key.safariGuideDismissed)
        defaults?.removeObject(forKey: Key.factCheckGuideDismissed)
    }

    /// Handed over by the extension on every popup open, alongside the account sync.
    ///
    /// Prefer `AppSession.publish`, which also stamps the generation and will not walk the
    /// record backwards. This remains for a hand-over that carries no refresh token at all.
    static func setSession(accessToken: String, expiresAt: Date?) {
        guard let d = defaults else { return }
        d.set(accessToken, forKey: Key.accessToken)
        // A missing expiry is treated as already expired: without it the app cannot tell a live
        // token from a dead one, and the workers reject a dead one anyway.
        d.set(expiresAt ?? Date(timeIntervalSince1970: 0), forKey: Key.accessTokenExpiresAt)
    }

    /// Called when the extension reports that nobody is signed in.
    ///
    /// Clears the identity and the displayed balance — but deliberately NOT the pending records or
    /// the finishable ids. Those are purchases already paid for; discarding them on sign-out would
    /// destroy the only local record of money owed. They carry their own appAccountToken, so they
    /// are credited to whoever actually bought them whenever they are next settled.
    static func clearAccount() {
        guard let d = defaults else { return }
        // Stamped before anything else goes, and deliberately not cleared: it is what stops a
        // session minted by the other process, or a record the other process writes before it
        // has heard about this, from being read back as a signed-in device. See `storedSession`.
        d.set(Date(), forKey: Key.signedOutAt)
        d.removeObject(forKey: Key.userId)
        d.removeObject(forKey: Key.accountSyncedAt)
        d.removeObject(forKey: Key.balance)
        d.removeObject(forKey: Key.requestedAmount)
        // An armed intent goes too. It is not money owed, so nothing is lost by dropping it — but
        // left behind it would be an instruction to spend, aimed at whichever account signs in
        // next, from a hand-off that belonged to the one that just left.
        d.removeObject(forKey: Key.autoStartPurchase)
        // The session goes with the identity: a token outliving a sign-out would let the app keep
        // billing a user who has explicitly left.
        clearSessionRecord()
    }

    /// Balance in USD, as last seen by the popup. Display only — the authoritative figure
    /// always comes from the backend, so this is never used in any arithmetic that matters.
    static var balance: Double? {
        get { defaults?.object(forKey: Key.balance) as? Double }
        set { defaults?.set(newValue, forKey: Key.balance) }
    }

    /// The amount the user picked in the popup before being sent here. Consumed once: cleared
    /// on read so that re-opening the app later falls back to `lastAmount` instead of silently
    /// resurrecting a stale intent from a previous session.
    static func takeRequestedAmount() -> Int? {
        guard let d = defaults, d.object(forKey: Key.requestedAmount) != nil else { return nil }
        let value = d.integer(forKey: Key.requestedAmount)
        d.removeObject(forKey: Key.requestedAmount)
        return value
    }

    static func setRequestedAmount(_ amount: Int) {
        defaults?.set(amount, forKey: Key.requestedAmount)
    }

    /// Arms the app to start the purchase itself, so a top-up asked for in the popup does not need
    /// the user to press the same button again here.
    ///
    /// Written from exactly one place — `TopUpHandoff`, which only ever runs for an incoming
    /// `disinfax://topup` URL. Opening the app by hand produces no such URL, so this flag is also
    /// the whole of the distinction between the two origins, and a launch from the Home Screen or
    /// the Dock cannot arm it.
    ///
    /// It is not a licence to charge without the user agreeing: the payment sheet, its amount and
    /// its Face ID / side-button confirmation all still happen here, in this app. What it removes
    /// is only the second tap on a button the user has already pressed once.
    static func setAutoStartPurchase() {
        defaults?.set(true, forKey: Key.autoStartPurchase)
    }

    /// Consumed on read, deliberately. `ViewController` rebuilds the whole SwiftUI tree on every
    /// hand-off and on every tab change it is asked for, so each rebuild is a fresh `TopUpView`
    /// whose `onAppear` runs again — one-shot semantics are what keep a second appearance from
    /// starting a second purchase against the same single intent.
    static func takeAutoStartPurchase() -> Bool {
        guard let d = defaults, d.bool(forKey: Key.autoStartPurchase) else { return false }
        d.removeObject(forKey: Key.autoStartPurchase)
        return true
    }

    // MARK: - Amount fallback chain

    /// Remembered across launches so a user who opens the app directly gets their usual amount
    /// rather than starting from scratch every time.
    static var lastAmount: Int? {
        get {
            guard let d = defaults, d.object(forKey: Key.lastAmount) != nil else { return nil }
            return d.integer(forKey: Key.lastAmount)
        }
        set { defaults?.set(newValue, forKey: Key.lastAmount) }
    }

    /// requested (from the popup) → lastAmount (previous app top-up) → 6.
    /// 6 mirrors the extension's DEFAULT_CUSTOM: a shared first-run default so the app
    /// and the popup agree before either side has stored anything.
    /// Clamped, because both stored values are user-influenced and the product ids only exist
    /// for 1...100 — an out-of-range amount would fail the lookup with a confusing error.
    static func initialAmount() -> Int {
        let candidate = takeRequestedAmount() ?? lastAmount ?? 6
        return min(max(candidate, 1), 100)
    }

    // MARK: - Written by the app, read by the extension

    /// How many unsettled purchases to keep. Reaching even two means the extension has failed
    /// to credit twice in a row, so this is a leak guard rather than a working limit — but it
    /// drops the OLDEST, because the newest is the one the user is standing there waiting for.
    private static let maxPendingRecords = 20

    /// Recorded the instant StoreKit returns a verified transaction and BEFORE the balance is
    /// credited, so a crash, a force-quit, or the user switching away cannot lose a paid-for
    /// transaction. The extension finishes it only after the backend confirms the credit; until
    /// then StoreKit keeps redelivering it, and `settlePendingTopUps` can recover it.
    ///
    /// A list, not a single slot: someone can buy twice before returning to Safari (top up $5,
    /// ignore the "return to Safari" line, top up $10). With one slot the second write would
    /// erase the first, and $5 would be charged with nothing credited.
    static func appendPendingTransaction(jws: String, transactionId: String, amount: Int) {
        guard let d = defaults else { return }
        var records = rawPendingRecords()
        // Same transaction twice is a re-record, not a second purchase — StoreKit can redeliver
        // the same id, and two copies would mean two credit attempts for one payment.
        records.removeAll { $0[Field.transactionId] as? String == transactionId }
        records.append([Field.jws: jws, Field.transactionId: transactionId, Field.amount: amount])
        if records.count > maxPendingRecords { records.removeFirst(records.count - maxPendingRecords) }
        d.set(records, forKey: Key.pendingRecords)
    }

    /// Whether this exact transaction is already recorded and waiting to be applied. Used to tell
    /// a genuinely new purchase apart from StoreKit handing back one that has not been settled yet.
    static func isPending(transactionId: String) -> Bool {
        pendingTransactions().contains { $0.transactionId == transactionId }
    }

    static func pendingTransactions() -> [(jws: String, transactionId: String, amount: Int)] {
        rawPendingRecords().compactMap { record in
            guard let jws = record[Field.jws] as? String,
                  let txId = record[Field.transactionId] as? String else { return nil }
            return (jws, txId, record[Field.amount] as? Int ?? 0)
        }
    }

    /// The same records in the plain-dictionary form JavaScript needs, so the handler does not
    /// have to rebuild them from tuples.
    static func pendingTransactionPayload() -> [[String: Any]] {
        pendingTransactions().map {
            ["signedTransaction": $0.jws, "transactionId": $0.transactionId, "amount": $0.amount]
        }
    }

    /// Cleared by the extension only once the credit for THAT id is confirmed. Deliberately
    /// separate from reading, and per-id rather than wholesale: clearing on read would drop a
    /// record if the credit then failed, and clearing everything would drop the purchases that
    /// have not been credited yet.
    static func clearPendingTransaction(transactionId: String) {
        guard let d = defaults else { return }
        var records = rawPendingRecords()
        records.removeAll { $0[Field.transactionId] as? String == transactionId }
        if records.isEmpty {
            d.removeObject(forKey: Key.pendingRecords)
        } else {
            d.set(records, forKey: Key.pendingRecords)
        }
    }

    // MARK: - Credited, awaiting close-out

    /// Transactions the backend has confirmed crediting, which the device may therefore finish.
    ///
    /// Why this exists: finishing is what stops Apple redelivering a transaction, and an unfinished
    /// one makes StoreKit hand it back instead of charging again for the same product — so a
    /// transaction that is never finished quietly makes that product un-buyable. The extension
    /// attempts the finish, but whether an app extension can finish a transaction at all is not
    /// something this project has ever verified, and a silent failure there is indistinguishable
    /// from success. So the app, which unquestionably can, finishes them as well.
    ///
    /// Only ever written AFTER a confirmed credit. An id here means "the money is in the balance,
    /// closing this is safe" — never "we think it probably worked".
    static func markFinishable(transactionId: String) {
        guard let d = defaults else { return }
        var ids = finishableTransactions()
        guard !ids.contains(transactionId) else { return }
        ids.append(transactionId)
        // Same leak guard as the records: bounded, oldest dropped first.
        if ids.count > maxPendingRecords { ids.removeFirst(ids.count - maxPendingRecords) }
        d.set(ids, forKey: Key.finishable)
    }

    static func finishableTransactions() -> [String] {
        (defaults?.array(forKey: Key.finishable) as? [String]) ?? []
    }

    /// Cleared only once the transaction is actually finished. Clearing on read would lose the
    /// instruction if the finish then failed, putting us back to a silently stuck product.
    static func clearFinishable(transactionId: String) {
        guard let d = defaults else { return }
        let ids = finishableTransactions().filter { $0 != transactionId }
        if ids.isEmpty { d.removeObject(forKey: Key.finishable) } else { d.set(ids, forKey: Key.finishable) }
    }

    // MARK: - Sign-in hand-off

    /// How long a parked OAuth callback is worth collecting.
    ///
    /// The authorization code inside is far shorter-lived than this, so the real job is to bound
    /// how long the extension keeps asking: an abandoned sign-in must not leave the funds alarm
    /// doing a native round trip every minute for the rest of the session.
    private static let pendingAuthMaxAge: TimeInterval = 30 * 60

    /// The provider's redirect, caught here because it arrives on the `disinfax://` scheme and
    /// an app extension has no window to present ASWebAuthenticationSession in. Parking it is
    /// the whole of this app's part: only the extension holds the PKCE verifier, so only the
    /// extension can turn it into a session.
    ///
    /// The URL is stored whole rather than as parsed fields. The extension already reads callback
    /// URLs for the macOS transport it was handed, and keeping the two on the same code path is
    /// what stops them disagreeing about which half carries the credential.
    ///
    /// Carries nothing secret beyond the one-time code itself, which the app cannot use: the
    /// App Group is the only place the two processes can see the same bytes.
    static func setPendingAuthCallback(_ url: String) {
        guard let d = defaults else { return }
        d.set(url, forKey: Key.pendingAuthCallback)
        d.set(Date(), forKey: Key.pendingAuthCallbackAt)
    }

    /// Consumed on read, deliberately. The code inside is single-use, so a second reader could
    /// only ever fail with it — and there are two readers by design (the popup when it opens,
    /// the background on its alarm), which makes one-shot semantics the difference between them
    /// racing and one of them simply finding nothing left to collect.
    ///
    /// Nil when nothing is parked, or when what is parked is too old to be worth the trip.
    /// Removed either way: an expired callback is as dead as a consumed one.
    static func takePendingAuthCallback() -> String? {
        guard let d = defaults else { return nil }
        guard let url = d.string(forKey: Key.pendingAuthCallback), !url.isEmpty else { return nil }
        let parkedAt = d.object(forKey: Key.pendingAuthCallbackAt) as? Date
        d.removeObject(forKey: Key.pendingAuthCallback)
        d.removeObject(forKey: Key.pendingAuthCallbackAt)
        guard let parkedAt, Date().timeIntervalSince(parkedAt) <= pendingAuthMaxAge else { return nil }
        return url
    }

    private static func rawPendingRecords() -> [[String: Any]] {
        (defaults?.array(forKey: Key.pendingRecords) as? [[String: Any]]) ?? []
    }
}

// MARK: - Refreshing the shared session

/// The one place a session is renewed.
///
/// Why it is this careful: this project's refresh tokens ROTATE and detect reuse (reuse
/// interval 300 s). Two clients each holding a copy and each refreshing would race — the loser
/// sends a token the server has already rotated, that reads as a replay, and the project revokes
/// the whole family, signing the user out of their browser. The one outcome this design must not
/// produce is a user who never asked to leave being signed out, so a refresh is never two
/// clients refreshing: it is one process taking the lock, re-reading, refreshing, writing, and
/// the other process adopting the result.
///
/// The rules, in order of how often they save us:
///   * a token with enough life left is handed straight back — no lock, no network;
///   * a refresh re-reads under the lock, so a rotation that landed while we queued is adopted
///     instead of repeated;
///   * a refusal is checked once against the record before it is believed, because the refusal
///     was for the token WE sent, and the record may already hold the token that replaced it;
///   * only a refusal with nothing fresher on disk clears the session — so offline, a 5xx, or
///     a rate limit never looks like a sign-out.
enum AppSession {

    /// How much life a token must have left before it is handed out without renewing.
    ///
    /// The workers verify the JWT themselves, so a token that dies while the request is in
    /// flight fails a run that was otherwise fine. A minute covers the gap between this check
    /// and the request landing with room to spare.
    /// `nonisolated` because it is also the default argument of `current`, and a default
    /// argument is evaluated outside any actor.
    nonisolated static let minimumValidity: TimeInterval = 60

    /// A session the caller can authenticate with, renewed if it was close to expiring.
    ///
    /// Nil means the device genuinely has no session: nobody signed in, or the server refused
    /// to renew one. Every other failure returns whatever is still valid rather than nil.
    static func current(minimumValidity: TimeInterval = AppSession.minimumValidity) async -> SharedTopUpStore.StoredSession? {
        SharedTopUpStore.reloadFromDisk()
        if let stored = SharedTopUpStore.storedSession, stored.expiresAt > Date().addingTimeInterval(minimumValidity) {
            return stored
        }
        return await refresh()
    }

    /// Renews the record, or adopts a renewal that happened elsewhere.
    @discardableResult
    static func refresh() async -> SharedTopUpStore.StoredSession? {
        if case .session(let stored) = await refreshOutcome() { return stored }
        return nil
    }

    /// What a refresh attempt actually established.
    ///
    /// The app only needs the session or its absence, but the extension's native handler needs
    /// one more distinction: it answers supabase-js, and supabase-js SIGNS THE USER OUT on a
    /// refused refresh while it keeps the session on an inconclusive one. Collapsing those two
    /// into nil is how "the network blipped" would become "you have been signed out".
    enum Outcome {
        case session(SharedTopUpStore.StoredSession)
        /// No session, and not because of the network: nobody signed in, or the server refused.
        case none
        /// Could not tell. The caller should keep whatever session it already had.
        case unavailable
    }

    /// The same refresh, keeping the three outcomes apart.
    static func refreshOutcome() async -> Outcome {
        await Refresher.shared.refreshOutcome()
    }

    /// Takes a session another process minted.
    ///
    /// Last write wins on expiry, deliberately, rather than on the generation counter: the two
    /// sides would have to agree on a counter they write from different processes, whereas the
    /// expiry was minted by the server and a refresh token only ever moves forward. So a token
    /// with a later expiry is by construction the newer rotation, and a publisher holding an
    /// older one cannot walk the record backwards.
    ///
    /// Returns false only when the App Group is unavailable, i.e. when nothing was written and
    /// the caller should not behave as if it had been.
    @discardableResult
    static func publish(
        accessToken: String,
        refreshToken: String?,
        expiresAt: Date,
        userId: String?
    ) async -> Bool {
        guard !accessToken.isEmpty, SharedTopUpStore.isAvailable else { return false }
        let lock = await SessionLock.acquire(timeout: 3)
        defer { SessionLock.release(lock) }
        SharedTopUpStore.reloadFromDisk()

        let existing = SharedTopUpStore.storedSession
        if let existing, existing.expiresAt >= expiresAt {
            // Ours is at least as new. Take only what it is missing — an identity, or the
            // refresh token a build before this one never had.
            let merged = SharedTopUpStore.StoredSession(
                accessToken: existing.accessToken,
                refreshToken: existing.refreshToken ?? refreshToken,
                expiresAt: existing.expiresAt,
                userId: existing.userId ?? userId,
                generation: existing.generation
            )
            if merged != existing { SharedTopUpStore.writeStoredSession(merged) }
            return true
        }

        let updated = SharedTopUpStore.StoredSession(
            accessToken: accessToken,
            refreshToken: refreshToken.flatMap { $0.isEmpty ? nil : $0 } ?? existing?.refreshToken,
            expiresAt: expiresAt,
            userId: userId.flatMap { $0.isEmpty ? nil : $0 } ?? existing?.userId,
            generation: (existing?.generation ?? 0) + 1
        )
        return SharedTopUpStore.writeStoredSession(updated)
    }

    /// A real sign-out: the user did it, or the server will not honour the session any more.
    ///
    /// Everything that only made sense with a session goes, the identity and the displayed
    /// balance included — but not the popup-opened flag, which is a fact about the install.
    static func clear() {
        SharedTopUpStore.clearAccount()
    }
}

/// Serialises refreshes across processes.
private actor Refresher {
    static let shared = Refresher()

    /// A call that arrives while one is running waits for it rather than starting a second.
    /// Both would take the lock in turn and the second would find the first's work and adopt
    /// it, so this is not correctness — it is one fewer round trip and one fewer window in
    /// which a failure response can confuse a waiting caller.
    private var inFlight: Task<AppSession.Outcome, Never>?

    func refreshOutcome() async -> AppSession.Outcome {
        if let inFlight { return await inFlight.value }
        let task = Task { await Refresher.perform() }
        inFlight = task
        let result = await task.value
        inFlight = nil
        return result
    }

    private struct Refreshed {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Date
        let userId: String?
    }

    private enum Outcome {
        case success(Refreshed)
        /// The server will not honour this refresh token.
        case rejected
        /// Could not tell — offline, 5xx, rate limited, malformed response.
        case unavailable
    }

    /// Main-actor isolated because everything it touches on `SharedTopUpStore` is: the record is
    /// written from this class's own main-actor entry points, so reading and writing it anywhere
    /// else would need a lock on `UserDefaults` that the rest of the class does not have. The
    /// only await inside it is the network call, which suspends rather than blocking.
    @MainActor
    private static func perform() async -> AppSession.Outcome {
        guard let lock = await SessionLock.acquire(timeout: 5) else {
            // Someone else is refreshing and did not finish in time. Use what is on disk if it
            // is still valid; never start a second refresh without the lock.
            SharedTopUpStore.reloadFromDisk()
            if let stored = SharedTopUpStore.storedSession, stored.expiresAt > Date() { return .session(stored) }
            return .unavailable
        }
        defer { SessionLock.release(lock) }
        SharedTopUpStore.reloadFromDisk()

        guard let stored = SharedTopUpStore.storedSession else { return .none }
        if stored.expiresAt > Date().addingTimeInterval(AppSession.minimumValidity) { return .session(stored) }
        // An expired token with nothing to renew it with is the one genuinely dead end: it is
        // what a record written by a build before this one looks like once its hour is up.
        guard let refreshToken = stored.refreshToken else { return .none }

        switch await requestRefresh(refreshToken) {
        case .success(let fresh):
            let updated = SharedTopUpStore.StoredSession(
                accessToken: fresh.accessToken,
                refreshToken: fresh.refreshToken,
                expiresAt: fresh.expiresAt,
                userId: fresh.userId ?? stored.userId,
                generation: stored.generation + 1
            )
            SharedTopUpStore.writeStoredSession(updated)
            return .session(updated)

        case .rejected:
            // The refusal was for the token we sent. Check once whether the other process
            // rotated it while this request was in flight; if it did, the record is fine.
            SharedTopUpStore.reloadFromDisk()
            if let adopted = SharedTopUpStore.storedSession,
               adopted.generation != stored.generation,
               adopted.expiresAt > Date().addingTimeInterval(AppSession.minimumValidity) {
                return .session(adopted)
            }
            SharedTopUpStore.clearSessionRecord()
            return .none

        case .unavailable:
            // A bad minute on the network is not a sign-out. A token with life left is still
            // worth handing back; one without leaves the caller unable to tell, not signed out.
            return stored.expiresAt > Date() ? .session(stored) : .unavailable
        }
    }

    @MainActor
    private static func requestRefresh(_ refreshToken: String) async -> Outcome {
        guard let url = URL(string: SharedTopUpStore.supabaseBase + "/auth/v1/token?grant_type=refresh_token") else {
            return .unavailable
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(SharedTopUpStore.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["refresh_token": refreshToken])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return .unavailable }

        // 400 and 401 are how GoTrue says the refresh token itself is no good. Everything else
        // that is not a success — 429, 5xx, a captive portal's 200-with-HTML — is a failure to
        // find out, which must not be mistaken for a revocation.
        guard (200..<300).contains(http.statusCode) else {
            return (http.statusCode == 400 || http.statusCode == 401) ? .rejected : .unavailable
        }

        guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = body["access_token"] as? String, !accessToken.isEmpty,
              let newRefreshToken = body["refresh_token"] as? String, !newRefreshToken.isEmpty,
              let expiresIn = (body["expires_in"] as? NSNumber)?.doubleValue, expiresIn > 0 else {
            return .unavailable
        }

        let user = body["user"] as? [String: Any]
        return .success(Refreshed(
            accessToken: accessToken,
            refreshToken: newRefreshToken,
            expiresAt: Date().addingTimeInterval(expiresIn),
            userId: user?["id"] as? String
        ))
    }
}

/// An exclusive lock held across a refresh, so two processes cannot rotate the same token.
///
/// `flock` rather than a sentinel file: the kernel drops it when the descriptor closes, so a
/// crash or a force-quit mid-refresh cannot wedge every later refresh. The file lives in the App
/// Group container, which is the only directory both processes can open by the same path.
///
/// Every failure to lock is reported as nil, and callers proceed unlocked or not at all rather
/// than refusing to work — an unentitled build must still fact-check; it just loses the
/// protection it cannot have anyway.
private enum SessionLock {
    private static var lockURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: SharedTopUpStore.appGroupIdentifier)?
            .appendingPathComponent("disinfax.session.lock")
    }

    static func acquire(timeout: TimeInterval) async -> Int32? {
        guard let path = lockURL?.path else { return nil }
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            if Date() >= deadline {
                close(fd)
                return nil
            }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return fd
    }

    static func release(_ fd: Int32?) {
        guard let fd else { return }
        flock(fd, LOCK_UN)
        close(fd)
    }
}
