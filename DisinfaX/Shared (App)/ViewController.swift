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

/// The heights `RootView`'s own layout knows about itself, for a window that cannot ask it.
///
/// `NSHostingView` sized with `sizingOptions = []` has no ideal size to read: `fittingSize.height`
/// is 0 there however long it is left to settle, which is why the window's opening height has to
/// be reported out of the layout rather than measured off the hosting view.
///
/// Three figures, because the one that is wanted is a difference. `root` is the whole column and
/// `panes` is the region inside it that holds the two tab panes — so `root - panes` is the chrome
/// that has to fit on either tab (the picker above, the guide below), and adding the balance
/// pane's own natural height to that gives the window height the balance tab wants. The panes
/// themselves are ScrollViews that fill whatever they are given, so their measured height says
/// nothing about their content; `topUp` is measured on the content instead, inside that scroll.
struct PaneHeights: Equatable {
    var root: CGFloat = 0
    var panes: CGFloat = 0
    var topUp: CGFloat = 0
}

/// Internal rather than private because `TopUpView` reports the `topUp` figure from its own file:
/// only its content can measure itself, since at the call site all that is visible is the
/// ScrollView wrapping it.
struct PaneHeightsKey: PreferenceKey {
    static var defaultValue = PaneHeights()
    static func reduce(value: inout PaneHeights, nextValue: () -> PaneHeights) {
        let next = nextValue()
        // Per field, not per report: each of the three is written by a different reporter, and
        // taking the last one whole would let whichever reported latest blank the other two.
        value.root = max(value.root, next.root)
        value.panes = max(value.panes, next.panes)
        value.topUp = max(value.topUp, next.topUp)
    }
}

/// The app's two surfaces, one window.
///
/// Both are kept mounted and merely hidden, rather than swapped in and out of the hierarchy. Two
/// reasons, and the first is the one that matters: a fact-check in progress is a paid request, so
/// losing it because the user glanced at their balance would cost them money. The second is that
/// the money view stays live while the other tab is up, which is the whole point of a balance.
///
/// Landing on Top Up, always — that is what the app has opened to until now, and it is also what
/// an incoming `disinfax://topup` hand-off is asking for: tapping Top Up in the popup opens the
/// balance, whichever tab was up at the time. That is why the tab starts at `initialTab` on every
/// re-host rather than being restored: the hand-off is a request to spend, and it wins over where
/// the user happened to be looking.
///
/// Re-hosting used to be the only thing that made the tab switch, and it took the fact-check
/// surface down with it. The model is now passed in from the controller so the reset costs the
/// user nothing but a lost glance.
@available(macOS 13.0, iOS 16.0, *)
struct RootView: View {

    enum Tab: Hashable {
        case factCheck, topUp

        var title: LocalizedStringKey {
            switch self {
            case .factCheck: return "Fact-Check"
            case .topUp: return "Top Up"
            }
        }
    }

    /// Owned by `ViewController` and threaded down, so that re-hosting on a hand-off rebuilds the
    /// chrome around a running fact-check instead of discarding it.
    let factCheckModel: FactCheckModel

    /// Called with the height the balance tab needs, once the layout has reported one. See
    /// `PaneHeights` for why this cannot be measured from the outside.
    var onMeasuredHeight: ((CGFloat) -> Void)?

    @State private var tab: Tab

    init(factCheckModel: FactCheckModel, initialTab: Tab = .topUp, onMeasuredHeight: ((CGFloat) -> Void)? = nil) {
        self.factCheckModel = factCheckModel
        self.onMeasuredHeight = onMeasuredHeight
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        VStack(spacing: 0) {
            // No label: the two segments name themselves.
            Picker(selection: $tab) {
                ForEach([Tab.topUp, Tab.factCheck], id: \.self) { Text($0.title).tag($0) }
            } label: {
                EmptyView()
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            .padding(.horizontal, 24)
            .padding(.top, 18)
            .padding(.bottom, 2)

            ZStack {
                TopUpView().tabPane(visible: tab == .topUp)
                FactCheckView(model: factCheckModel).tabPane(visible: tab == .factCheck)
            }
            .background(GeometryReader { proxy in
                Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(panes: proxy.size.height))
            })

            // Below the panes rather than inside one of them, because the tab this belongs on is
            // both of them: it is about getting the extension running at all, and a user who
            // cannot get DisinfaX to appear in Safari may well be sitting on the fact-check tab
            // while they work out why. Outside their ScrollViews as well, so it stays put instead
            // of scrolling away with whichever pane is up — neither pane is guaranteed to reach
            // the bottom of the window.
            Divider()
                .padding(.horizontal, 24)

            SafariGuide()
                .frame(width: 392, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 14)
                .padding(.bottom, 18)
        }
        // Matches TopUpView's own content width, plus its 24pt side padding, so the picker lines
        // up with the fields below it instead of hovering over a wider window.
        .frame(width: 392 + 48)
        .background(GeometryReader { proxy in
            Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(root: proxy.size.height))
        })
        .onPreferenceChange(PaneHeightsKey.self) { heights in
            // The chrome is what has to fit whichever tab is up; the balance pane's content is
            // what the window should additionally have room for. A pane taller than that scrolls,
            // which is the point — the window stops where the balance view ends.
            guard heights.root > heights.panes, heights.topUp > 0 else { return }
            onMeasuredHeight?(heights.root - heights.panes + heights.topUp)
        }
        // Moving the tab rather than re-hosting. `installTopUpUI` is what a popup hand-off needs,
        // because it also has a new amount to pick up; a tapped notification is asking only to be
        // looked at, and rebuilding the surface under it would be work with nothing to show for it.
        .onReceive(NotificationCenter.default.publisher(for: .disinfaxBalanceRequested)) { _ in
            FactCheckNotifier.shared.consumeBalanceRequest()
            tab = .topUp
        }
        // The same request, for the tap that cold-launched the app: that is delivered before this
        // view exists, so the signal above has no observer yet and the flag is all that is left.
        .onAppear {
            if FactCheckNotifier.shared.consumeBalanceRequest() { tab = .topUp }
        }
    }
}

private extension View {
    /// Hidden but alive. `opacity` rather than an `if`, so the view keeps its state and keeps
    /// running; `allowsHitTesting` and `accessibilityHidden` so "hidden" is true for the mouse,
    /// the keyboard and VoiceOver rather than only for the eye.
    func tabPane(visible: Bool) -> some View {
        opacity(visible ? 1 : 0)
            .allowsHitTesting(visible)
            .accessibilityHidden(!visible)
    }
}

/// How to get the extension running, under both tabs.
///
/// It was the tail of `TopUpView`, which meant it was readable only by someone already on the
/// top-up tab — the opposite of who needs it. Nothing here depends on the balance or on a session,
/// so nothing about it belonged to that screen; the step that matters most, enabling the extension
/// in Safari, is exactly the one a user on the fact-check tab is looking for.
@available(macOS 13.0, iOS 16.0, *)
private struct SafariGuide: View {

    /// Carried over from `TopUpView`'s own tint, which no longer reaches here — the guide sits
    /// under both tabs now, and a `.tint` on the root would recolour the tab picker with it. Its
    /// own literal, like the other two, rather than a shared constant.
    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("USING DISINFAX IN SAFARI")
                .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
                .padding(.bottom, 2)
            step(1, "Open Safari and go to x.com.")
#if os(macOS)
            step(2, "Enable DisinfaX in Safari Settings → Extensions.")
            step(3, "Click the DisinfaX icon in the Safari toolbar to open the popup.")
            Button("Open Safari Extension Settings…") { SafariSettingsOpener.open() }
                .padding(.top, 4)
#else
            // The extensions button (puzzle piece), NOT the Aa page-settings menu this used to
            // name — they are different controls in the address bar and only one of them lists
            // extensions. Built from three separate Text pieces rather than one interpolated
            // literal: a single Text("... \(Image(...)) ...") call bundles the icon into one
            // opaque localization key with no way to translate the surrounding words reliably.
            // Splitting it means the two text pieces are ordinary, independently-localizable Text
            // literals, and only the icon's position relative to them stays fixed across languages.
            step(2, Text("Tap the ") + Text(Image(systemName: "puzzlepiece.extension")) + Text(" icon in the address bar, then Manage Extensions, and turn on DisinfaX."))
            step(3, "Tap the same icon and choose DisinfaX to open the popup.")
#endif
        }
        .tint(Self.accent)
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n).").font(.callout).bold().foregroundStyle(.secondary).frame(width: 18, alignment: .trailing)
            text.font(.callout).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View { step(n, Text(text)) }
}

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    /// Rebuilt whenever a `disinfax://topup?amount=N` URL arrives, so an already-running app
    /// picks up the newly requested amount. SwiftUI reads the amount once when the view is
    /// created, so re-hosting is what makes a second hand-off from the popup take effect — and it
    /// is also what lands the user on the balance tab rather than wherever they were.
    private var hostingChild: PlatformViewController?

    /// The fact-check surface's state, held here rather than by the view.
    ///
    /// Unavoidably untyped: `FactCheckModel` is macOS 13 / iOS 16 and up while this controller is
    /// not, and a stored property cannot carry an availability annotation. One cast, in the one
    /// place that needs it, is cheaper than an availability-gated wrapper class around it.
    private var factCheckModel: AnyObject?

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

    /// Embeds (or re-embeds) the SwiftUI root as a child filling this controller's view.
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

        // Created once, reused by every later re-host. This is the whole point of holding it up
        // here: a fact-check that has already been paid for has to outlive a hand-off that only
        // wanted to change which tab is showing.
        let factCheckModel = (self.factCheckModel as? FactCheckModel) ?? FactCheckModel()
        self.factCheckModel = factCheckModel

        // Before the tree is built, because what decides how tall the balance pane is decides which
        // of its states is drawn first: the card needs a fresh identity, and the sentence standing in
        // for one is half the height. The stamp is written by the extension, from another process, so
        // without this the opening layout measures the signed-out pane on a launch that is nothing
        // of the sort — and the window opens at that height. `TopUpView` re-reads it on appear for
        // the same reason; this is the one that has to happen before the first measurement.
        SharedTopUpStore.reloadFromDisk()

        let host = PlatformHostingController(
            rootView: RootView(
                factCheckModel: factCheckModel,
                initialTab: .topUp,
                // Weakly, and macOS-only: the closure lives in the view tree the controller owns,
                // so a strong capture would be a cycle. The height is a macOS window concern — on
                // iOS the hosting controller fills the screen and is sized by the system.
                onMeasuredHeight: { [weak self] height in
#if os(macOS)
                    self?.applyMeasuredHeight(height)
#else
                    _ = height
#endif
                }
            )
        )
#if os(macOS)
        // Deliberately NOT `sizingOptions = [.preferredContentSize]`, which is what this used to
        // be. That made SwiftUI's ideal size the window's size — and the ideal size of a
        // ScrollView-rooted pane is the height of everything inside it, so each claim the
        // fact-check tab added made the window taller. A text with a handful of claims grew it
        // past the bottom of the display, where the tail of it could not be reached at all.
        //
        // The panes scroll. The window's height is now the window's own business, set once below
        // and left to the user from then on.
        host.sizingOptions = []
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
    }

#if os(macOS)
    /// Keeps the content view the size of the window, which SwiftUI does not.
    ///
    /// `NSHostingView` lays its content out at the content's own ideal height — the whole balance
    /// view, 843pt of it — and takes its superview, this controller's view, with it: the content
    /// view ended up taller than the window containing it, so the layout was done at 843 while
    /// only the top 584pt of it was on screen. That is both of the things this pane was reported
    /// for, and neither of them was a spacing decision: the balance pane, given 646pt for 387pt of
    /// content, left the rest of it blank, and the picker sat above the visible area.
    ///
    /// An empty `sizingOptions` (set where the host is created), low hugging and compression
    /// priorities, and a resizable style mask were each tried against this and none of them moved
    /// it, so the frame is re-asserted here instead. Cheap and convergent: the second pass finds
    /// the two equal and does nothing.
    override func viewDidLayout() {
        super.viewDidLayout()
        guard let window = view.window else { return }
        let size = window.contentLayoutRect.size
        guard size.height > 0, view.frame.size != size else { return }
        view.frame.size = size
    }

    /// Grows the window to the height the balance view reports needing. See `PaneHeights`.
    ///
    /// The height used to be a number picked by hand — 760, clamped to the screen — which the
    /// balance view never filled: this is the figure that replaced it, and it is the balance view's
    /// own height plus the chrome around it.
    ///
    /// Grows, and never shrinks. The first report is not necessarily the balance view at rest: the
    /// card is drawn only against a fresh identity, and freshness is read from the shared container
    /// that the extension writes from another process, so a launch that has not re-read it yet
    /// measures the pane without the card — half its height. Obeying that report once and only once
    /// is what left the top-up card scrolling inside a window sized for the sentence above it.
    /// Obeying the taller one when the card is measured is the correction.
    ///
    /// Not shrinking is what keeps it out of the way otherwise. A report no taller than the window
    /// — a re-host after a hand-off, a tab switch, the user's own resize, all of which leave the
    /// figure where it was — changes nothing, so the window is the user's from the moment they
    /// touch it. The figure is the balance view's and nothing else's: the fact-check pane's content
    /// is deliberately not in it, which is why the window no longer grows claim by claim.
    ///
    /// Clamped at both ends: a floor, because a three-line window is not a usable one, and a
    /// ceiling, so it cannot open taller than the screen it is on — the figure comes from a
    /// content height, and a very long guide or a narrowly-translated top-up card could otherwise
    /// ask for more than the display has.
    private func applyMeasuredHeight(_ height: CGFloat) {
        guard let window = view.window else { return }

        let visibleHeight = (window.screen ?? NSScreen.main)?.visibleFrame.height ?? 900
        let target = min(max(height, Self.minimumWindowHeight), visibleHeight - 80)
        window.contentMinSize = NSSize(width: 440, height: Self.minimumWindowHeight)
        guard (window.contentView?.frame.height ?? 0) < target - 1 else { return }
        window.setContentSize(NSSize(width: 440, height: target))
    }

    /// The floor under the window's height. Below this the top-up card and the field in it stop
    /// being usable — the pane scrolls, so this is about the window being a sensible window rather
    /// than about the content fitting.
    private static let minimumWindowHeight: CGFloat = 420
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
