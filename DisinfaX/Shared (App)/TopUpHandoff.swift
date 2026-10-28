import Foundation
import SwiftUI
import Combine
import AuthenticationServices
import CryptoKit

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

    /// Posted when a `disinfax://auth-callback` URL is parked, so a window that is already up can
    /// acknowledge it. The launch that this URL started has no observer for this — see
    /// `AuthCallbackNotice`, which is what covers that case.
    static let disinfaxSignedIn = Notification.Name("app.disinfax.signedIn")

    /// Posted when a `disinfax://signin?provider=…` URL asks this app to start a sign-in itself.
    static let disinfaxSignInRequested = Notification.Name("app.disinfax.signInRequested")

    /// Posted when the shared session record changed in a way the views should re-read: a sign-in
    /// this app performed, or a sign-out it was told about.
    ///
    /// Separate from `disinfaxSignedIn`, which is about the hand-off and raises the notice. A
    /// sign-in performed here needs no notice — the landing page it replaces was the notice.
    static let disinfaxSessionChanged = Notification.Name("app.disinfax.sessionChanged")
}

/// A one-shot flag saying this launch has just parked an auth callback, for the window to read
/// when it appears.
///
/// In-process rather than in the App Group, unlike everything else the two processes exchange:
/// the extension has its own copy of the callback and would have nothing to do with a second
/// signal about it. It has to outlive the hand-off rather than the launch, because on a cold
/// start the URL is delivered before there is a window to show anything in — which is why this
/// is a value the view reads on appear instead of state the view owns.
///
/// Consumed on read, for the same reason `takePendingAuthCallback` is: the acknowledgement
/// belongs to the hand-off that produced it, and must not be waiting there on the next launch
/// to describe a sign-in that happened days ago.
@MainActor
enum AuthCallbackNotice {
    private static var isPending = false

    static func mark() { isPending = true }

    static func take() -> Bool {
        defer { clear() }
        return isPending
    }

    /// For the reader that hears the signal itself and so has no use for the value — left set, the
    /// flag would be read by the next appearance of that window and show the notice twice.
    static func clear() { isPending = false }
}

/// Routes the `disinfax://` URLs the extension opens into the app: the top-up hand-off, which
/// becomes the amount TopUpView shows, and the OAuth redirect, which becomes a parked callback
/// for the extension to collect.
///
/// Shapes: `disinfax://topup?amount=12`, `disinfax://auth-callback?code=…`
///
/// Neither carries an identity. For the top-up the user id and balance deliberately travel
/// through the App Group instead: a URL is visible to anything that can observe app launches,
/// and the user id is what binds a purchase to an account. Keeping it out of the URL also means
/// a hand-crafted `disinfax://` link cannot nominate a different account to credit. The
/// auth callback's code is the same shape of non-secret — one-time, and useless to the app,
/// which holds neither the PKCE verifier nor the session.
@MainActor
enum TopUpHandoff {

    /// Returns true when the URL was ours and was handled, so callers can fall through to other
    /// handling for anything else.
    @discardableResult
    static func handle(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "disinfax" else { return false }

        // Accept both disinfax://<action> and disinfax:///<action> — the host/path split differs
        // depending on how the link was constructed, and getting it wrong is a silent no-op.
        let action = (url.host?.isEmpty == false ? url.host! : url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")))

        switch action.lowercased() {
        case "topup":
            handleTopUp(url)
            return true
        case "signin":
            // The popup's provider buttons land here, and so can a link from anywhere else. The
            // app performs the whole flow from this point: it presents the provider's sheet,
            // exchanges the code and owns the session, so the user never has to return to a
            // popup — and never has to open one to sign in at all.
            if let provider = provider(from: url) {
                SignInCoordinator.shared.request(provider)
            }
            return true
        case "auth-callback":
            // Where the provider sends the browser after a sign-in started in the popup. It can
            // only land here: the scheme is ours, and an app extension has no window to present
            // the sheet that would otherwise catch it.
            SharedTopUpStore.setPendingAuthCallback(url.absoluteString)
            // The window says so, because this app being on screen at all is otherwise
            // unexplained — the user pressed "Open" in Safari's own dialog, arrived somewhere
            // that looks like it is doing nothing, and has no way to tell a parked sign-in from
            // one that was dropped. Which of the two it was is not knowable here: only the
            // extension holds the PKCE verifier, so only the extension finds out, and it may be
            // up to a minute before its alarm looks. The wording is therefore about the hand-off
            // having landed and the popup being where to look next, which is true either way —
            // and if the exchange does fail, the popup is where that is reported.
            AuthCallbackNotice.mark()
            NotificationCenter.default.post(name: .disinfaxSignedIn, object: nil)
            return true
        default:
            return false
        }
    }

    /// The amount the user picked in the popup, plus a signal for ViewController to rebuild
    /// TopUpView — which it must, because SwiftUI reads the amount once at view creation.
    ///
    /// Also arms the purchase, so the app starts it on its own rather than waiting for the user to
    /// press Top Up a second time. The purchase still happens entirely here — sheet, amount,
    /// confirmation and all — because an appex has no window to present one in and App Review 4.4
    /// forbids in-app purchases inside an extension. What travels is only the user's decision.
    private static func handleTopUp(_ url: URL) {
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let raw = components.queryItems?.first(where: { $0.name == "amount" })?.value,
           let amount = Int(raw.filter(\.isNumber)), amount >= 1, amount <= 100 {
            SharedTopUpStore.setRequestedAmount(amount)
            // Armed only alongside a usable amount, and deliberately inside this branch rather
            // than after it. The purchase is started with no tap on this screen, so it must never
            // run against the fallback chain — buying the last amount used instead of the one the
            // user just picked is far worse than the tap this saves. An unusable amount leaves the
            // app on its own Top Up button, which is exactly the behaviour there was before.
            SharedTopUpStore.setAutoStartPurchase()
        }
        // No usable amount is not a failure: the app still opens and TopUpView falls back to the
        // last used amount, then to 5. Refusing to open would strand the user with nothing.

        NotificationCenter.default.post(name: .disinfaxTopUpRequested, object: nil)
    }

    /// Only the providers the app's own landing page offers, and only as a bare name — the URL
    /// is the least trustworthy input this file takes, and anything else is ignored rather than
    /// forwarded to the authorization endpoint.
    private static func provider(from url: URL) -> SignInCoordinator.Provider? {
        guard let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "provider" })?.value?.lowercased() else { return nil }
        return SignInCoordinator.Provider(rawValue: raw)
    }
}

/// Signs this app in, without the popup.
///
/// Why the app performs the flow rather than leaving the session to the extension: the app has a
/// window, so it can present `ASWebAuthenticationSession` — the one browser surface the providers
/// accept and the only one that returns through our own scheme without an embedded webview. The
/// extension cannot present it (an appex has no window), which is what forced the old
/// popup-tab-relay-detour. Doing it here also means the app owns the session from the first
/// second, so its balance and fact-check tabs work before the popup has ever been opened.
///
/// PKCE, not the implicit flow: the code that comes back is useless without the verifier this
/// process generates and never lets go of, so an intercepted redirect buys nothing.
@MainActor
final class SignInCoordinator: ObservableObject {
    static let shared = SignInCoordinator()

    /// The providers the project has configured and the popup offers. A closed set rather than a
    /// string so a URL cannot name anything else.
    enum Provider: String {
        case google, apple
    }

    /// The provider whose sheet is up, so the landing page can show that something is happening.
    @Published private(set) var inFlight: Provider?

    /// A sentence to show under the buttons, or nil. Cleared when the next attempt starts.
    @Published private(set) var failure: String?

    /// A sign-in asked for by a URL, held until there is a view to start it from.
    ///
    /// A cold launch delivers the URL before the window exists, so starting the sheet from
    /// `handle` would have nothing to anchor it to. The flag is consumed on appear instead.
    private var pendingProvider: Provider?

    /// Called from `TopUpHandoff` for `disinfax://signin?provider=…`.
    func request(_ provider: Provider) {
        pendingProvider = provider
        NotificationCenter.default.post(name: .disinfaxSignInRequested, object: nil)
    }

    /// Consumed by the landing page when it appears, and by a window already up when the signal
    /// arrives. Idempotent: a second call with nothing pending does nothing.
    func startPendingIfNeeded() {
        guard let provider = pendingProvider, inFlight == nil else { return }
        pendingProvider = nil
        Task { await signIn(provider: provider) }
    }

    func signIn(provider: Provider) async {
        guard inFlight == nil else { return }
        failure = nil
        inFlight = provider
        defer { inFlight = nil }

        let verifier = Self.codeVerifier()
        guard let url = Self.authorizeURL(provider: provider.rawValue, challenge: Self.challenge(for: verifier)) else {
            failure = Self.failureMessage
            return
        }

        do {
            let callback = try await AuthManager.shared.startOAuthFlow(url: url, callbackScheme: "disinfax")
            guard let code = Self.authorizationCode(from: callback),
                  let session = await Self.exchange(code: code, verifier: verifier) else {
                failure = Self.failureMessage
                return
            }
            await AppSession.publish(
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
                expiresAt: session.expiresAt,
                userId: session.userId
            )
            NotificationCenter.default.post(name: .disinfaxSessionChanged, object: nil)
        } catch {
            // Closing the sheet is the user's own decision, and reporting it would be the app
            // arguing with them. Everything else is a failure worth a sentence.
            if (error as NSError).code != ASWebAuthenticationSessionError.canceledLogin.rawValue {
                failure = Self.failureMessage
            }
        }
    }

    private static let failureMessage = String(localized: "Sign-in didn't complete. Please try again.")

    private struct Exchanged {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Date
        let userId: String?
    }

    /// 32 random bytes, base64url-encoded — 43 characters, inside the 43...128 the spec allows.
    /// Random rather than derived from anything about the user: the verifier is a one-time secret
    /// whose only job is to be unguessable.
    private static func codeVerifier() -> String {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: 0...255, using: &rng) }
        return Data(bytes).base64URLEncodedString()
    }

    private static func challenge(for verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
    }

    /// The same `/auth/v1/authorize` the extension builds, with the PKCE pair added.
    ///
    /// `redirect_to` is the scheme the project already allows for the popup's flow, so a sign-in
    /// here is indistinguishable to the provider from one started there — and the callback is
    /// captured by the sheet, never by the URL handler.
    private static func authorizeURL(provider: String, challenge: String) -> URL? {
        var components = URLComponents(string: SharedTopUpStore.supabaseBase + "/auth/v1/authorize")
        components?.queryItems = [
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "redirect_to", value: "disinfax://auth-callback"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "s256"),
        ]
        return components?.url
    }

    private static func authorizationCode(from callback: String) -> String? {
        URLComponents(string: callback)?
            .queryItems?.first(where: { $0.name == "code" })?.value
    }

    /// Turns the one-time code into a session. The verifier is what makes the code redeemable,
    /// which is the whole of PKCE's protection.
    private static func exchange(code: String, verifier: String) async -> Exchanged? {
        guard let url = URL(string: SharedTopUpStore.supabaseBase + "/auth/v1/token?grant_type=pkce") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(SharedTopUpStore.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["auth_code": code, "code_verifier": verifier])

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = body["access_token"] as? String, !accessToken.isEmpty,
              let refreshToken = body["refresh_token"] as? String, !refreshToken.isEmpty,
              let expiresIn = (body["expires_in"] as? NSNumber)?.doubleValue, expiresIn > 0 else { return nil }

        let user = body["user"] as? [String: Any]
        return Exchanged(
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date().addingTimeInterval(expiresIn),
            userId: user?["id"] as? String
        )
    }
}

private extension Data {
    /// base64 with the two URL-unsafe characters swapped and the padding dropped, which is the
    /// only spelling the PKCE spec accepts.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
