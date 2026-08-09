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
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme
            ) { callbackURL, error in
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
            // start() returns false when the session cannot be presented, and in that case the
            // completion handler above is NEVER invoked — so without this the continuation is
            // never resumed, beginRequest never calls completeRequest, and the extension's
            // sendNativeMessage promise hangs forever (an endless spinner rather than an error).
            // That is the iOS failure mode: an app extension has no UIApplication.shared and no
            // UIScene, so presentationAnchor falls through to a detached UIWindow() that nothing
            // can be presented from.
            if !session.start() {
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
