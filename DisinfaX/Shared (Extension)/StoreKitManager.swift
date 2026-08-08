import Foundation
import StoreKit

@available(macOS 12.0, iOS 15.0, *)
@MainActor
final class StoreKitManager {
    static let shared = StoreKitManager()

    func purchaseProduct(amount: Int, userId: String) async throws -> String {
        let productId = "com.disinfax.topup.\(amount)"
        
        let products = try await Product.products(for: [productId])
        guard let product = products.first else {
            throw NSError(domain: "StoreKitManager", code: 404, userInfo: [NSLocalizedDescriptionKey: "Product \(productId) not found in App Store Connect."])
        }

        var options: Set<Product.PurchaseOption> = []
        if let userUUID = UUID(uuidString: userId) {
            options.insert(.appAccountToken(userUUID))
        }

        let result = try await product.purchase(options: options)

        switch result {
        case .success(let verificationResult):
            switch verificationResult {
            case .verified(let transaction):
                let jwsRepresentation = verificationResult.jwsRepresentation
                await transaction.finish()
                return jwsRepresentation
            case .unverified(_, let error):
                throw error
            }
        case .userCancelled:
            throw NSError(domain: "StoreKitManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Purchase cancelled."])
        case .pending:
            throw NSError(domain: "StoreKitManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "Purchase is pending approval."])
        @unknown default:
            throw NSError(domain: "StoreKitManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown purchase error."])
        }
    }
}
