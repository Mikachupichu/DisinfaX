import SafariServices
import ExtensionKit

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

                case "PURCHASE_TOPUP":
                    guard let amount = message["amount"] as? Int,
                          let userId = message["userId"] as? String else {
                        self.respond(with: ["error": "Invalid purchase parameters"], context: context)
                        return
                    }

                    // The transaction is intentionally left unfinished here; the client
                    // finishes it with FINISH_TRANSACTION once the worker confirms the
                    // credit. See StoreKitManager.purchaseProduct.
                    let outcome = try await StoreKitManager.shared.purchaseProduct(
                        amount: amount,
                        userId: userId
                    )

                    self.respond(with: [
                        "signedTransaction": outcome.jws,
                        "transactionId": outcome.transactionId,
                    ], context: context)

                case "FINISH_TRANSACTION":
                    guard let transactionId = message["transactionId"] as? String else {
                        self.respond(with: ["error": "Invalid transaction identifier"], context: context)
                        return
                    }

                    let finished = await StoreKitManager.shared.finishTransaction(id: transactionId)
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
