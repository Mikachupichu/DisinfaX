//
//  ViewController.swift
//  Shared (App)
//
//  Created by Michaël Pouget on 2026-08-07.
//

import WebKit
import StoreKit
import SwiftUI
import Foundation

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

// Was still the Xcode template placeholder ("com.yourCompany.DisinfaX.Extension"), which
// matches nothing — so getStateOfSafariExtension and showPreferencesForExtension both failed
// silently, leaving the app unable to report whether the extension is enabled. Derived from
// the app's own identifier so it cannot drift out of sync again.
let extensionBundleIdentifier = (Bundle.main.bundleIdentifier ?? "app.disinfax") + ".Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// Rebuilt whenever a `disinfax://topup?amount=N` URL arrives, so an already-running app
    /// picks up the newly requested amount. SwiftUI reads the amount once when the view is
    /// created, so re-hosting is what makes a second hand-off from the popup take effect.
    private var hostingChild: PlatformViewController?

    override func viewDidLoad() {
        super.viewDidLoad()

        // The template's WKWebView UI (Main.html) is replaced by TopUpView. The web view is
        // hidden rather than deleted: it is an @IBOutlet wired up in Main.storyboard, and
        // removing it here would mean editing two storyboards for no functional gain.
        self.webView.isHidden = true

        installTopUpUI()

        NotificationCenter.default.addObserver(
            forName: .disinfaxTopUpRequested, object: nil, queue: .main
        ) { [weak self] _ in
            self?.installTopUpUI()
        }
    }

    /// Shown when the OS predates the top-up UI's requirement. Plain UIKit/AppKit rather than
    /// SwiftUI, so it cannot itself depend on the thing that was unavailable.
    private func installUnsupportedNotice() {
#if os(iOS)
        let label = UILabel()
        label.text = String(localized: "Top-ups need a newer version of iOS. Update, then reopen DisinfaX.")
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
#else
        let label = NSTextField(labelWithString: String(localized: "Top-ups need a newer version of macOS. Update, then reopen DisinfaX."))
        label.alignment = .center
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
#endif
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.8),
        ])
    }

    /// Embeds (or re-embeds) TopUpView as a child filling this controller's view.
    private func installTopUpUI() {
        if let existing = hostingChild {
            existing.view.removeFromSuperview()
            existing.removeFromParent()
            hostingChild = nil
        }

        // A blank window is never an acceptable outcome. Before this, an OS older than the
        // requirement hid the web view, installed nothing, and left the user staring at nothing at
        // all with no way to tell whether the app was broken or still loading.
        guard #available(macOS 13.0, iOS 16.0, *) else {
            installUnsupportedNotice()
            return
        }

        let host = PlatformHostingController(rootView: TopUpView())
#if os(macOS)
        // Makes the controller report SwiftUI's ideal size. Without this a ScrollView-rooted view
        // reports almost nothing, which is why the window kept its storyboard size and cut the
        // content off with no visible hint that there was more below.
        host.sizingOptions = [.preferredContentSize]
#endif
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
#if os(iOS)
        host.didMove(toParent: self)
#endif
        hostingChild = host

#if os(macOS)
        sizeWindowToContent()
#endif
    }

#if os(macOS)
    override func viewDidAppear() {
        super.viewDidAppear()
        // Also here, not only after installing: in viewDidLoad the view has no window yet, so
        // there is nothing to resize at that point.
        sizeWindowToContent()
    }

    /// Fits the window to the SwiftUI content instead of the storyboard's arbitrary size.
    ///
    /// Clamped at both ends: a floor because a half-collapsed purchase form is worse than a
    /// slightly empty one, and a ceiling so the window cannot open taller than the screen it is
    /// on — beyond that the content genuinely does need to scroll.
    private func sizeWindowToContent() {
        guard let window = view.window, let host = hostingChild else { return }

        let ideal = host.preferredContentSize
        let width = max(ideal.width > 0 ? ideal.width : 440, 440)
        let visibleHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        let height = min(max(ideal.height, 420), visibleHeight - 80)

        window.contentMinSize = NSSize(width: 440, height: 420)
        // Only grow or correct an obviously wrong size. Resizing on every appearance would fight
        // the user every time they deliberately made the window bigger.
        let current = window.contentView?.frame.size ?? .zero
        if abs(current.width - width) > 1 || current.height < height - 1 {
            window.setContentSize(NSSize(width: width, height: height))
            window.center()
        }
    }
#endif

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        webView.evaluateJavaScript("show('ios')")
#elseif os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(macOS)
        if (message.body as! String != "open-preferences") {
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                NSApp.terminate(self)
            }
        }
#endif
    }

}
