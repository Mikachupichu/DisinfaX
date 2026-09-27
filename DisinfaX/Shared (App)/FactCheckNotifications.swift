import Foundation
import UserNotifications

#if os(macOS)
import AppKit
#endif

extension Notification.Name {
    /// A notification was tapped and the balance is what its reader came for.
    ///
    /// Deliberately not `.disinfaxTopUpRequested`: that one carries a requested amount and
    /// re-hosts the whole surface, which is right for a hand-off from the popup and wrong here —
    /// a fact-check in progress must not be torn down to change which tab is showing.
    static let disinfaxBalanceRequested = Notification.Name("app.disinfax.balanceRequested")
}

/// The app's own notifications for what its Fact-Check tab does.
///
/// The webpage's toasts are the counterpart on x.com and they cover more than this: every balance
/// change and every worker refusal. These are narrower on purpose. Only events the app's *own*
/// Fact-Check tab caused are announced — a spend from a page fact-check, or from the popup at all,
/// is somebody else's notification and must not surface here.
///
/// Narrowing it is also what keeps the balance being read from the server rather than from the App
/// Group. `SharedTopUpStore.balance` is a figure the extension and the popup mirror across, and is
/// stale by exactly what this app has spent whenever neither has run since — which is the one
/// number being watched. This reads the total itself instead: from `get_funds` while its watch is
/// open, and from the Realtime client's subscription to the same row, whichever sees a change
/// first. *While the watch is open* is the whole of the attribution rule — outside it a change
/// cannot be told apart from one the browser caused, and reading for one would be re-reading the
/// same number forever.
///
/// These are local notifications, posted by this process while it runs. There is no push — no
/// `aps-environment` in any entitlements file — and the extension could not supply one anyway: its
/// handler runs in an appex, which has no way to post into the app's own notification center. So
/// nothing arrives while the app is closed, and nothing is meant to.
@MainActor
final class FactCheckNotifier: NSObject, UNUserNotificationCenterDelegate {

    static let shared = FactCheckNotifier()

    // MARK: - Tuning

    /// How often the balance is read while work is in flight, until this connection has been seen
    /// to deliver a funds change.
    ///
    /// A charge lands at one instant in a run lasting tens of seconds, so this is the delay on the
    /// notification rather than a cadence anyone perceives — and each read is a `get_funds` call,
    /// which bills a `funds` unit against a limit that ends in a ban. Fifteen seconds is short
    /// enough that a run cannot end inside one, and a fifth of what this used to spend.
    private static let pollInterval: TimeInterval = 15

    /// How often it is read once this connection has been seen to deliver a funds change instead.
    ///
    /// A delivered change is what turns the poll from the way a charge is noticed into a backstop
    /// for a subscription that goes quiet without saying so — the failure that has no error on it:
    /// a listener dropped server-side, a token filtered out by row-level security. The backstop
    /// still has to exist, because a charge it does not read is a charge nobody is told about; it
    /// only has to be cheap, because the socket is what is carrying it now. And it is billed, which
    /// is what makes a minute the honest interval: a socket that is silent for a whole minute is
    /// broken, and one read is what says so.
    private static let backstopInterval: TimeInterval = 60

    /// How long the watch outlives the work. The charge is written by the backend, from outside
    /// this app — a hold taken as a worker starts, or a settle as it finishes — so the run's last
    /// stream event can reach the app a moment before the row it paid for is written. Stopping on
    /// the same tick as "nothing in flight" would miss exactly the charge that ended the run.
    ///
    /// Long enough to contain a read at `pollInterval` when nothing has proven the socket, because
    /// that read is the whole reason the window exists; the socket covers the same tail instantly
    /// whenever it is working, which is the ordinary case.
    private static let graceAfterWork: TimeInterval = 20

    /// Below this a "decrease" is floating-point noise rather than a charge. The server stores
    /// balance and hold as NUMERIC with 4 decimals, so the real floor on a change is far above it.
    private static let epsilon = 0.00005

    private enum Kind {
        case spend, broke, failure
    }

    /// What the tab was doing, which is what a notification's title names.
    ///
    /// It used to say "Fact check paid" for everything, and paid for every kind of run: a
    /// preclassification, a research, an annotation. Only the amount can be read off the balance —
    /// which pass spent it comes from the model, which registers each one as its request goes out
    /// (see `willBill`).
    enum Activity {
        case disinfact, factCheck, annotate

        /// The pass under the user's own name for it: the label on the button they pressed, from
        /// the same catalog entries those buttons use. All three are translated everywhere already,
        /// which is also why nothing here says "paid" — the notification only exists because a
        /// charge landed, and the amount beside the title is that charge.
        var title: String {
            switch self {
            case .disinfact: return String(localized: "Disinfact")
            case .factCheck: return String(localized: "Fact-Check")
            case .annotate: return String(localized: "Annotate")
            }
        }
    }

    // MARK: - State

    private var started = false

    /// Non-nil exactly while the balance is being watched.
    private var poll: Task<Void, Never>?

    /// Pending end of the watch, delayed by `graceAfterWork`.
    private var grace: Task<Void, Never>?

    /// One read at a time. The RPC is the slow half, and a poll that outran a slow response would
    /// compare the new total against itself and report the difference as a charge.
    private var sampling = false

    /// Deliveries taken into account. Counted rather than flagged so a read can tell whether one
    /// landed while it was in flight — see `sample`.
    private var deliveries = 0

    /// Mirrors the model's own view of whether the Fact-Check tab has anything in flight.
    private var working = false

    /// Which pass the model is running, so a notification can name it. Held past the end of the
    /// work rather than cleared with it: the charge that ends a run is written by the backend, from
    /// outside this app, and the last charge of a run is read a moment after the run's own last
    /// stream event — by which time the model has nothing in flight left to ask. Cleared when the
    /// watch closes, past which nothing is announced.
    ///
    /// The *fallback* name for a charge rather than its name: what a charge is announced under
    /// comes from `pending`, which holds one entry per pass the model has bought. This is what is
    /// left for a charge that arrives with that queue already empty — see `claimPendingPass`.
    private var activity: Activity?

    /// Every pass whose request has gone out and whose charge has not been read yet, oldest first.
    ///
    /// The balance says an amount left and nothing about which request bought it, so a charge has
    /// to be matched to a pass on this side or not at all — and the pass the user last *pressed*
    /// cannot do the matching. One press is not one charge: a Disinfact hands off to a research for
    /// a lone claim, and that second charge is read while the Disinfact is still the last thing
    /// pressed, so both notifications are named after the button. What is recorded here is each
    /// pass as it is bought, and each charge read takes the oldest of them.
    ///
    /// Ordering is all this has to go on, so it is wrong by one pass in the one case where a
    /// request is refused before it is billed: its entry stays queued and the next charge is named
    /// by it. Withdrawing the entry on the failure instead is not the same trade — a run that fails
    /// after its worker started has been paid for, and its charge would then be named by the pass
    /// after it, which is the mistake this exists to stop. The watch closes over both.
    private var pending: [Activity] = []

    /// A pass is about to send the request it will be billed for.
    ///
    /// Called by the model from every path that buys a run — the preclassification, a research (the
    /// one a Disinfact hands off to included), an annotation — at the request itself rather than at
    /// the button, so a pass answered out of the cache, or out of the row's own annotation ranges,
    /// registers nothing and leaves the queue aligned with the charges still to come.
    func willBill(_ pass: Activity) {
        pending.append(pass)
    }

    /// The pass an observed charge belongs to: the oldest pass still waiting for one, or — for a
    /// charge this process never watched go out, which is what the app finds waiting when it
    /// resumes — the pass that was last in flight. Nil only when there is nothing at all to name,
    /// and then the notification falls back to `passTitle`.
    @discardableResult
    private func claimPendingPass() -> Activity? {
        pending.isEmpty ? activity : pending.removeFirst()
    }

    /// What a notification is titled with when no pass was claimed for it: the pass in flight, or
    /// the one that just ended.
    ///
    /// Both kinds that carry a title are about exactly one pass — the one that spent the money,
    /// the one that failed — and the fallback is unreachable in practice, since work in flight
    /// always arrives with its pass named. It exists so a notification can never post with an
    /// empty title.
    private var passTitle: String { activity?.title ?? String(localized: "Fact-Check") }

    /// The last total seen, in the popup's `visibleTotal` sense: balance + hold. Moving money into
    /// a hold is what the backend does while a worker is being paid for, so it must not read as a
    /// change — otherwise every run would announce its own hold as a charge.
    private var lastTotal: Double?

    /// That total, for a caller deciding whether it can afford the next run — nil when no watch is
    /// open, and there is then no balance this process is entitled to an opinion about.
    ///
    /// Nil outside a watch deliberately: `lastTotal` outlives one (the grace window, and the pass
    /// queue behind it), and a figure carried over from a run that has ended is not the balance a
    /// later one starts from. Balance + hold rather than balance is what makes it usable for that
    /// decision at all — a hold moves money between the two and leaves the sum where it was, so a
    /// run already in flight does not read as money that has gone.
    var visibleTotal: Double? { poll == nil ? nil : lastTotal }

    /// Set when a notification is tapped, cleared by whichever surface acts on it. Exists for the
    /// tap that launches the app: `didReceive` can run before any view is on screen, and a
    /// notification posted into a NotificationCenter with no observers reaches nobody.
    private var balanceRequestPending = false

    private override init() { super.init() }

    // MARK: - Lifecycle

    /// Called at launch from both app delegates, before the app is running: a tap is delivered to
    /// whoever registered as the delegate first, and a tap that cold-launches the app is delivered
    /// to nobody if that happens after the launch completes.
    func start() {
        guard !started else { return }
        started = true

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
            // Not a failure worth surfacing: without permission the app simply loses a courtesy,
            // and everything it announces is still on screen in the app itself.
            if let error { print("[notifications] authorization unavailable: \(error.localizedDescription)") }
        }
    }

    /// Whether the Fact-Check tab has work in flight, and which pass it is. Idempotent in `value`,
    /// and driven from one expression in the model so the two cannot disagree about what "in
    /// flight" means.
    ///
    /// `activity` is optional and does not clear the stored one: a model with nothing in flight has
    /// no pass to name, and the pass that just finished is the one the charge arriving in the grace
    /// window belongs to. See the property.
    func setWorking(_ value: Bool, activity: Activity? = nil) {
        if let activity { self.activity = activity }
        guard value != working else { return }
        working = value

        if value {
            // Work resumed inside the grace window, so the watch never had to be reopened.
            grace?.cancel()
            grace = nil
            startPolling()
            return
        }

        // See `graceAfterWork`: the last charge of a run is the one that arrives a moment late.
        grace?.cancel()
        grace = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.graceAfterWork * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            self.grace = nil
            guard !self.working else { return }
            self.stopPolling()
        }
    }

    // MARK: - Reporting

    /// A run failed. Posted the moment it happens rather than folded into the poll: the row's own
    /// error text is already on screen, and this is the same news for a user who has looked away.
    func reportFailure(_ reason: String) {
        guard !reason.isEmpty else { return }
        post(.failure, reason: reason)
    }

    /// True once, for a tap that has not yet been acted on. See `balanceRequestPending`.
    @discardableResult
    func consumeBalanceRequest() -> Bool {
        guard balanceRequestPending else { return false }
        balanceRequestPending = false
        return true
    }

    // MARK: - Watching the balance

    private func startPolling() {
        guard poll == nil else { return }
        // Only a notifier the app's delegates started has anything to announce: `start()` runs at
        // launch, and an app extension never calls it. This watch reads `get_funds` — a **billed**
        // RPC — on a fixed cadence, so without this a share sheet would open a second poller for
        // charges already on the screen in front of the user. See `post`.
        guard started else { return }
        // A watch is exactly when a live balance is worth a subscription, and asking for it here is
        // what makes the socket available to shorten this poll and to post a charge the moment it
        // is written. Idempotent, and silent without a live token — and then the poll below is the
        // only way a charge can be seen, which is why it keeps its fast interval until something
        // has actually been delivered.
        SupabaseRealtime.shared.ensureFundsChannel()
        poll = Task { [weak self] in
            // The cadence is printed where it is chosen, and only when it changes. Which of the two
            // speeds a run is on is not visible from the outside at all — and a run that has stopped
            // reading is the one thing worth being able to rule out from a log.
            var interval = self?.nextInterval() ?? Self.pollInterval
            print("[notifications] balance poll: \(Int(interval))s")
            // The baseline comes first, before anything this run can be charged for, so the first
            // charge is measured against the balance as it stood when the work began — and a change
            // made while the app sat idle, in the popup or on a page, is not attributed to it.
            await self?.sample(baseline: true)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard !Task.isCancelled else { return }
                await self?.sample(baseline: false)
                let next = self?.nextInterval() ?? Self.pollInterval
                if next != interval {
                    interval = next
                    print("[notifications] balance poll: \(Int(interval))s")
                }
            }
        }
    }

    /// How long to wait before the next read. See `backstopInterval`: the long one applies only
    /// once this connection has been seen to deliver a funds change, so a socket that is joined but
    /// silent — or absent, or joined under a token that has since rolled — keeps the fast interval
    /// and behaves exactly as it did before there was a socket at all. Nothing here is made slower
    /// on the strength of something that has not been observed to work.
    private func nextInterval() -> TimeInterval {
        SupabaseRealtime.shared.fundsDelivered ? Self.backstopInterval : Self.pollInterval
    }

    private func stopPolling() {
        poll?.cancel()
        poll = nil
        // Nothing here is watching a balance any more, so nothing here is owed a rejoin: released
        // rather than left asked for, because the request outlives the run by as long as the app
        // runs and a dropped socket would otherwise spend a billed read a minute bringing back a
        // figure with no reader. See `SupabaseRealtime.releaseFundsChannel`.
        SupabaseRealtime.shared.releaseFundsChannel()
        // Only the watch posts a spend, so the pass it was naming has nothing left to label — and
        // neither has any pass still queued behind it, every one of them bought inside this same
        // watch. Keeping them would let a later run's first charge be named by a pass from this
        // one.
        activity = nil
        pending.removeAll()
    }

    private func sample(baseline: Bool) async {
        guard !sampling else { return }
        sampling = true
        defer { sampling = false }

        // This read is issued here and answered later, and a delivery can land in between carrying a
        // change it was served too early to include. Which of the two is the older cannot be told
        // from their contents, so a read a delivery overtook is dropped rather than applied: if it
        // was the older, applying it would carry `lastTotal` back over a charge already announced
        // and leave the next read to announce the same money leaving a second time.
        let seen = deliveries
        guard let total = await Self.fetchTotal() else { return }
        guard deliveries == seen else { return }
        record(total, baseline: baseline)
    }

    /// A total somebody else read: the Realtime client, on the funds row it holds a subscription
    /// to. The charge arrives as it is written rather than at the next tick.
    ///
    /// Ignored unless a watch is open, and `lastTotal` is left untouched while one is not. This
    /// socket delivers the app every change to that row, including the ones the browser caused — a
    /// fact-check on a page, a top-up in the popup — and announcing those is the one thing these
    /// notifications exist not to do. Untouched rather than tracked so that the next watch's
    /// baseline is read fresh instead of being measured against a total nothing was watching.
    func observe(total: Double) {
        guard poll != nil else { return }
        deliveries += 1
        record(total, baseline: false)
    }

    /// The one place a total becomes a notification, whichever source produced it.
    ///
    /// One place because the two sources have to agree about what they have already seen:
    /// whichever reads a change first announces it and carries `lastTotal` past it, and the other
    /// then finds no difference left to report. Two baselines would announce the same charge twice.
    ///
    /// `baseline` marks the reading taken to establish where a watch started rather than to compare
    /// against: a change made between two watches, in the popup or on a page, is neither this tab's
    /// nor this watch's. See `sample` for the reading that a delivery overtakes, which is dropped
    /// before it reaches here.
    private func record(_ total: Double, baseline: Bool) {
        guard let previous = lastTotal else {
            lastTotal = total
            return
        }
        lastTotal = total
        guard !baseline else { return }

        let spent = previous - total
        // Only a decrease. An increase is a top-up, which this tab cannot cause — and the popup
        // announces its own.
        guard spent > Self.epsilon else { return }

        // The crossing into empty replaces the amount rather than following it: what is left to
        // do about a balance of nothing is add to it, and the exact size of the last charge is not
        // the part that matters. Its pass is claimed all the same, and for the queue's sake rather
        // than for the title's: one drop is one pass's charge, and an entry left behind by this one
        // would name the next charge with this pass.
        if total <= Self.epsilon {
            claimPendingPass()
            post(.broke)
        } else {
            post(.spend, amount: spent, title: claimPendingPass()?.title)
        }
    }

    /// The caller's own funds row, from the RPC the popup reads its own balance with.
    ///
    /// Every failure returns nil, and nil announces nothing: a signed-out session, a dropped
    /// request, a body that is not JSON are all reasons to stay quiet rather than to announce a
    /// change that may not have happened.
    ///
    /// Shared rather than private because the Realtime client reads it too, to cover what a
    /// dropped socket could not deliver — one implementation of this RPC, and one place that
    /// defines "the caller's total" as balance + hold.
    static func fetchTotal() async -> Double? {
        guard let token = SharedTopUpStore.session?.accessToken,
              let url = URL(string: "\(FactCheckClient.supabaseBase)/rest/v1/rpc/get_funds") else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(FactCheckClient.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) else { return nil }

        // `get_funds` returns a SETOF, so the body is a one-element array; a bare object is taken
        // too, because PostgREST collapses a single-row result to an object and this should not be
        // the thing that breaks if that ever becomes the shape here.
        let row = (json as? [[String: Any]])?.first ?? (json as? [String: Any])
        guard let row, row["balance"] != nil || row["hold"] != nil else { return nil }

        return (row["balance"] as? Double ?? 0) + (row["hold"] as? Double ?? 0)
    }

    // MARK: - Posting

    private func post(_ kind: Kind, amount: Double = 0, reason: String = "", title: String? = nil) {
        // Nothing to announce from an app extension: it is not the app, its one surface is the
        // sheet the user is already looking at, and it is gone by the time a charge lands. See
        // `startPolling`.
        guard started else { return }
        let content = UNMutableNotificationContent()
        content.sound = .default

        switch kind {
        case .spend:
            // The pass the charge was claimed for, which the caller resolved against the queue of
            // them. `passTitle` here is the name of last resort, for a charge with no pass left to
            // claim and none in flight either.
            content.title = title ?? passTitle
            content.body = "-" + UsdFormat.string(from: amount)
        case .broke:
            content.title = String(localized: "Your balance is empty")
            content.body = String(localized: "Add funds on the Balance tab to keep fact-checking.")
        case .failure:
            // The reason, not a sentence saying there is one: what reaches here is already the
            // message for the worker's own error code, in the user's language, and the same one
            // the claim's row is showing (see `FactCheckError`). The title is the pass that
            // failed, which is the one thing the message cannot say — and a label the buttons
            // already carry, so it costs no translation.
            content.title = passTitle
            content.body = reason
        }

        // A post that succeeds leaves no trace anywhere else, and the one question this feature
        // gets asked is whether two charges arrived or one arrived twice — indistinguishable in
        // Notification Center, and told apart by this line and nothing else. Two charges is the
        // answer whenever one press bought two passes; see `pending`.
        print("[notifications] posted \"\(content.title)\" \(content.body)")

        // A fresh identifier each time: two charges in one run are two notifications, not the
        // second replacing the first before it was ever read.
        let request = UNNotificationRequest(
            identifier: "app.disinfax.factcheck.\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error { print("[notifications] could not post: \(error.localizedDescription)") }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Shown while the app is frontmost, which is the only situation these are posted in. Without
    /// a banner the notification would be invisible at the exact moment it is certain to be
    /// relevant — a badge appearing in a window the user is looking at, saying nothing.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    /// A tap lands on the balance for every kind, the way the popup's own notifications do. A red
    /// one is the case that needs it most: a failure is usually the balance, or the lack of it,
    /// refusing to pay, so the answer is on the Balance tab rather than wherever the user was.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            self.balanceRequestPending = true
#if os(macOS)
            // The banner was clicked, so this app is what the user asked for — and it may be
            // behind whatever they were reading when the banner appeared.
            NSApp.activate(ignoringOtherApps: true)
#endif
            NotificationCenter.default.post(name: .disinfaxBalanceRequested, object: nil)
            completionHandler()
        }
    }
}
