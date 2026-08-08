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

                    let jws = try await StoreKitManager.shared.purchaseProduct(
                        amount: amount,
                        userId: userId
                    )

                    self.respond(with: ["signedTransaction": jws], context: context)

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
