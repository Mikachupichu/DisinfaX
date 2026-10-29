import Foundation
import AuthenticationServices
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@available(macOS 10.15, iOS 13.0, *)
@MainActor
final class AuthManager: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthManager()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(iOS)
        // Dynamically resolve UIApplication.shared to bypass App Extension compile checks
        if let appClass = NSClassFromString("UIApplication") as? NSObject.Type,
           let app = appClass.value(forKeyPath: "sharedApplication") as? NSObject,
           let scenes = app.value(forKey: "connectedScenes") as? Set<NSObject> {
            // An active scene first: the sheet can only be presented from one, and with several
            // scenes the first key window found may be a background one.
            for scene in scenes {
                if let windowScene = scene as? UIWindowScene,
                   windowScene.activationState == .foregroundActive,
                   let keyWindow = windowScene.windows.first(where: { $0.isKeyWindow }) {
                    return keyWindow
                }
            }
            for scene in scenes {
                if let windowScene = scene as? UIWindowScene,
                   let keyWindow = windowScene.windows.first(where: { $0.isKeyWindow }) {
                    return keyWindow
                }
            }
        }
        return UIWindow()
        #else
        return NSApplication.shared.windows.first { $0.isKeyWindow } ?? NSWindow()
        #endif
    }

    func startOAuthFlow(url: URL, callbackScheme: String) async throws -> String {
        return try await withCheckedThrowingContinuation { continuation in
            // Exactly one of the two paths below may resume — a second resume is
            // SWIFT TASK CONTINUATION MISUSE and traps the process. Both are live in the failure
            // case: a failed `start()` does NOT cancel the session's completion handler, it fires
            // anyway a moment later reporting `canceledLogin` (measured on macOS 27, signing in
            // from the popup), so the flag is read in both.
            var finished = false
            var startFailed = false

            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
                // A failed `start()` has already answered this flow, and its own error is the
                // truthful one: no sheet was ever presented, whatever this handler now reports.
                guard !startFailed, !finished else { return }
                finished = true
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let callbackURL = callbackURL else {
                    continuation.resume(throwing: NSError(domain: "AuthManager", code: -1, userInfo: [NSLocalizedDescriptionKey: "No callback URL received"]))
                    return
                }
                continuation.resume(returning: callbackURL.absoluteString)
            }

            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            // start() returns false when the session cannot be presented — an app extension has
            // no window on iOS or macOS, so presentationAnchor below falls through to a detached
            // window nothing can be presented from. Answering here is what keeps the extension's
            // sendNativeMessage promise from hanging forever (an endless spinner rather than an
            // error).
            if !session.start() {
                startFailed = true
                guard !finished else { return }
                finished = true
                continuation.resume(throwing: NSError(
                    domain: "AuthManager",
                    code: -2,
                    userInfo: [NSLocalizedDescriptionKey:
                        "Could not present the sign-in sheet on this device."]
                ))
            }
        }
    }
}
