import Foundation
import StoreKit

@available(macOS 12.0, iOS 15.0, *)
@MainActor
final class StoreKitManager {
    static let shared = StoreKitManager()

    struct PurchaseOutcome {
        let jws: String
        let transactionId: String
    }

    /// Presents the StoreKit purchase sheet and returns Apple's signed transaction.
    ///
    /// Deliberately does NOT finish the transaction. Finishing removes it from
    /// StoreKit's queue permanently — it is never redelivered — so finishing before
    /// the balance is credited means any failure after this point (network drop,
    /// worker error, popup closed) leaves the user charged with nothing to show and
    /// no way to recover it. The caller finishes it via `finishTransaction(id:)`
    /// only once the backend has confirmed the credit.
    func purchaseProduct(amount: Int, userId: String) async throws -> PurchaseOutcome {
        let productId = "com.disinfax.topup.v6.\(amount)"

        let products = try await Product.products(for: [productId])
        guard let product = products.first else {
            throw NSError(domain: "StoreKitManager", code: 404, userInfo: [
                NSLocalizedDescriptionKey: "Product \(productId) not found in App Store Connect."
            ])
        }

        var options: Set<Product.PurchaseOption> = []
        if let userUUID = UUID(uuidString: userId) {
            // Binds the purchase to the Supabase account. The worker requires this to
            // match the signed-in user, so a receipt cannot be redeemed by anyone else.
            options.insert(.appAccountToken(userUUID))
        }

        let result = try await product.purchase(options: options)

        switch result {
        case .success(let verificationResult):
            switch verificationResult {
            case .verified(let transaction):
                return PurchaseOutcome(
                    jws: verificationResult.jwsRepresentation,
                    transactionId: String(transaction.id)
                )
            case .unverified(_, let error):
                throw error
            }
        case .userCancelled:
            throw NSError(domain: "StoreKitManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Purchase cancelled."])
        case .pending:
            // Ask to Buy / SCA. The transaction does not exist yet; it will appear in
            // `Transaction.unfinished` once approved, and `pendingTransactions()` picks
            // it up the next time the popup opens.
            throw NSError(domain: "StoreKitManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "Purchase is pending approval."])
        @unknown default:
            throw NSError(domain: "StoreKitManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown purchase error."])
        }
    }

    /// Finishes a transaction once the backend has credited it. Safe to call more than
    /// once: an already-finished transaction is simply absent from `unfinished`.
    @discardableResult
    func finishTransaction(id: String) async -> Bool {
        for await result in Transaction.unfinished {
            guard case .verified(let transaction) = result else { continue }
            if String(transaction.id) == id {
                await transaction.finish()
                return true
            }
        }
        return false
    }

    /// Every purchase Apple still considers undelivered.
    ///
    /// This is the recovery path. Anything paid for but never credited — the app was
    /// killed mid-flow, the worker was down, an Ask to Buy request approved hours
    /// later — stays here until finished, so the client can re-verify and settle it.
    /// Polling this on popup open is the practical equivalent of a long-lived
    /// `Transaction.updates` listener, which an on-demand extension process cannot keep.
    func pendingTransactions() async -> [[String: String]] {
        var pending: [[String: String]] = []
        for await result in Transaction.unfinished {
            guard case .verified(let transaction) = result else { continue }
            pending.append([
                "transactionId": String(transaction.id),
                "signedTransaction": result.jwsRepresentation,
            ])
        }
        return pending
    }
}
