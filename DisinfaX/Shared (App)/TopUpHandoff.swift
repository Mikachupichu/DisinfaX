import Foundation
import SwiftUI

/// Cross-platform aliases so ViewController can host SwiftUI with one code path instead of two
/// `#if os(...)` branches at every use site.
#if os(iOS)
import UIKit
typealias PlatformHostingController = UIHostingController
#elseif os(macOS)
import Cocoa
typealias PlatformHostingController = NSHostingController
#endif

extension Notification.Name {
    /// Posted when a `disinfax://topup` URL is opened. ViewController re-hosts TopUpView in
    /// response, because SwiftUI reads the requested amount once at view creation — without a
    /// rebuild, a second hand-off from the popup would silently keep the first amount.
    static let disinfaxTopUpRequested = Notification.Name("app.disinfax.topUpRequested")
}

/// Parses the hand-off URL the extension opens and stores the requested amount for TopUpView.
///
/// Shape: `disinfax://topup?amount=12`
///
/// The amount is the only thing carried in the URL. The user id and balance deliberately travel
/// through the App Group instead: a URL is visible to anything that can observe app launches, and
/// the user id is what binds a purchase to an account. Keeping it out of the URL also means a
/// hand-crafted `disinfax://` link cannot nominate a different account to credit.
enum TopUpHandoff {

    /// Returns true when the URL was ours and was handled, so callers can fall through to other
    /// handling for anything else.
    @discardableResult
    static func handle(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "disinfax" else { return false }

        // Accept both disinfax://topup and disinfax:///topup — the host/path split differs
        // depending on how the link was constructed, and getting it wrong is a silent no-op.
        let action = (url.host?.isEmpty == false ? url.host! : url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
        guard action.lowercased() == "topup" else { return false }

        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let raw = components.queryItems?.first(where: { $0.name == "amount" })?.value,
           let amount = Int(raw.filter(\.isNumber)), amount >= 1, amount <= 100 {
            SharedTopUpStore.setRequestedAmount(amount)
        }
        // No usable amount is not a failure: the app still opens and TopUpView falls back to the
        // last used amount, then to 5. Refusing to open would strand the user with nothing.

        NotificationCenter.default.post(name: .disinfaxTopUpRequested, object: nil)
        return true
    }
}
