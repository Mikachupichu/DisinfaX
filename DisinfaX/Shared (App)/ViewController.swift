//
//  ViewController.swift
//  Shared (App)
//
//  Created by Michaël Pouget on 2026-08-07.
//

import WebKit
import StoreKit
import SwiftUI
import Combine
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
    /// The signed-out landing page's own content, and the guide's block beneath it. There are no
    /// panes to defer to then, and these two are what the window has to hold instead.
    var landing: CGFloat = 0
    var guide: CGFloat = 0
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
        value.landing = max(value.landing, next.landing)
        value.guide = max(value.guide, next.guide)
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
///
/// On an iPad with the width for it the picker is gone altogether: the two surfaces are shown side
/// by side, a half each. See `splitsPanes` for where that stops being a good idea.
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

    /// Whether to show the acknowledgement of a sign-in that happened in Safari. Set by the two
    /// paths that can deliver one — see `disinfaxSignedIn` and `AuthCallbackNotice` for why there
    /// are two — and cleared when the user leaves for Safari, which is the only thing it asks of
    /// them.
    @State private var showSignedIn = false

    /// Whether the app holds a session, which decides whether it shows its panes or its landing
    /// page, and what the guide under them is for.
    ///
    /// The same question `TopUpView` asks before it draws its card, asked of the same getter and
    /// kept current the same way, so the guide can never claim an account the pane above it is
    /// denying. `signedInUserId` rather than `userId`: an identity with no session behind it is
    /// one the app cannot act on, and showing the panes for it would be showing a balance it
    /// cannot read and a fact-check it cannot pay for.
    ///
    /// The app keeps the session alive itself (`AppSession`), so this no longer lapses on a user
    /// who is signed in and simply has not opened the popup.
    @State private var isSignedIn = SharedTopUpStore.signedInUserId != nil

    /// Whether the popup has ever been opened on this install.
    ///
    /// Read only to choose the guide's subject, and never cleared — see
    /// `SharedTopUpStore.markPopupOpened`. A user who signed in here and never opened the popup
    /// may not even have the extension enabled, so the setup steps are still the ones they need;
    /// telling them how to fact-check a page they cannot yet open a popup on would be describing
    /// a control that is not there.
    @State private var popupOpened = SharedTopUpStore.popupOpenedEver

    /// Whether a fact-check was ever started on a page selection — through the popup or the
    /// right-click menu, as opposed to the buttons the extension injects into posts. Written by
    /// the extension; read here to know whether the second guide overlay is still owed.
    @State private var selectionFactCheck = SharedTopUpStore.selectionFactCheckEver

    /// Whether the user has tapped either overlay away. Separate from the conditions above
    /// because they are the one thing the app cannot learn from the extension: a tap is the
    /// user saying they have read the instructions below, which nothing else records.
    @State private var safariOverlayDismissed = SharedTopUpStore.guideOverlayDismissed(.safari)
    @State private var factCheckOverlayDismissed = SharedTopUpStore.guideOverlayDismissed(.factCheck)

#if os(iOS)
    /// Read only on iOS, and only to decide whether there is room for both surfaces at once. See
    /// `splitsPanes`.
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
#endif

    /// Watched only to clear the acknowledgement above, and only on the way out: the notice is
    /// about a return to Safari, so Safari taking the screen back is when it has been read.
    @Environment(\.scenePhase) private var scenePhase

    /// The panes' own cadence, run here too, because the guide is drawn from the store they read:
    /// the stamp ages out on its own sixty seconds after the extension last reported in, and the
    /// guide has to follow it down at the same moment the balance comes off the screen above it
    /// rather than at whatever unrelated re-render happens to come next.
    private static let pollInterval: TimeInterval = 2
    private let ticker = Timer.publish(every: pollInterval, on: .main, in: .common).autoconnect()

    init(factCheckModel: FactCheckModel, initialTab: Tab = .topUp, onMeasuredHeight: ((CGFloat) -> Void)? = nil) {
        self.factCheckModel = factCheckModel
        self.onMeasuredHeight = onMeasuredHeight
        _tab = State(initialValue: initialTab)
    }

    /// Whether both surfaces are on screen at once, rather than one at a time behind the picker.
    ///
    /// An iPad with the width for it gets the two halves: the balance on the leading side and the
    /// fact-check on the trailing one — which for Hebrew or Arabic the framework mirrors for us,
    /// exactly as it mirrors the picker, so the balance lands on the right. Narrower than that
    /// falls back to the picker: an iPad in Split View, and every phone, where half a screen is
    /// less than the 392pt both surfaces are drawn at and the fact-check pane would be squeezed
    /// rather than shared. macOS is always the picker — its window is one pane wide by design.
    private var splitsPanes: Bool {
#if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad && horizontalSizeClass == .regular
#else
        false
#endif
    }

    /// The width one pane's content is drawn at — 392pt of it, plus the 24pt of padding either
    /// side that lines it up with the window's edge. `nil` when the two panes share the screen.
    private var columnWidth: CGFloat? {
        splitsPanes ? nil : 392 + 48
    }

    /// The two surfaces side by side, or one over the other behind the picker.
    @ViewBuilder
    private var panes: some View {
        // The account actions ride at the end of a pane's own scroll content, inside the tab
        // region — the same block the picker sits in, and the one the guide's overlay darkens —
        // and not in the instructions below the divider. A pane tall enough to scroll takes them
        // with it rather than pinning them above the guide.
        //
        // Side by side they go with the balance pane alone, the one they are about: there is no
        // single scroll to append them to under both columns, and a block spanning the divide
        // reads as belonging to the fact-check surface it happens to sit beneath.
        let account = AnyView(AccountActions { isSignedIn = false })
        if splitsPanes {
            HStack(spacing: 0) {
                // An equal half each, which needs `maxWidth` on both: left to their own ideal
                // widths the pair would be laid out at 392pt apiece and centred, sharing nothing.
                // Named after itself, not after the app: side by side both panes would otherwise
                // carry the same "DisinfaX" heading with nothing saying which is which.
                TopUpView(headerTitle: "Balance", footer: account).frame(maxWidth: .infinity)
                Divider()
                FactCheckView(model: factCheckModel, headerTitle: "Fact-Check", showsHeaderSubtitle: false)
                    .frame(maxWidth: .infinity)
            }
            // Fills the window, so the guide's overlay darkens the whole block rather than
            // stopping at the panes' own width and leaving the gutters beside it undarkened.
            .frame(maxWidth: .infinity)
        } else {
            ZStack {
                TopUpView(footer: account).tabPane(visible: tab == .topUp)
                FactCheckView(model: factCheckModel, footer: account).tabPane(visible: tab == .factCheck)
            }
        }
    }

    /// Its own literal, like the three others — `TopUpView`, `FactCheckView` and `SafariGuide` each
    /// carry one rather than sharing a constant, and a shared one here would be the only colour in
    /// this file that the others do not also define for themselves.
    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

    var body: some View {
        VStack(spacing: 0) {
            if showSignedIn {
                signedInNotice
                    .padding(.horizontal, 24)
                    .padding(.top, 18)
                    .frame(maxWidth: columnWidth)
            }

            if isSignedIn {
                // The tabs and the surfaces behind them, darkened as one block while one of the
                // two guide subjects is still only described below. The picker is inside it
                // too: the overlay is asking the reader to stop and read the instructions
                // before choosing between the two, and a live picker above a dead panel reads
                // as a bug rather than as a request.
                // An overlay rather than a ZStack sibling: a sibling would be as large as its own
                // content, and the heading — sized from the width it believes it has — would then
                // widen the block it is covering and size itself against that instead.
                VStack(spacing: 0) {
                    VStack(spacing: 0) {
                        if !splitsPanes {
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
                        }

                        panes
                            .background(GeometryReader { proxy in
                                Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(panes: proxy.size.height))
                            })
                    }
                    // The column the panes and the picker are drawn in, which is narrower than a
                    // wide window. The block around it is not: see below.
                    .frame(maxWidth: columnWidth ?? .infinity)
                }
                // The overlay is sized to this block, so the block has to be the whole width it
                // covers: left to its own contents it stops at the panes, and in a window wider
                // than the column the panel leaves the gutters beside them undarkened — two
                // bright strips down a screen that is meant to be dimmed.
                .frame(maxWidth: .infinity)
                .overlay {
                    if let overlay = dueOverlay {
                        GuideOverlay(title: SafariGuide.headingTitle(factCheck: overlay == .factCheck)) {
                            dismiss(overlay)
                        }
                    }
                }
            } else {
                // Signed out, the landing page takes the panes' place and the picker with it:
                // there is nothing to pick between until there is a session. The guide below
                // stays, because the extension still has to be enabled in Safari and that is the
                // step nobody can look up for themselves. See `SafariGuide`.
                SignInView()
                    .frame(maxWidth: columnWidth)
            }

            // Below the panes rather than inside one of them, because the tab this belongs on is
            // both of them: it is about getting the extension running at all, and a user who
            // cannot get DisinfaX to appear in Safari may well be sitting on the fact-check tab
            // while they work out why. Outside their ScrollViews as well, so it stays put instead
            // of scrolling away with whichever pane is up — neither pane is guaranteed to reach
            // the bottom of the window.
            Divider()
                .padding(.horizontal, 24)
                .frame(maxWidth: columnWidth)

            // Signed in is not enough to make the setup steps redundant: a user who signed in
            // here and never opened the popup may not have enabled the extension at all, and
            // the how-to-fact-check steps name a control they cannot reach yet.
            SafariGuide(isSignedIn: isSignedIn && popupOpened, showsAddressBarPuzzlePiece: splitsPanes)
                // A ceiling rather than a width, because on a phone there is no room for 392pt
                // plus this padding, and a frame that is fixed anyway is not clamped to the
                // screen — it hangs over the edge and takes the guide's own left margin with it.
                .frame(maxWidth: 392, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.top, 14)
                .padding(.bottom, 18)
                .background(GeometryReader { proxy in
                    Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(guide: proxy.size.height))
                })
        }
        // Each row is held to the column it belongs in rather than the whole stack being held
        // there: the block above carries the guide's darkening, and a stack capped at the column
        // would cap the darkening with it — see its own `frame`. 392 + 48 is TopUpView's own
        // content width plus its 24pt side padding, so the picker lines up with the fields below
        // it instead of hovering over a wider window; in the split case the width is whatever the
        // screen gave us and sharing it is the point.
        .background(GeometryReader { proxy in
            Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(root: proxy.size.height))
        })
        .onPreferenceChange(PaneHeightsKey.self) { heights in
            // Signed out, there is no pane to take the leftover and no ceiling to stop at: the
            // landing page is the whole content, and a window shorter than it cuts the sign-in
            // buttons off, which is the one thing on it the user is being asked to press. Its own
            // height plus the guide's block and the divider between them is the figure.
            if heights.landing > 0, heights.guide > 0 {
                onMeasuredHeight?(heights.landing + heights.guide + 1)
                return
            }
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
            if AuthCallbackNotice.take() { showSignedIn = true }
            refreshGuide()
        }
        // An app that was already running when the sign-in landed: it hears about the hand-off as
        // it happens, rather than through the flag, which the cold path above has already read.
        // The flag is cleared here too, so that a rebuild of this view cannot bring the notice
        // back with it.
        .onReceive(NotificationCenter.default.publisher(for: .disinfaxSignedIn)) { _ in
            AuthCallbackNotice.clear()
            showSignedIn = true
            refreshGuide()
        }
        // A sign-in this app performed itself, or a session it was asked to re-read. No notice:
        // the landing page being replaced by the panes is the acknowledgement.
        .onReceive(NotificationCenter.default.publisher(for: .disinfaxSessionChanged)) { _ in
            refreshGuide()
        }
        .onChange(of: scenePhase) { phase in
            // Cleared on the way out rather than after a while, so the notice describes the
            // hand-off that just happened for exactly as long as the user is looking at it. Left
            // up, it would still be claiming a sign-in when the app is next opened by hand —
            // which may be days later, and may be after they signed out again.
            if phase != .active { showSignedIn = false }
            // The opposite direction for the account: coming back to the front is when an
            // exchange started in Safari has finished, and when a sign-out done there has taken
            // effect — so the guide is re-read at exactly the moment it can have changed.
            else { refreshGuide() }
        }
        // And while the app just sits there: the stamp expires by itself, the same way the
        // balances tab's does.
        .onReceive(ticker) { _ in refreshGuide() }
    }

    /// Re-reads what decides the guide, from disk, for the reason the panes do: the extension
    /// that writes it is a different process and this one's copy of the shared suite is a
    /// snapshot. Written only when it differs, so the poll does not re-render a body that has
    /// nothing new to draw.
    private func refreshGuide() {
        SharedTopUpStore.reloadFromDisk()
        let latestSignedIn = SharedTopUpStore.signedInUserId != nil
        if latestSignedIn != isSignedIn { isSignedIn = latestSignedIn }
        let latestPopupOpened = SharedTopUpStore.popupOpenedEver
        if latestPopupOpened != popupOpened { popupOpened = latestPopupOpened }
        let latestSelectionFactCheck = SharedTopUpStore.selectionFactCheckEver
        if latestSelectionFactCheck != selectionFactCheck { selectionFactCheck = latestSelectionFactCheck }
        let latestSafariDismissed = SharedTopUpStore.guideOverlayDismissed(.safari)
        if latestSafariDismissed != safariOverlayDismissed { safariOverlayDismissed = latestSafariDismissed }
        let latestFactCheckDismissed = SharedTopUpStore.guideOverlayDismissed(.factCheck)
        if latestFactCheckDismissed != factCheckOverlayDismissed { factCheckOverlayDismissed = latestFactCheckDismissed }
    }

    /// Which darkened overlay is owed, if any.
    ///
    /// Only while signed in, and one subject at a time: the setup steps until the popup has been
    /// opened once, then the how-to steps until a page selection has been fact-checked once. Both
    /// are lifetime facts recorded by the extension, and either one being satisfied is itself the
    /// dismissal — a user who has done the thing is never told about it.
    private var dueOverlay: SharedTopUpStore.GuideOverlayKind? {
        guard isSignedIn else { return nil }
        if !popupOpened { return safariOverlayDismissed ? nil : .safari }
        if !selectionFactCheck && !factCheckOverlayDismissed { return .factCheck }
        return nil
    }

    /// The tap that silences one overlay for good. Recorded in the store beside the two facts
    /// that decide whether it is due, not in this view's state alone: the view is rebuilt on
    /// every hand-off, and an overlay that came back after one would be worse than never shown.
    private func dismiss(_ overlay: SharedTopUpStore.GuideOverlayKind) {
        SharedTopUpStore.markGuideOverlayDismissed(overlay)
        switch overlay {
        case .safari: safariOverlayDismissed = true
        case .factCheck: factCheckOverlayDismissed = true
        }
    }

    /// The one thing this app can tell the user about a sign-in it did not perform: that the
    /// callback from Safari arrived. It is honest about no more than that. The exchange that
    /// turns the callback into a session happens in the extension, which is not reachable from
    /// here and has not necessarily run yet — so this says the hand-off landed and names the
    /// place the outcome will appear, which holds whichever way the exchange goes.
    private var signedInNotice: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(Self.accent)
                .accessibilityHidden(true)
            Text("Signed in! You can open the DisinfaX popup in Safari.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
        // One sentence and a symbol, so spoken as one thing rather than as a symbol whose name is
        // the only thing it carries.
        .accessibilityElement(children: .combine)
    }
}

/// Sign out, and the account deletion behind a disclosure — the popup's settings, under the tab
/// content rather than inside either tab, and above the divider that begins the instructions.
///
/// Deleting is neither ordinary nor reversible, and a single tap is all that separates it from
/// an ordinary control, so it is not on screen until asked for: the closed disclosure shows only
/// the one safe action. The note beside the button is the only place the user is told what
/// survives it, so it is part of what opens rather than something read before deciding.
private struct AccountActions: View {

    /// Called once the session is gone — by either button — so the root can put the landing
    /// page up without waiting for its poll to notice.
    let onSessionEnded: () -> Void

    private enum Action { case signOut, delete }

    @State private var busy: Action?
    @State private var error: LocalizedStringKey?
    @State private var showsDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                signOut()
            } label: {
                label("Sign out")
            }
            .buttonStyle(.bordered)
            .disabled(busy != nil)

            Button {
                showsDelete.toggle()
            } label: {
                HStack(spacing: 5) {
                    Text(showsDelete ? String(localized: "Show less") : String(localized: "Show more"))
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(showsDelete ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padding(.top, 18)

            if showsDelete {
                Button {
                    Task { await deleteAccount() }
                } label: {
                    label(busy == .delete ? "Processing…" : "Delete Account and Associated Data")
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .disabled(busy != nil)
                .padding(.top, 14)

                if let error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 10)
                }

                Text("Your balance, and a cryptographic hash of your email address that is protected by a secret key, are kept to prevent abuse of the free funds given at signup. Signing up again with the same account restores your balance.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 10)
            }
        }
        // As wide as the block is given, which the caller caps: the note has to be readable, and
        // hugging the buttons' width would leave it a column of three or four words.
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Filling the column the block is given. The padding is inside the frame so a stretched
    /// button still reads as one control rather than as a bar of colour.
    private func label(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }

    private func signOut() {
        guard busy == nil else { return }
        error = nil
        AppSession.clear()
        onSessionEnded()
    }

    /// The same RPC the popup calls, with the same rule afterwards: the account is gone
    /// server-side, so a failure to hear back must not leave the app claiming a session it can
    /// no longer use. Only a genuine refusal keeps the user signed in, and says so.
    private func deleteAccount() async {
        guard busy == nil else { return }
        busy = .delete
        error = nil
        defer { busy = nil }

        guard let session = await AppSession.current(),
              let url = URL(string: SharedTopUpStore.supabaseBase + "/rest/v1/rpc/delete_my_account") else {
            error = "Something went wrong on our end. Please try again in a moment."
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        // An RPC with no arguments still takes a JSON body, and PostgREST answers an empty one
        // with a 400 that reads like a missing function rather than a malformed request.
        request.httpBody = Data("{}".utf8)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(SharedTopUpStore.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")

        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            error = "Something went wrong on our end. Please try again in a moment."
            return
        }

        AppSession.clear()
        onSessionEnded()
    }
}

/// The dark panel drawn over the tabs while one of the guide's two subjects has not been done
/// yet: the guide's own heading over the darkening, and an arrow down to the instructions.
///
/// Only the tabs area is covered. The instructions below stay legible, because they are what the
/// panel is pointing at — darkening them too would be asking the reader to look at something it
/// had just hidden. The heading comes from `SafariGuide` so the two can never disagree.
private struct GuideOverlay: View {

    let title: LocalizedStringKey
    let onDismiss: () -> Void

    /// The wrapper follows the system appearance rather than an in-app setting, and the panel is
    /// drawn opposite to whatever it covers: a dark field with white words over the light
    /// appearance, and a light field with black words over the dark one. A dark scrim over a dark
    /// panel would darken nothing, and white words on it would be the only legible thing — which
    /// is what this looked like before it asked.
    @Environment(\.colorScheme) private var colorScheme

    private var scrim: Color {
        colorScheme == .dark ? Color.white.opacity(0.8) : Color.black.opacity(0.8)
    }

    private var ink: Color {
        colorScheme == .dark ? .black : .white
    }

    /// How far the arrow's head stops short of the bottom edge, and its shaft short of the
    /// heading: enough that neither touches the text it points from or to.
    private static let gap: CGFloat = 18
    private static let bottomPadding: CGFloat = 22
    private static let sideInset: CGFloat = 24

    /// The size the heading is measured at, and the largest it is ever drawn at. The two
    /// headings differ in length and so do their translations, so the drawn size is this one
    /// scaled by how much of the width the text actually used — measured, not guessed.
    private static let referenceSize: CGFloat = 120

    /// Measured, not assumed. The two headings differ in length and so do their translations,
    /// and a constant would centre one of them and push the other off centre by half the
    /// difference.
    @State private var titleHeight: CGFloat = 0
    /// The heading's width at `referenceSize`, in points.
    @State private var titleWidth: CGFloat = 0
    /// The width the heading's own text draws at, and the size that produced it — the reference
    /// measurement alone lands about two percent wide, because SF Pro draws small glyphs a little
    /// wider per point than large ones. Near the answer the two are proportional, so one
    /// correction from the size actually drawn lands it exactly.
    @State private var fit = GuideTitleFit()

    var body: some View {
        GeometryReader { proxy in
            // Centred in the darkened area itself, so the arrow gets the whole half below it.
            // A heading pushed up by its own arrow would sit nearer the tabs it is covering than
            // the instructions it is pointing at.
            let above = max(0, (proxy.size.height - titleHeight) / 2)
            let arrowTop = above + titleHeight + Self.gap
            let arrowHeight = max(0, proxy.size.height - Self.bottomPadding - arrowTop)
            let size = fittedSize(available: proxy.size.width)

            // Placed rather than stacked. In a VStack the heading is handed whatever height the
            // arrow has not claimed — which is its own last measured height, so shrinking to fit
            // it shrinks the measurement too, and the heading collapses on itself. Each child of
            // a ZStack is proposed the whole panel instead, which is what lets the heading size
            // itself to the width alone.
            ZStack(alignment: .top) {
                // Sized from its own measurement rather than by `minimumScaleFactor`: that
                // shrinks until the text *fits*, which leaves the heading a few points wider
                // than the space it was given and the side padding visibly short of the 24 it
                // asks for. Scaling by the measured width instead fills it exactly — see
                // `fittedSize` for the correction the reference measurement alone needs.
                Text(title)
                    .font(.system(size: size, weight: .heavy))
                    .foregroundStyle(ink)
                    .lineLimit(1)
                    .background(GeometryReader { text in
                        Color.clear.preference(key: GuideTitleHeightKey.self, value: text.size.height)
                    })
                    .background(
                        // The same words at the size this frame draws them, unconstrained: the
                        // width it reports is what the visible copy is about to occupy.
                        Text(title)
                            .font(.system(size: size, weight: .heavy))
                            .fixedSize()
                            .hidden()
                            .background(GeometryReader { drawn in
                                Color.clear.preference(
                                    key: GuideTitleFitKey.self,
                                    value: GuideTitleFit(size: size, width: drawn.size.width)
                                )
                            })
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, Self.sideInset)
                    .background(
                        Text(title)
                            .font(.system(size: Self.referenceSize, weight: .heavy))
                            .fixedSize()
                            .hidden()
                            .background(GeometryReader { reference in
                                Color.clear.preference(key: GuideTitleWidthKey.self, value: reference.size.width)
                            })
                    )
                    .padding(.top, above)

                // One symbol, drawn as large as the gap allows. A bar-and-head pair was what a
                // stretched arrow needed; `arrow.down` scaled whole keeps the head's shape at any
                // height, so the shaft can run the full length the heading leaves below it.
                if arrowHeight > 24 {
                    Image(systemName: "arrow.down")
                        .resizable()
                        .scaledToFit()
                        .frame(height: arrowHeight)
                        .foregroundStyle(ink)
                        .padding(.top, arrowTop)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .background(scrim)
        .onPreferenceChange(GuideTitleHeightKey.self) { height in
            if height != titleHeight { titleHeight = height }
        }
        .onPreferenceChange(GuideTitleWidthKey.self) { width in
            if width != titleWidth { titleWidth = width }
        }
        .onPreferenceChange(GuideTitleFitKey.self) { drawn in
            if drawn != fit { fit = drawn }
        }
        // The whole panel, not just the words on it: the tap is a tap on the dark area, and a
        // target smaller than the thing it dismisses would fail for anyone who aimed at the
        // panel rather than at the heading.
        .contentShape(Rectangle())
        .onTapGesture(perform: onDismiss)
        // One thing rather than a heading and a drawing: the words are the whole content, and
        // the button trait is what says the panel can be tapped away.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }

    /// The size that makes the heading as wide as the panel allows. A fraction of a percent short
    /// of exactly fitting: a rounding of that far lands the drawn text a hair past the frame,
    /// where `Text` truncates rather than nudges.
    private func fittedSize(available width: CGFloat) -> CGFloat {
        let room = max(0, width - Self.sideInset * 2)
        guard room > 0 else { return Self.referenceSize }

        // Corrected from the size actually drawn, once there is one. The tolerance is on the
        // width, not the size: a quarter of a point of width is under a quarter point of size,
        // so anything that would move the heading less than that is left alone — chasing it
        // would only re-render on its own rounding. A tolerance on the size instead would
        // swallow a correction small in points but large enough to truncate.
        if fit.width > 0, fit.size > 0 {
            let target = room * 0.997
            let corrected = fit.size * target / fit.width
            if abs(fit.width - target) < 0.25 || abs(corrected - fit.size) < 0.05 { return fit.size }
            return min(Self.referenceSize, corrected)
        }

        // The first estimate, from the reference copy. Close enough that the correction above
        // lands in one step.
        guard titleWidth > 0 else { return Self.referenceSize }
        return min(Self.referenceSize, Self.referenceSize * room * 0.99 / titleWidth)
    }
}

/// A heading drawn at a given size, and how wide that came out.
private struct GuideTitleFit: Equatable {
    var size: CGFloat = 0
    var width: CGFloat = 0
}

private struct GuideTitleFitKey: PreferenceKey {
    static var defaultValue = GuideTitleFit()
    static func reduce(value: inout GuideTitleFit, nextValue: () -> GuideTitleFit) {
        let next = nextValue()
        if next.width > 0 { value = next }
    }
}

/// The heading's width at the reference size, which is what the drawn size is scaled from.
private struct GuideTitleWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The overlay heading's own height, so it can be centred exactly.
private struct GuideTitleHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// The signed-out surface: the same page the Safari popup shows when nobody is signed in.
///
/// Its job is to make the app's own sign-in the obvious one. The buttons here do not open a
/// browser tab and do not need the popup to exist — this process presents the provider's sheet,
/// exchanges the code and keeps the session, so the balance and fact-check panes behind this
/// page work from the moment it is dismissed. `disinfax://signin?provider=…` from the popup lands
/// on the same coordinator, which is why the two entry points cannot drift.
///
/// Kept deliberately close to the popup's landing page — the same mark, the same two taglines,
/// the same two providers — because it is the same decision, and a reader who has seen one should
/// recognise the other.
@available(macOS 13.0, iOS 16.0, *)
private struct SignInView: View {

    @ObservedObject private var coordinator = SignInCoordinator.shared

    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

    /// Whether a sheet is up, which is when the buttons stop accepting taps. Not a spinner in
    /// place of the page: the system sheet covers the window on its own, and this only has to
    /// stop a second tap from starting a second flow.
    private var isBusy: Bool { coordinator.inFlight != nil }

    var body: some View {
        ScrollView {
            VStack(spacing: 26) {
                VStack(spacing: 8) {
                    HStack(alignment: .bottom, spacing: 4) {
                        Image("LargeIcon")
                            .resizable()
                            .frame(width: 34, height: 34)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            // A mark, not a letter: set on the type's own baseline it sits a
                            // little low against the word beside it, so it is lifted the couple
                            // of points its artwork has below the cap line.
                            .padding(.bottom, 3)
                        Text("DisinfaX")
                            .font(.system(size: 30, weight: .black))
                            .tracking(-0.5)
                    }
                    VStack(spacing: 1) {
                        Text("Reveal the Truth. Find the Lies.")
                        Text("No more Disinformation. Only Facts.")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                }

                VStack(spacing: 12) {
                    // Google's own artwork, shipped as the image Google publishes for sign-in
                    // buttons. Drawn instead — which is what stood here — it is a copy of the
                    // mark, and a copy gets the sweep's seam wrong: red where the crossbar's
                    // end should be blue, on the one element a reader looks at first.
                    providerButton(.google, label: "Continue with Google") {
                        Image("GoogleLogo")
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            // The label beside it already says which provider this is; the
                            // artwork's asset name is not something to read out.
                            .accessibilityHidden(true)
                    }
                    providerButton(.apple, label: "Continue with Apple") {
                        Image(systemName: "apple.logo").font(.system(size: 17, weight: .medium))
                    }
                }
                .frame(maxWidth: 320)

                if let failure = coordinator.failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 320)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.vertical, 28)
            // The height this page would draw at if nothing were squeezing it — measured inside
            // the scroll, which reports only the space it was given. `ViewController` sizes the
            // window from it, so the buttons are not cut off by the bottom edge; see
            // `PaneHeights`.
            .background(GeometryReader { proxy in
                Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(landing: proxy.size.height))
            })
        }
        .scrollIndicators(.never)
        .tint(Self.accent)
        .onAppear { coordinator.startPendingIfNeeded() }
        // A window that was already up when the URL arrived has no `onAppear` to catch: the
        // signal is the only way it hears about an entry point that does not come through a tap.
        .onReceive(NotificationCenter.default.publisher(for: .disinfaxSignInRequested)) { _ in
            coordinator.startPendingIfNeeded()
        }
    }

    /// The providers are a closed set here — Google and Apple are what the popup offers and what
    /// the project has configured. `provider` is the string the coordinator hands to Supabase.
    private func providerButton(
        _ provider: SignInCoordinator.Provider,
        label: LocalizedStringKey,
        @ViewBuilder icon: () -> some View
    ) -> some View {
        Button {
            Task { await coordinator.signIn(provider: provider) }
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(.quaternary.opacity(0.5))
                HStack(spacing: 10) {
                    icon().frame(width: 18, height: 18)
                    Text(label).font(.system(size: 15, weight: .medium))
                }
            }
            .frame(height: 46)
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .opacity(isBusy && coordinator.inFlight != provider ? 0.5 : 1)
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

/// How to get the extension running, under both tabs — and, once there is a session, how to use
/// the thing it was installed for.
///
/// It was the tail of `TopUpView`, which meant it was readable only by someone already on the
/// top-up tab — the opposite of who needs it. Nothing here depends on the balance, so nothing
/// about it belonged to that screen; the step that matters most, enabling the extension in
/// Safari, is exactly the one a user on the fact-check tab is looking for.
///
/// A signed-in user has finished those steps, so the same space answers the next question
/// instead: how to fact-check something on a page. That is a different gesture on each device —
/// a popup opened over a selection on iOS, a popup or a right-click on macOS — so each branch
/// names its own control rather than sharing one sentence.
@available(macOS 13.0, iOS 16.0, *)
private struct SafariGuide: View {

    /// Whether the app holds a session, which is what makes the setup steps redundant. Read from
    /// `SharedTopUpStore.session`, written by the popup and cleared on sign-out — so unlike the
    /// sign-in banner above, this outlives the hand-off that set it.
    let isSignedIn: Bool

    /// Whether Safari is drawing the extensions puzzle piece in the address bar rather than its
    /// menu. It draws the puzzle piece once the window has the room for it, which is the same
    /// width at which both of this app's own panes fit side by side — so the steps show whichever
    /// control the reader is looking at, and follow the layout into an iPhone wide enough to split
    /// rather than being tied to the device they were first written for.
    let showsAddressBarPuzzlePiece: Bool

    /// The app's own appearance — the system's, since this surface has no appearance setting of
    /// its own. Only the brand mark asks: it is the one drawing that ships in both inks.
    @Environment(\.colorScheme) private var colorScheme

    /// Carried over from `TopUpView`'s own tint, which no longer reaches here — the guide sits
    /// under both tabs now, and a `.tint` on the root would recolour the tab picker with it. Its
    /// own literal, like the other two, rather than a shared constant.
    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

#if os(iOS)
    /// Safari's extensions button in the address bar, drawn rather than named: no SF Symbol is
    /// the real control — `text.below.photo` carries a photo glyph the button does not have and
    /// `rectangle.stack` puts the lines above the card rather than below it. Template-rendered
    /// so it takes the surrounding text's colour exactly as a symbol would inline in a sentence.
    ///
    /// Drawn in a 12-point canvas rather than the callout's 16: an inline image sits on the
    /// baseline at its own natural size, so artwork filling a 16-point canvas rises past the
    /// ascenders and reads as oversized next to the words. The drawing keeps its proportions;
    /// only the canvas shrank.
    private static let extensionsIcon: Image = {
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { _ in
            UIColor.black.setStroke()
            let card = UIBezierPath(roundedRect: CGRect(x: 2.05, y: 1.1, width: 7.9, height: 5.25), cornerRadius: 1.3)
            card.lineWidth = 1.15
            card.stroke()
            for (y, end) in [(9.0, 9.95), (11.25, 6.75)] {
                let line = UIBezierPath()
                line.move(to: CGPoint(x: 2.05, y: y))
                line.addLine(to: CGPoint(x: end, y: y))
                line.lineWidth = 1.15
                line.lineCapStyle = .round
                line.stroke()
            }
        }
        return Image(uiImage: drawn.withRenderingMode(.alwaysTemplate))
    }()

    /// The same button once the extension is on: Safari swaps the glyph for a puzzle piece, which
    /// is the one the how-to-fact-check steps name — and the one a signed-out user will be looking
    /// at by the time they reach the step that reopens the menu. Stroked like its disabled twin
    /// above rather than filled: at twelve points a solid silhouette reads as a blob, and the
    /// notch and the tab that make it a puzzle piece disappear into it.
    private static let extensionsEnabledIcon: Image = {
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { _ in
            let x0: CGFloat = 2.05, x1: CGFloat = 9.95, y0: CGFloat = 1.1, y1: CGFloat = 6.35
            let corner: CGFloat = 1.3, knob: CGFloat = 1.2, mid: CGFloat = (y0 + y1) / 2
            let card = UIBezierPath()
            card.move(to: CGPoint(x: x0 + corner, y: y0))
            card.addLine(to: CGPoint(x: x1 - corner, y: y0))
            card.addArc(withCenter: CGPoint(x: x1 - corner, y: y0 + corner), radius: corner,
                        startAngle: -.pi / 2, endAngle: 0, clockwise: true)
            card.addLine(to: CGPoint(x: x1, y: mid - knob))
            // The tab bulges out of the right edge; the notch is the same arc mirrored into the
            // left one. Both sweep through the angle that points away from the card.
            card.addArc(withCenter: CGPoint(x: x1, y: mid), radius: knob,
                        startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: true)
            card.addLine(to: CGPoint(x: x1, y: y1 - corner))
            card.addArc(withCenter: CGPoint(x: x1 - corner, y: y1 - corner), radius: corner,
                        startAngle: 0, endAngle: .pi / 2, clockwise: true)
            card.addLine(to: CGPoint(x: x0 + corner, y: y1))
            card.addArc(withCenter: CGPoint(x: x0 + corner, y: y1 - corner), radius: corner,
                        startAngle: .pi / 2, endAngle: .pi, clockwise: true)
            card.addLine(to: CGPoint(x: x0, y: mid + knob))
            card.addArc(withCenter: CGPoint(x: x0, y: mid), radius: knob,
                        startAngle: .pi / 2, endAngle: -.pi / 2, clockwise: false)
            card.addLine(to: CGPoint(x: x0, y: y0 + corner))
            card.addArc(withCenter: CGPoint(x: x0 + corner, y: y0 + corner), radius: corner,
                        startAngle: .pi, endAngle: 3 * .pi / 2, clockwise: true)
            card.close()
            card.lineWidth = 1.15
            card.lineJoinStyle = .round
            UIColor.black.setStroke()
            card.stroke()
            for (y, end) in [(9.0, 9.95), (11.25, 6.75)] {
                let line = UIBezierPath()
                line.move(to: CGPoint(x: x0, y: y))
                line.addLine(to: CGPoint(x: end, y: y))
                line.lineWidth = 1.15
                line.lineCapStyle = .round
                line.stroke()
            }
        }
        return Image(uiImage: drawn.withRenderingMode(.alwaysTemplate))
    }()

    /// DisinfaX's own mark, beside the product's name wherever the steps say it. The asset is a
    /// 256-point bitmap and an inline image is laid out at its natural size, so it is resampled to
    /// the sentence's own size as it is drawn.
    ///
    /// The appearance is passed in rather than left to `UITraitCollection.current`: a SwiftUI body
    /// is built outside a trait context, so the lookup kept resolving the light artwork — a black
    /// mark that vanished into the dark panel. The asset carries both, and this is what chooses.
    private func brandIcon(_ scheme: ColorScheme) -> Image {
        let side: CGFloat = 12
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let artwork = UIImage(named: "LargeIcon", in: nil, compatibleWith: traits)
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
            artwork?.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        return Image(uiImage: drawn.withRenderingMode(.alwaysOriginal))
    }

    /// The address bar's extensions control as the steps name it: Safari's menu while the bar is
    /// narrow, and its puzzle piece once the bar has the room to show one. Drawn as a symbol in
    /// the second case rather than as the twelve-point artwork above, because in that form the
    /// control is a plain glyph with no card behind it — there is nothing to trace.
    ///
    /// Both take a space either side: a control names no word, so a line may fall on either side
    /// of it. The puzzle piece in the steps' sentences is a different matter — that one IS a name.
    private var extensionsButtonMark: GuideMark {
        showsAddressBarPuzzlePiece
            ? .symbol(Image(systemName: "puzzlepiece"), spaced: true)
            : .artwork(Self.extensionsIcon, spaced: true)
    }

    /// The same control once the extension is on. In the wide form Safari's puzzle piece does not
    /// change with the extension's state, which is why both of these resolve to the same symbol.
    private var extensionsButtonOnMark: GuideMark {
        showsAddressBarPuzzlePiece
            ? .symbol(Image(systemName: "puzzlepiece"), spaced: true)
            : .artwork(Self.extensionsEnabledIcon, spaced: true)
    }

    /// Safari's compass, on the same twelve-point canvas as the brand mark beside it. Drawn
    /// rather than read: iOS hands out no way to reach another app's artwork. Drawn in its own
    /// colours rather than as a tinted glyph because that is what the user is looking for on a
    /// home screen — a monochrome disc at twelve points is just a dot — and because the macOS
    /// guide shows the real icon taken from Safari itself, so the two platforms should agree.
    private static var safariIcon: Image {
        let side: CGFloat = 12
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { ctx in
            let middle = CGPoint(x: side / 2, y: side / 2)
            let face = UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: side, height: side))
            face.addClip()
            let gradient = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: [UIColor(red: 0.31, green: 0.71, blue: 0.97, alpha: 1).cgColor,
                         UIColor(red: 0.01, green: 0.27, blue: 0.75, alpha: 1).cgColor] as CFArray,
                locations: [0, 1])
            if let gradient {
                ctx.cgContext.drawLinearGradient(gradient,
                                                 start: CGPoint(x: 0, y: 0),
                                                 end: CGPoint(x: 0, y: side),
                                                 options: [])
            }
            // The needle is a sliver of a rhombus running north-east, red on its north side.
            let reach = side * 0.28, breadth = side * 0.075
            let north = CGPoint(x: middle.x + reach, y: middle.y - reach)
            let south = CGPoint(x: middle.x - reach, y: middle.y + reach)
            let east = CGPoint(x: middle.x + breadth, y: middle.y + breadth)
            let west = CGPoint(x: middle.x - breadth, y: middle.y - breadth)
            let red = UIBezierPath()
            red.move(to: north); red.addLine(to: east); red.addLine(to: south); red.close()
            UIColor(red: 0.93, green: 0.24, blue: 0.24, alpha: 1).setFill()
            red.fill()
            let white = UIBezierPath()
            white.move(to: north); white.addLine(to: south); white.addLine(to: west); white.close()
            UIColor.white.setFill()
            white.fill()
        }
        return Image(uiImage: drawn.withRenderingMode(.alwaysOriginal))
    }
#else
    /// Safari's icon as the Finder draws it, for the platform whose Safari has one to read. Taken
    /// from Safari itself rather than drawn, so it is the mark the user is about to look for in
    /// the Dock — and on a machine with more than one browser installed, a name alone is the
    /// ambiguity it resolves.
    private static var safariIcon: Image {
        guard let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari")
        else { return inline(nil) }
        return inline(NSWorkspace.shared.icon(forFile: safari.path))
    }

    /// DisinfaX's own mark, beside the product's name wherever the steps say it.
    ///
    /// The asset carries a dark-appearance variant, and an image read by name resolves its
    /// representation as it is drawn — but the guide's inline artwork is drawn outside any view's
    /// own appearance context, so it was the light artwork that arrived and the black mark
    /// vanished into the dark panel. The appearance is therefore worn explicitly while it is
    /// drawn, which is what the iOS branch does with its trait collection.
    private func brandIcon(_ scheme: ColorScheme) -> Image {
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
            ?? NSAppearance.currentDrawing()
        let source = NSImage(named: "LargeIcon")
        let side: CGFloat = 12
        let drawn = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            appearance.performAsCurrentDrawingAppearance {
                source?.draw(in: rect)
            }
            return source != nil
        }
        return Image(nsImage: drawn)
    }

    /// An inline image is laid out at its natural size, and twelve points is what this guide's
    /// callout text leaves for one: artwork filling a larger canvas rises past the ascenders and
    /// reads as oversized next to the words, which is why it is drawn down to this size instead of
    /// being used at the size it ships at. Drawn through a handler rather than once, so the
    /// artwork the current appearance resolves is what arrives.
    private static func inline(_ source: NSImage?) -> Image {
        let side: CGFloat = 12
        let drawn = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            source?.draw(in: rect)
            return source != nil
        }
        return Image(nsImage: drawn)
    }
#endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading(Self.headingTitle(factCheck: isSignedIn))
            if isSignedIn {
                selectionSteps
            } else {
                setupSteps
            }
        }
        .tint(Self.accent)
    }

    /// The guide's subject, from one place. The dark overlay above the panes shows the same
    /// words while darkening the panel it points down to, so the two are drawn from here rather
    /// than each carrying its own copy — the overlay is a pointer to this section, and a pointer
    /// that named a different section than the one below it would be worse than none. It is also
    /// what keeps the overlay from costing two more translations.
    static func headingTitle(factCheck: Bool) -> LocalizedStringKey {
        factCheck ? "HOW TO FACT-CHECK" : "USING DISINFAX IN SAFARI"
    }

    private func heading(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(.system(size: 10, weight: .semibold)).tracking(0.6)
            .foregroundStyle(.secondary)
            .padding(.bottom, 2)
    }

    /// How to get DisinfaX into Safari at all.
    @ViewBuilder
    private var setupSteps: some View {
        // Where Safari is named its own mark goes beside it: the steps are read by someone with a
        // browser open, and the name alone is the one word they are expected to find in a menu.
        step(1, Self.sentence("Open {1} Safari and go to any website.", [.artwork(Self.safariIcon)]))
            .accessibilityLabel(Text(Self.spoken("Open {1} Safari and go to any website.")))
#if os(macOS)
        // The pane to turn it on in is named twice over, because "Extensions" on its own is
        // ambiguous with the rows inside it. The arrow is Safari's own path; the puzzle piece is
        // the mark Safari uses for the same pane once the extension is running.
        step(2, Self.sentence("Enable {1} DisinfaX in Safari → {2} Safari Extensions.",
                              [.artwork(brandIcon(colorScheme)), .symbol(Image(systemName: "puzzlepiece"))]))
            .accessibilityLabel(Text(Self.spoken("Enable {1} DisinfaX in Safari → {2} Safari Extensions.")))
        // The mark stands where "the DisinfaX icon" stood, so it is spaced like any other word
        // rather than drawn tight against a noun it names. Safari's compass is not repeated in
        // the bar's name either: the word "Safari" is already the one the reader is looking for.
        step(3, Self.sentence("Click {1} in the Safari toolbar to open the popup.",
                              [.artwork(brandIcon(colorScheme), spaced: true)]))
            // Spoken, the mark has no name of its own, so this sentence keeps the words the
            // visible one drops — and that is the key the previous wording left in every
            // language, which is why the label reads it rather than the string above.
            .accessibilityLabel(Text(Self.spoken("Click the {1} DisinfaX icon in the {2} Safari toolbar to open the popup.")))
#else
        // The extensions button, NOT the Aa page-settings menu this used to name — they are
        // different controls in the address bar and only one of them lists extensions. The
        // sentence is one localization key with its inline images at `{1}`–`{3}`, so each
        // translation decides where the puzzle piece, the name and the checkmark fall instead of
        // inheriting English word order from a fixed split.
        step(2, Text("Tap the ") + Self.iconLeading(extensionsButtonMark,
            " icon in the address bar, then {1} Manage Extensions, and turn on {2} DisinfaX, and validate {3}.",
            [.symbol(Image(systemName: "puzzlepiece")), .artwork(brandIcon(colorScheme)), .symbol(Image(systemName: "checkmark.circle"), spaced: true)]))
            // An inline image carries no translation — spoken, it is only the symbol's own name.
            // The sentence without its markers is the localized thing, so read that.
            .accessibilityLabel(Text(
                String(localized: "Tap the ")
                + Self.spoken(" icon in the address bar, then {1} Manage Extensions, and turn on {2} DisinfaX, and validate {3}.")
            ))
        step(3, Self.sentence("Tap {1} again and choose {2} DisinfaX to open the popup.",
                              [extensionsButtonOnMark, .artwork(brandIcon(colorScheme))]))
            .accessibilityLabel(Text(Self.spoken("Tap {1} again and choose {2} DisinfaX to open the popup.")))
#endif
    }

    /// The web selection: what the extension does once it is running.
    @ViewBuilder
    private var selectionSteps: some View {
        step(1, "On any webpage, select the text you want to fact-check.")
#if os(macOS)
        step(2, "Right-click the selected text and choose Disinfact (also works on unselected text).")
        step(3, "The fact-check starts right away and is charged to your balance.")
#else
        // One sentence for both tablets: the extensions button sits in the address bar on the
        // iPhone and — once the extension is enabled, which is the only state this guide is shown
        // in — on the iPad too. The name inside the sentence is the one image the translation has
        // to place, so it is a marker in a single key rather than a split at a fixed word.
        step(2, Text("With the text still selected, tap the ") + Self.iconLeading(extensionsButtonOnMark,
            " icon in the address bar, then choose {1} DisinfaX.", [.artwork(brandIcon(colorScheme))]))
            .accessibilityLabel(Text(
                String(localized: "With the text still selected, tap the ")
                + Self.spoken(" icon in the address bar, then choose {1} DisinfaX.")
            ))
        step(3, "The fact-check starts right away and is charged to your balance.")
#endif
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n).").font(.callout).bold().foregroundStyle(.secondary).frame(width: 18, alignment: .trailing)
            text.font(.callout).fixedSize(horizontal: false, vertical: true)
        }
        // The number and its sentence are one instruction, not two things to swipe between.
        .accessibilityElement(children: .combine)
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View { step(n, Text(text)) }

    /// An image inside one of the guide's sentences. The drawn artwork — the brand mark, Safari's
    /// compass, the extensions button — is 12 points of bitmap sitting on a 16-point line's
    /// baseline, which reads high beside the lowercase it stands next to, so it is dropped the
    /// point and a half that centres it. An SF Symbol is a glyph already drawn where a glyph
    /// belongs and needs no such correction.
    ///
    /// `spaced` is the other half of what a mark is. A mark that names the words beside it — the
    /// brand mark before "DisinfaX", the compass before "Safari", the puzzle piece before "Safari
    /// Extensions" — is drawn tight against them, whether those words are one noun or a phrase. A
    /// control that names nothing takes an ordinary space on each side instead and reads as a word
    /// of its own: the checkmark at the end of a step, and the extensions button in the address
    /// bar, which points at itself rather than at the sentence it sits in.
    private struct GuideMark {
        let text: Text
        let spaced: Bool

        static func artwork(_ image: Image, spaced: Bool = false) -> GuideMark {
            GuideMark(text: Text(image).baselineOffset(-1.5), spaced: spaced)
        }

        static func symbol(_ image: Image, spaced: Bool = false) -> GuideMark {
            GuideMark(text: Text(image), spaced: spaced)
        }
    }

    /// A translated sentence that names its inline images at `{1}`, `{2}`, … — the numbering is by
    /// position in `images`. One key per sentence, so each language places every image itself; a
    /// sentence split at a fixed word instead pins all of them to English's order.
    private static func sentence(_ key: String.LocalizationValue, _ images: [GuideMark]) -> Text {
        sentence(String(localized: key), images)
    }

    /// The same sentence, already localized — for the ones this file assembles from more than one
    /// key because an image opens them.
    private static func sentence(_ localized: String, _ images: [GuideMark]) -> Text {
        let characters = Array(localized)
        var text = Text(verbatim: "")
        var run = ""
        var i = 0
        while i < characters.count {
            if characters[i] == "{", i + 2 < characters.count, characters[i + 2] == "}",
               characters[i + 1].isASCII, let n = characters[i + 1].wholeNumberValue,
               images.indices.contains(n - 1) {
                // A mark is drawn tight against the word it names, with no space between them: the
                // gap is a break opportunity, and a mark is a mark because it sits beside its
                // word, not near it. The space it was written with is dropped rather than carried.
                //
                // The space BEFORE a mark stays, and is a no-break one: a language may place the
                // mark before the word it names or after it — "validate ✓" as much as "✓ DisinfaX"
                // — and a mark carried away from its word by a line break names nothing on either
                // line.
                //
                // A `spaced` mark names no word at all — the checkmark, the extensions button: it
                // stands where a word would, so it keeps both spaces as they are written, and a
                // line may fall on either side of it. Anything that DOES name words is tight
                // against them even when those words are a phrase rather than one noun: the
                // puzzle piece is "🧩 Safari Extensions", one name, not a button beside two words.
                let spaced = images[n - 1].spaced
                if !spaced, run.hasSuffix(" ") { run.removeLast(); run.append("\u{00A0}") }
                text = text + Text(verbatim: run) + images[n - 1].text
                run = ""
                i += 3
                if !spaced, i < characters.count, characters[i] == " " { i += 1 }
            } else {
                run.append(characters[i])
                i += 1
            }
        }
        return text + Text(verbatim: run)
    }

    /// An image that opens a sentence — the extensions button in the address bar, on iOS — held to
    /// the first word of that sentence's own translation, which is the word naming it.
    private static func iconLeading(_ mark: GuideMark, _ key: String.LocalizationValue, _ images: [GuideMark]) -> Text {
        var localized = String(localized: key)
        // A control names no word, so the space the key opens with is kept: the button stands
        // where a word would, and the one after it opens the phrase that describes it.
        if !mark.spaced, localized.hasPrefix(" ") { localized.removeFirst() }
        return mark.text + sentence(localized, images)
    }

    /// The same sentence without its markers, for VoiceOver: an inline image has no description
    /// to fall back on, and every marker here stands beside words that already name the thing.
    private static func spoken(_ key: String.LocalizationValue) -> String {
        var value = String(localized: key)
        for n in 1...9 {
            value = value.replacingOccurrences(of: "{\(n)} ", with: "")
            value = value.replacingOccurrences(of: "{\(n)}", with: "")
        }
        return value
    }
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

        // Before the first surface is built, because that is what reads the facts the flag clears.
#if os(macOS)
        SharedTopUpStore.resetGuideOverlaysIfAsked()
#endif

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
