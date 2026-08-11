#if os(macOS)
import Foundation
import SafariServices
import AppKit

/// Extracted so TopUpView needs neither SafariServices nor knowledge of the extension's
/// identifier. Mirrors what the old WKWebView UI did from its "open-preferences" message,
/// deliberately without the `NSApp.terminate` that used to follow it — quitting the app the
/// moment the user asks for settings would also kill a top-up they are mid-way through.
enum SafariSettingsOpener {

    /// Derived here rather than referencing the global in ViewController.swift, so this file has
    /// no cross-file dependency and cannot break if that file is ever moved between targets.
    private static var extensionIdentifier: String {
        (Bundle.main.bundleIdentifier ?? "app.disinfax") + ".Extension"
    }

    private static let safariBundleIdentifier = "com.apple.Safari"

    /// Where "Return to Safari" lands the user: the site the extension actually runs on.
    ///
    /// Opening a URL rather than merely activating Safari is deliberate. Activation alone changes
    /// the menu bar and nothing else when Safari's windows are minimised or on another Space —
    /// which is the reported symptom, and why it only appeared to work when Safari happened to be
    /// the previous app. Opening a URL always surfaces a window, in an existing one as a tab if
    /// there is one.
    private static let returnDestination = URL(string: "https://x.com")!

    /// Brings Safari forward after a purchase. macOS only: iOS has no equivalent — an app cannot
    /// activate another. Does not quit this app, so a second top-up needs no relaunch.
    static func activateSafari() {
        openInSafari(returnDestination) { _ in }
    }

    /// Opens Safari's extension settings for DisinfaX.
    ///
    /// Safari is surfaced FIRST, then asked for the settings pane. Called cold, the request lands
    /// on an app with nothing on screen and appears to do nothing — the other half of the same
    /// bug as above. That Safari also comes to the front, and that the pane opens inside Safari's
    /// own Settings window rather than alone, is Apple's behaviour and is not adjustable.
    static func open() {
        openInSafari(returnDestination) { _ in
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier) { _ in }
        }
    }

    /// Opens `url` in Safari specifically — not in the default browser, which may not be Safari
    /// and would not have the extension installed.
    private static func openInSafari(_ url: URL, completion: @escaping (Bool) -> Void) {
        guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: safariBundleIdentifier) else {
            completion(false)
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: safari, configuration: configuration) { _, error in
            DispatchQueue.main.async { completion(error == nil) }
        }
    }
}
#endif
