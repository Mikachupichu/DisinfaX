import SafariServices
import ExtensionKit

#if os(macOS)
import AppKit
#endif

@available(macOS 12.0, iOS 15.0, *)
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let userInfo = item.userInfo,
              let message = userInfo[SFExtensionMessageKey] as? [String: Any],
              let action = message["action"] as? String else {
            respond(with: ["error": "Invalid request payload"], context: context)
            return
        }

        Task { @MainActor in
            do {
                switch action {
                case "SIGN_IN":
                    guard let urlString = message["url"] as? String,
                          let authUrl = URL(string: urlString) else {
                        self.respond(with: ["error": "Invalid OAuth URL"], context: context)
                        return
                    }

                    let callbackScheme = (message["callbackUrlScheme"] as? String) ?? "disinfax"

                    let callbackUrl = try await AuthManager.shared.startOAuthFlow(
                        url: authUrl,
                        callbackScheme: callbackScheme
                    )

                    self.respond(with: [
                        "callbackUrl": callbackUrl,
                        "url": callbackUrl
                    ], context: context)

                // The iOS half of the same flow. SIGN_IN above is macOS: it presents the sheet
                // and returns the callback URL in this very reply. An iOS appex cannot present
                // that sheet, so the redirect goes to the `disinfax://` scheme instead, lands in
                // the containing app (see TopUpHandoff) and is parked in the shared container —
                // to be collected here, by whichever of the extension's two collectors asks
                // first. Answered from the container, never from the app: nothing needs to be
                // running for this to work.
                case "GET_PENDING_AUTH":
                    guard SharedTopUpStore.isAvailable else {
                        self.respond(with: ["error": "Shared container unavailable. The App Group entitlement is missing from this build."], context: context)
                        return
                    }
                    // `pending: false` rather than a null or empty URL: the caller's question is
                    // "is there anything to collect", and an empty string would read there as a
                    // callback that failed to parse.
                    if let callbackUrl = SharedTopUpStore.takePendingAuthCallback() {
                        self.respond(with: ["callbackUrl": callbackUrl], context: context)
                    } else {
                        self.respond(with: ["pending": false], context: context)
                    }

                // Prepares a hand-off instead of purchasing. The purchase itself CANNOT happen
                // here: Product.purchase() must present a payment sheet and an app extension has
                // no window to present it in — measured, not assumed. The appex resolves the
                // product fine and then throws StoreKitError.unknown 36ms later, before any
                // network call, which surfaced to the user as "Unable to Complete Request".
                // App Review 4.4 ("extensions may not include ... in-app purchases") agrees.
                //
                // So this writes what the app needs into the shared container and tells the popup
                // to open the app, which owns the amount field, the confirmation and the sheet.
                case "PREPARE_TOPUP":
                    guard let amount = message["amount"] as? Int,
                          let userId = message["userId"] as? String, !userId.isEmpty else {
                        self.respond(with: ["error": "Invalid purchase parameters"], context: context)
                        return
                    }
                    guard SharedTopUpStore.isAvailable else {
                        // The App Group entitlement is missing from this build. Say so plainly:
                        // UserDefaults(suiteName:) fails silently, so without this the popup
                        // would open an app that shows an empty balance and no explanation.
                        self.respond(with: ["error": "Shared container unavailable. The App Group entitlement is missing from this build."], context: context)
                        return
                    }

                    SharedTopUpStore.setAccount(userId: userId, balance: message["balance"] as? Double)
                    SharedTopUpStore.setRequestedAmount(amount)

                    // Try to launch the app from here as well as from JS. Two independent paths
                    // because neither is guaranteed: a browser page may refuse to navigate to a
                    // custom scheme, and an app extension may be denied LaunchServices access.
                    // If the app never opens the feature is simply dead, so `opened` tells the
                    // popup whether it still needs to try — and both attempting is harmless,
                    // since the second one just re-focuses an app that is already frontmost.
                    let opened = await AppLauncher.openTopUp(amount: amount, context: context)

                    self.respond(with: ["handoff": true, "amount": amount, "opened": opened], context: context)

                // Keeps the app→extension channel readable from JS. The app records the verified
                // transaction the instant StoreKit returns it, BEFORE any credit is attempted, so
                // this is what lets the popup finish a purchase the user paid for even if the app
                // was closed, the network dropped, or they came back hours later.
                case "HANDOFF_TRANSACTION":
                    self.respond(with: ["pending": SharedTopUpStore.pendingTransactionPayload()],
                                 context: context)

                // Called only after the worker confirms the credit, and only for the id it
                // confirmed. Separate from reading on purpose: clearing on read would discard a
                // record if the credit then failed, and clearing all of them would discard the
                // purchases that have not been credited yet.
                case "CLEAR_HANDOFF_TRANSACTION":
                    guard let transactionId = message["transactionId"] as? String, !transactionId.isEmpty else {
                        self.respond(with: ["error": "Missing transactionId"], context: context)
                        return
                    }
                    // Clearing the record means the credit is confirmed, which is exactly the
                    // condition that makes finishing safe — so the two are recorded together.
                    SharedTopUpStore.clearPendingTransaction(transactionId: transactionId)
                    SharedTopUpStore.markFinishable(transactionId: transactionId)
                    self.respond(with: ["cleared": true], context: context)

                // Written on every popup open so the app has a user id and a balance to show even
                // when launched directly, without the popup in the loop.
                case "SYNC_ACCOUNT":
                    let syncedUserId = message["userId"] as? String
                    if let userId = syncedUserId, !userId.isEmpty {
                        SharedTopUpStore.setAccount(userId: userId, balance: message["balance"] as? Double)
                    }
                    // The popup's spend-notification setting rides along for the same reason:
                    // the app's own charge notices need it and cannot read extension storage.
                    if let enabled = message["notifySpendEnabled"] as? Bool,
                       let threshold = message["notifySpendThreshold"] as? Double {
                        SharedTopUpStore.setSpendNotifications(enabled: enabled, threshold: threshold)
                    }
                    // Piggy-backed on the account sync rather than given its own action: both are
                    // written by the same popup open, and a second action would mean a second
                    // native round trip for state that is always fresher together anyway.
                    if let accessToken = message["accessToken"] as? String, !accessToken.isEmpty {
                        let expiresAt = (message["accessTokenExpiresAt"] as? Double)
                            .map { Date(timeIntervalSince1970: $0) }
                        // A refresh token means the extension's session is the device's session,
                        // and it goes into the shared record whole so either process can renew
                        // it. The record is the one that matters: a caller that only had an
                        // access token still lands here, and `setSession` keeps that working.
                        if let refreshToken = message["refreshToken"] as? String,
                           !refreshToken.isEmpty, let expiresAt {
                            await AppSession.publish(
                                accessToken: accessToken,
                                refreshToken: refreshToken,
                                expiresAt: expiresAt,
                                userId: syncedUserId
                            )
                        } else {
                            SharedTopUpStore.setSession(accessToken: accessToken, expiresAt: expiresAt)
                        }
                    }
                    self.respond(with: ["synced": SharedTopUpStore.isAvailable], context: context)

                // The session both sides hold, read from the one record. Renews first when the
                // stored token is close to expiring, so a caller never receives one that dies
                // mid-request — and so the extension can start up with a session the app
                // established, or the reverse, without either of them having to be running.
                case "GET_SESSION", "REFRESH_SESSION":
                    guard SharedTopUpStore.isAvailable else {
                        self.respond(with: ["unavailable": true,
                                            "error": "Shared container unavailable. The App Group entitlement is missing from this build."],
                                     context: context)
                        return
                    }
                    switch await AppSession.refreshOutcome() {
                    case .session(let stored):
                        var payload = SafariWebExtensionHandler.sessionPayload(stored)
                        // GET_SESSION answers "is there one"; REFRESH_SESSION answers the
                        // refresh endpoint's own question. Same record either way.
                        if action == "GET_SESSION" { payload["session"] = true } else { payload["ok"] = true }
                        self.respond(with: payload, context: context)
                    case .none:
                        self.respond(with: ["session": false, "rejected": true], context: context)
                    case .unavailable:
                        // Not a sign-out: the caller must keep what it already had.
                        self.respond(with: ["session": false, "unavailable": true], context: context)
                    }

                // The extension minted a session itself (a completed sign-in, or a refresh done
                // in its own storage). Last write wins on expiry, so this cannot walk the record
                // back over a newer rotation — see `AppSession.publish`.
                case "PUBLISH_SESSION":
                    guard let accessToken = message["accessToken"] as? String, !accessToken.isEmpty,
                          let expiresAt = (message["expiresAt"] as? Double).map({ Date(timeIntervalSince1970: $0) }) else {
                        self.respond(with: ["error": "Invalid session payload"], context: context)
                        return
                    }
                    let published = await AppSession.publish(
                        accessToken: accessToken,
                        refreshToken: message["refreshToken"] as? String,
                        expiresAt: expiresAt,
                        userId: message["userId"] as? String
                    )
                    self.respond(with: ["published": published], context: context)

                // A lifetime fact about this install, not a state: the app's instructions switch
                // from "get the extension into Safari" to "how to fact-check" only once the
                // popup has actually been opened, because before that the extension may not even
                // be enabled. Never cleared, not even on sign-out.
                case "POPUP_OPENED":
                    SharedTopUpStore.markPopupOpened()
                    self.respond(with: ["ok": SharedTopUpStore.popupOpenedEver], context: context)

                // Sent when a selection run actually begins — past the popup's charge
                // confirmation and past the sign-in check — so the app can tell a user who
                // fact-checks page selections from one who has only ever used the buttons the
                // extension injects into posts. Like POPUP_OPENED this is a lifetime fact
                // about the install, and is never cleared.
                case "MARK_SELECTION_FACTCHECK":
                    SharedTopUpStore.markSelectionFactCheck()
                    self.respond(with: ["ok": SharedTopUpStore.selectionFactCheckEver], context: context)

                // The popup's sign-in buttons on iOS. They cannot run the flow themselves — an
                // appex has no window for the provider sheet — so the app does the whole thing:
                // sheet, code exchange, session. Nothing needs to come back here afterwards; the
                // extension adopts the record at its next start or refresh.
                case "OPEN_SIGN_IN":
                    guard let provider = message["provider"] as? String,
                          ["google", "apple"].contains(provider) else {
                        self.respond(with: ["error": "Unsupported provider"], context: context)
                        return
                    }
                    let opened = await AppLauncher.openSignIn(provider: provider, context: context)
                    self.respond(with: ["opened": opened], context: context)

                // Sent when the extension knows nobody is signed in. Without it the app kept the
                // last identity it was given and went on selling to a signed-out account — the app
                // has no session of its own, so this message is the only way it can find out.
                case "CLEAR_ACCOUNT":
                    SharedTopUpStore.clearAccount()
                    self.respond(with: ["cleared": true], context: context)

                // The only message that travels app → extension, and it travels by being asked
                // for: nothing can push into an extension. The app stamps when it ends the
                // session itself (see `SharedTopUpStore.clearAccount`), and the extension's
                // background asks on a short timer while it is signed in, so a sign-out here
                // ends the one in Safari within seconds rather than at the next token expiry.
                //
                // Answered from the stamp alone — no refresh, no network, no session — because
                // it is asked repeatedly and must stay cheap enough to be asked repeatedly.
                // No stamp at all is the ordinary case: nobody has signed out on this device.
                case "SIGNED_OUT_AT":
                    guard let at = SharedTopUpStore.signedOutAt else {
                        self.respond(with: [:], context: context)
                        return
                    }
                    self.respond(with: ["signedOutAt": at.timeIntervalSince1970], context: context)

                // What decides the app's how-to-fact-check overlay, asked by the popup so the
                // same instructions can be drawn over it instead of in the strip beside it.
                //
                // Only this subject: the other one asks whether the extension is reachable at
                // all, and a popup that is open over the page has already answered that. The
                // dismissal lives only here — a tap is the one thing neither process can learn
                // from anywhere else — so the popup reads and writes it through these actions
                // rather than keeping a copy, and a tap on either surface silences both.
                case "FACT_CHECK_GUIDE_STATE":
                    self.respond(with: [
                        "selectionFactCheck": SharedTopUpStore.selectionFactCheckEver,
                        "dismissed": SharedTopUpStore.guideOverlayDismissed(.factCheck),
                    ], context: context)

                case "DISMISS_FACT_CHECK_GUIDE":
                    SharedTopUpStore.markGuideOverlayDismissed(.factCheck)
                    self.respond(with: ["dismissed": true], context: context)

                case "FINISH_TRANSACTION":
                    guard let transactionId = message["transactionId"] as? String else {
                        self.respond(with: ["error": "Invalid transaction identifier"], context: context)
                        return
                    }

                    // Reached only after the backend confirmed the credit, so the id is safe to
                    // close out either way. Recorded BEFORE attempting the finish: if this process
                    // cannot finish transactions, the attempt below returns false and nothing else
                    // would ever try again — the transaction would stay open forever and that
                    // product would keep returning it instead of charging. The app finishes
                    // anything left in this list.
                    SharedTopUpStore.markFinishable(transactionId: transactionId)

                    let finished = await StoreKitManager.shared.finishTransaction(id: transactionId)
                    if finished {
                        SharedTopUpStore.clearFinishable(transactionId: transactionId)
                    }
                    self.respond(with: ["finished": finished], context: context)

                case "PENDING_TRANSACTIONS":
                    // Purchases Apple still considers undelivered — anything charged but
                    // not yet credited. The client re-verifies and settles these.
                    let pending = await StoreKitManager.shared.pendingTransactions()
                    self.respond(with: ["pending": pending], context: context)

                default:
                    self.respond(with: ["error": "Unknown action: \(action)"], context: context)
                }
            } catch {
                self.respond(with: ["error": error.localizedDescription], context: context)
            }
        }
    }

    /// The record flattened for JS. Epoch seconds, like the rest of this channel, because the
    /// extension stores what supabase-js stores and that is a number, not a date.
    ///
    /// The refresh token is included: sharing it is the point — whoever holds it can keep the
    /// session alive, and the lock in `AppSession` is what makes it safe for both to.
    private static func sessionPayload(_ stored: SharedTopUpStore.StoredSession) -> [String: Any] {
        var payload: [String: Any] = [
            "accessToken": stored.accessToken,
            "expiresAt": stored.expiresAt.timeIntervalSince1970,
            "generation": stored.generation,
        ]
        if let refreshToken = stored.refreshToken { payload["refreshToken"] = refreshToken }
        if let userId = stored.userId { payload["userId"] = userId }
        return payload
    }

    private func respond(with dictionary: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: dictionary]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

/// Opens the containing app from inside the extension: the top-up screen, or the sign-in sheet.
///
/// Both live in the app and cannot run here — the purchase needs a payment sheet, the sign-in
/// needs a browser surface, and an appex has neither — so getting the user there is the one
/// step that cannot be allowed to silently fail. Each has two callers by design: this, and the
/// popup navigating to the same URL in JS. Whichever works, works; whichever runs second only
/// re-focuses an app that is already frontmost.
///
/// Nothing but the amount, or the provider's bare name, travels in the URL. The user id was
/// already written to the shared container by the caller, so a hand-crafted `disinfax://` link
/// cannot nominate an account.
enum AppLauncher {

    /// Returns whether the app was launched, so the caller can tell the popup whether to try
    /// its own route. Never throws: a failure here is a fallback, not an error.
    @MainActor
    static func openTopUp(amount: Int, context: NSExtensionContext) async -> Bool {
        guard let url = URL(string: "disinfax://topup?amount=\(amount)") else { return false }
        return await open(url: url, context: context)
    }

    /// The same route for the popup's sign-in buttons. The provider is allow-listed by the
    /// caller; only the bare name travels, and the app re-validates it anyway.
    @MainActor
    static func openSignIn(provider: String, context: NSExtensionContext) async -> Bool {
        guard let url = URL(string: "disinfax://signin?provider=\(provider)") else { return false }
        return await open(url: url, context: context)
    }

    @MainActor
    private static func open(url: URL, context: NSExtensionContext) async -> Bool {
#if os(macOS)
        // The SYNCHRONOUS open, deliberately. The async `open(_:configuration:)` variant does not
        // resume until CoreServicesUIAgent reports the launch finished, and that can stall
        // indefinitely — measured: the log showed "LAUNCH: Asking CSUI to launch 1 items" from
        // this process and then nothing, so the continuation never resumed, the handler never
        // replied, and the popup sat waiting until it lost focus and vanished. Which looked
        // exactly like the button doing nothing.
        //
        // This form returns as soon as LaunchServices accepts the request, which is all the
        // caller needs to know. Bringing the app to the front is the app's own job on receiving
        // the URL (see AppDelegate.application(_:open:)), not something to wait on here.
        return NSWorkspace.shared.open(url)
#else
        // iOS gives an appex no NSWorkspace and no UIApplication.shared. NSExtensionContext.open
        // is the only sanctioned route, and it is not guaranteed for this extension point — hence
        // the boolean rather than a fire-and-forget.
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            context.open(url) { success in
                continuation.resume(returning: success)
            }
        }
#endif
    }
}
