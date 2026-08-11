import Foundation

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

    private enum Key {
        static let userId = "topup.userId"
        static let accountSyncedAt = "topup.accountSyncedAt"
        static let balance = "topup.balance"
        static let requestedAmount = "topup.requestedAmount"
        static let lastAmount = "topup.lastAmount"
        static let pendingRecords = "topup.pending.records"
        static let finishable = "topup.finishable"
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

    /// Written by the extension whenever it knows who is signed in. Stamped, so the value can
    /// expire on its own if the extension stops reporting.
    static func setAccount(userId: String, balance: Double?) {
        guard let d = defaults else { return }
        d.set(userId, forKey: Key.userId)
        d.set(Date(), forKey: Key.accountSyncedAt)
        if let balance { d.set(balance, forKey: Key.balance) }
    }

    /// Called when the extension reports that nobody is signed in.
    ///
    /// Clears the identity and the displayed balance — but deliberately NOT the pending records or
    /// the finishable ids. Those are purchases already paid for; discarding them on sign-out would
    /// destroy the only local record of money owed. They carry their own appAccountToken, so they
    /// are credited to whoever actually bought them whenever they are next settled.
    static func clearAccount() {
        guard let d = defaults else { return }
        d.removeObject(forKey: Key.userId)
        d.removeObject(forKey: Key.accountSyncedAt)
        d.removeObject(forKey: Key.balance)
        d.removeObject(forKey: Key.requestedAmount)
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

    /// requested (from the popup) → lastAmount (previous app top-up) → 5.
    /// Clamped, because both stored values are user-influenced and the product ids only exist
    /// for 1...100 — an out-of-range amount would fail the lookup with a confusing error.
    static func initialAmount() -> Int {
        let candidate = takeRequestedAmount() ?? lastAmount ?? 5
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

    private static func rawPendingRecords() -> [[String: Any]] {
        (defaults?.array(forKey: Key.pendingRecords) as? [[String: Any]]) ?? []
    }
}
