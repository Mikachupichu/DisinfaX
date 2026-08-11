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
                    if let userId = message["userId"] as? String, !userId.isEmpty {
                        SharedTopUpStore.setAccount(userId: userId, balance: message["balance"] as? Double)
                    }
                    self.respond(with: ["synced": SharedTopUpStore.isAvailable], context: context)

                // Sent when the extension knows nobody is signed in. Without it the app kept the
                // last identity it was given and went on selling to a signed-out account — the app
                // has no session of its own, so this message is the only way it can find out.
                case "CLEAR_ACCOUNT":
                    SharedTopUpStore.clearAccount()
                    self.respond(with: ["cleared": true], context: context)

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

    private func respond(with dictionary: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: dictionary]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

/// Opens the containing app on the top-up screen from inside the extension.
///
/// The purchase lives in the app (see SharedTopUpStore for why), so getting the user there is
/// the one step that cannot be allowed to silently fail. It has two callers by design: this,
/// and the popup navigating to the same URL in JS. Whichever works, works; whichever runs
/// second only re-focuses an app that is already frontmost.
///
/// Nothing but the amount travels in the URL. The user id was already written to the shared
/// container by the caller, so a hand-crafted `disinfax://` link cannot nominate an account.
enum AppLauncher {

    /// Returns whether the app was launched, so the caller can tell the popup whether to try
    /// its own route. Never throws: a failure here is a fallback, not an error.
    @MainActor
    static func openTopUp(amount: Int, context: NSExtensionContext) async -> Bool {
        guard let url = URL(string: "disinfax://topup?amount=\(amount)") else { return false }

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
