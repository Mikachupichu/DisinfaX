import Foundation
import StoreKit

@available(macOS 12.0, iOS 15.0, *)
@MainActor
final class StoreKitManager {
    static let shared = StoreKitManager()

    struct PurchaseOutcome {
        let jws: String
        let transactionId: String
        /// Taken from the transaction Apple returned, NOT from what the user asked for. StoreKit
        /// hands back an existing unfinished transaction for the same product rather than charging
        /// again, so the two can differ: ask for $3 while a $1 purchase is still unfinished and
        /// what comes back is the $1. Recording the requested figure would then show a credit that
        /// never arrives — the server also credits from the product id, so $1 is what lands.
        let amount: Int
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

        let products: [Product]
        do {
            products = try await Product.products(for: [productId])
        } catch {
            // Distinguishes "the store returned nothing" (empty array, handled below) from
            // "the fetch itself failed" — which surfaces to the popup as the same opaque
            // "Unable to Complete Request" and is otherwise indistinguishable.
            throw error
        }
        guard let product = products.first else {
            throw NSError(domain: "StoreKitManager", code: 404, userInfo: [
                NSLocalizedDescriptionKey: String(localized: "Product \(productId) not found in App Store Connect.")
            ])
        }

        var options: Set<Product.PurchaseOption> = []
        if let userUUID = UUID(uuidString: userId) {
            // Binds the purchase to the Supabase account. The worker requires this to
            // match the signed-in user, so a receipt cannot be redeemed by anyone else.
            options.insert(.appAccountToken(userUUID))
        }

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase(options: options)
        } catch {
            // The likely failure on macOS: purchase() has to present a sheet, and an appex has
            // no window or scene to present it in. macOS 15.2+ offers purchase(confirmIn:) for
            // exactly this, but it needs an NSWindow the extension does not have.
            throw error
        }

        switch result {
        case .success(let verificationResult):
            switch verificationResult {
            case .verified(let transaction):
                return PurchaseOutcome(
                    jws: verificationResult.jwsRepresentation,
                    transactionId: String(transaction.id),
                    amount: Self.amount(fromProductId: transaction.productID)
                )
            case .unverified(_, let error):
                throw error
            }
        case .userCancelled:
            throw NSError(domain: "StoreKitManager", code: 1, userInfo: [NSLocalizedDescriptionKey: String(localized: "Purchase cancelled.")])
        case .pending:
            // Ask to Buy / SCA. The transaction does not exist yet; it will appear in
            // `Transaction.unfinished` once approved, and `pendingTransactions()` picks
            // it up the next time the popup opens.
            throw NSError(domain: "StoreKitManager", code: 2, userInfo: [NSLocalizedDescriptionKey: String(localized: "Purchase is pending approval.")])
        @unknown default:
            throw NSError(domain: "StoreKitManager", code: -1, userInfo: [NSLocalizedDescriptionKey: String(localized: "Unknown purchase error.")])
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

    private var updatesTask: Task<Void, Never>?

    /// Starts the `Transaction.updates` listener StoreKit expects any app that sells to keep
    /// running. Idempotent, so calling it again from a later launch path is harmless.
    ///
    /// Without it StoreKit logs "Making a purchase without listening for transaction updates
    /// risks missing successful purchases" — and it means it. Anything that completes outside a
    /// `purchase()` call arrives ONLY here: an Ask to Buy request a parent approves hours later,
    /// an SCA challenge finished in the App Store app, a purchase Apple retries after a network
    /// failure. Those would otherwise be paid for and never recorded.
    ///
    /// Records, never finishes. Finishing is the extension's job once the backend confirms the
    /// credit, for the same reason purchaseProduct() does not finish either.
    func startObservingTransactionUpdates() {
        guard updatesTask == nil else { return }
        Task {
            // Order matters: close out what is already credited BEFORE recording what is still
            // owed, so a transaction that was finished a moment ago is not re-recorded as pending.
            await finishCreditedTransactions()
            await recordUnfinishedTransactions()
        }
        updatesTask = Task { [weak self] in
            for await update in Transaction.updates {
                guard let self else { return }
                guard case .verified(let transaction) = update else { continue }
                self.record(update, transaction: transaction)
            }
        }
    }

    /// Sweeps everything Apple still considers undelivered into the shared store.
    ///
    /// `Transaction.updates` only delivers what happens from now on, so without this a purchase
    /// completed while the hand-off was broken would sit unfinished forever with nothing pointing
    /// at it. Run at launch it also recovers purchases made by older builds. Nothing is finished
    /// here; crediting is idempotent on Apple's transaction id, so re-recording is free.
    func recordUnfinishedTransactions() async {
        for await result in Transaction.unfinished {
            guard case .verified(let transaction) = result else { continue }
            record(result, transaction: transaction)
        }
    }

    /// Split out so the amount parsing has one home. The product id is the authority on the
    /// amount here as it is on the server: it is the only value Apple signs that maps to a tier.
    private func record(_ result: VerificationResult<Transaction>, transaction: Transaction) {
        SharedTopUpStore.appendPendingTransaction(
            jws: result.jwsRepresentation,
            transactionId: String(transaction.id),
            amount: Self.amount(fromProductId: transaction.productID)
        )
    }

    /// `com.disinfax.topup.v6.N` -> N. The trailing component is the USD tier, which is what the
    /// server credits from, so parsing it here keeps client and server on the same figure.
    static func amount(fromProductId productId: String) -> Int {
        Int(productId.split(separator: ".").last ?? "") ?? 0
    }

    /// Finishes everything the backend has already credited.
    ///
    /// The counterpart to the extension marking ids finishable. Finishing is what stops Apple
    /// redelivering a transaction and what stops StoreKit returning it instead of charging for the
    /// same product again, so leaving one open is not cosmetic — it makes that amount un-buyable.
    ///
    /// An id that is no longer in `Transaction.unfinished` is already finished, so it is cleared
    /// rather than retried forever.
    func finishCreditedTransactions() async {
        let ids = Set(SharedTopUpStore.finishableTransactions())
        guard !ids.isEmpty else { return }

        var remaining = ids
        for await result in Transaction.unfinished {
            guard case .verified(let transaction) = result else { continue }
            let id = String(transaction.id)
            guard remaining.contains(id) else { continue }
            await transaction.finish()
            SharedTopUpStore.clearFinishable(transactionId: id)
            remaining.remove(id)
        }

        // Whatever is left was not in the unfinished set, i.e. already closed. Dropping these is
        // what keeps the list from growing forever.
        for id in remaining { SharedTopUpStore.clearFinishable(transactionId: id) }
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
