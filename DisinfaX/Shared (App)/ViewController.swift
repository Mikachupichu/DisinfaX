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
import AuthenticationServices

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

/// The guide's own height, measured from a copy of it drawn unclipped. See `fittedInstructions`.
private struct GuideNaturalKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The height the guide's panel takes when it is drawing itself rather than being pulled. See
/// `guideOpenHeight`.
private struct GuideOpenKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

#if os(iOS)
/// Whether the phone is standing part-folded, from the hinge itself.
///
/// UIKit publishes a hinge only through an interaction — there is no property to read — so a view
/// in the hierarchy carries one and reports what it hears. The report is a phone lying flat for a
/// hierarchy that has no hinge, which is every device but the foldable, and for a system older
/// than the one that introduced the interaction.
private struct HingeReport: UIViewRepresentable {
    let onChange: (Bool) -> Void

    func makeUIView(context: Context) -> HingeReportingView {
        let view = HingeReportingView()
        view.isUserInteractionEnabled = false
        view.onChange = onChange
        return view
    }

    func updateUIView(_ view: HingeReportingView, context: Context) {
        view.onChange = onChange
    }

    final class HingeReportingView: UIView {
        var onChange: ((Bool) -> Void)?

        /// Kept so the interaction outlives this call. The view retains it as well, but only from
        /// inside the system's own bookkeeping.
        private var interaction: AnyObject?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, interaction == nil, #available(iOS 27.1, *) else { return }
            let interaction = UIHingeInteraction(updateHandler: { [weak self] _, update in
                self?.onChange?(update.hinge?.status == .partiallyOpen)
            })
            addInteraction(interaction)
            self.interaction = interaction
        }
    }
}
#endif

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

    /// Which reds the advisory cards are drawn in; see `advisoryFill`.
    @Environment(\.colorScheme) private var colorScheme

    /// The service messages the popup draws above its tabs, drawn here above the picker — and
    /// above both panes when they are side by side — for the same reason the instructions below
    /// them are: they are about DisinfaX as a whole rather than about either tab, and a reader
    /// who never opens the popup has no other surface that would tell them.
    ///
    /// Seeded from the last answer received, so a launch draws the block it drew last time and
    /// the network only ever corrects it. See `ServiceMessages`.
    @State private var messages: [String] = ServiceMessages.cached()

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

    /// Whether the user has folded the instructions away to their grabber. Opens unfolded, and
    /// stays wherever the user last put it — across launches too, which is why this is a
    /// default rather than `@State`: the fold is a preference of theirs about a block that never
    /// changes, not something the app has an opinion about. The one exception is a panel drawn
    /// over the panes, which points at the instructions — see `dueOverlay`. That one is written
    /// through to the default as well, so the unfold outlives the panel rather than the launch.
    @AppStorage("mfGuideCollapsed") private var guideCollapsed = false

    /// How far the grabber has been pulled, in points: the guide's panel is drawn that much taller
    /// or shorter than it rests, so its top edge sits under the finger for the whole drag. Zero
    /// whenever nothing is being dragged — the fold itself is what holds the panel at rest. See
    /// `guideSheetHeight`.
    @State private var guideDrag: CGFloat = 0

    /// Whether a pull has been let go of and the panel is still travelling to where it will rest.
    /// The height stays the pull's until it lands, so the frame is not dropped mid-animation.
    @State private var guideSettling = false

    /// The guide's own height, measured from a copy of the panel drawn only to be measured: what a
    /// pull opens onto, and where it stops.
    @State private var guideNatural: CGFloat = 0

    /// The height the guide was last laid out at while it was open and nothing was pulling it —
    /// its own height where that fits under the window, less than that where the guide is taller
    /// than the room it has and scrolls instead. A pull is capped by this, so pulling the guide
    /// open can never take more room than it takes when it is simply open.
    @State private var guideOpenHeight: CGFloat = 0

#if os(iOS)
    /// Read only on iOS, and only to decide whether there is room for both surfaces at once. See
    /// `splitsPanes`.
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    /// The shorter of the window's sides, read from its scene's bounds because SwiftUI does not
    /// publish them — refreshed where the rotation is heard, and with the poll. It is what tells
    /// the Duo's folded screen from its unfolded one, which neither size class does. See
    /// `duoExpanded`.
    @State private var windowShortSide: CGFloat = 0

    /// Whether the window is wider than it is tall, read from the same bounds as the short side
    /// and for the same reason. It is what tells the unfolded Duo's landscape from its portrait,
    /// which the short side alone cannot: both screens are the same height either way up. See
    /// `guideTwoColumns`.
    @State private var windowIsLandscape = false

    /// Whether the phone is standing part-folded — the laptop shape, where the two halves are at
    /// an angle to each other rather than lying flat. The crease separates them on its own, so the
    /// two panes do not also need a rule drawn down the middle of the window.
    ///
    /// False wherever there is no hinge, and until the interaction has reported one.
    @State private var hingePartiallyOpen = false
#endif

    /// Watched only to clear the acknowledgement above, and only on the way out: the notice is
    /// about a return to Safari, so Safari taking the screen back is when it has been read.
    @Environment(\.scenePhase) private var scenePhase

    /// The grabber's fold is the one animation in this file, and the setting it has to obey is
    /// the system's rather than the view's own: a reader who has asked for less movement gets the
    /// guide in its new arrangement without the slide between the two.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
    /// falls back to the picker: an iPad in Split View, and every phone but the Duo — whose
    /// unfolded screen is the one phone screen wide enough for two columns, and whose folded one
    /// is not. Half a narrower screen is less than the 392pt both surfaces are drawn at, and the
    /// fact-check pane would be squeezed rather than shared. macOS is always the picker — its
    /// window is one pane wide by design.
    private var splitsPanes: Bool {
#if os(iOS)
        if Self.isIPhoneDuo { return duoExpanded }
        return UIDevice.current.userInterfaceIdiom == .pad && horizontalSizeClass == .regular
#else
        false
#endif
    }

    /// Whether the two halves are already separated by the phone itself, standing part-folded: the
    /// crease is the division, so the panes take the whole window with no rule drawn down the
    /// middle of it.
    ///
    /// Only ever true on the one phone that has a hinge, and only while it is being held at an
    /// angle — laid flat, or closed, the panes are the only thing dividing the window.
    private var hingeSeparatesPanes: Bool {
#if os(iOS)
        hingePartiallyOpen
#else
        false
#endif
    }

    /// The one phone that splits at all, and the reason `splitsPanes` takes the device into
    /// account: every other iPhone keeps the single column it has always had, however wide its
    /// landscape is.
    ///
    /// Whether the Duo splits is a question about the screen it is drawn on, not about the
    /// orientation. Unfolded it has the width for two half-columns whichever way up it is held;
    /// folded it has an ordinary phone's width whichever way up it is held, and splits in neither.
    /// The short side is what tells the two screens apart — 466pt folded against 669pt unfolded —
    /// and it is read from the window because neither the idiom nor either size class changes
    /// between them.
    private var duoExpanded: Bool {
#if os(iOS)
        Self.isIPhoneDuo && windowShortSide >= Self.duoExpandedShortSide
#else
        false
#endif
    }

#if os(iOS)
    /// Where the folded Duo's short side ends and the unfolded one's begins: 466pt against 669pt,
    /// so any figure between them answers the same question. Midway rather than against either
    /// edge, so that a screen on either side of the pair still lands on the right answer.
    private static let duoExpandedShortSide: CGFloat = 560

    /// The window's bounds, read from its scene — kept in state because the bounds are not a
    /// thing SwiftUI publishes; see where it is refreshed.
    private static var currentWindowBounds: CGRect {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.coordinateSpace.bounds ?? .zero
    }

    /// Written only when it differs, the same way `refreshGuide` is: an unchanged shape must not
    /// invalidate a body that has nothing new to draw. Called on the way up, when a rotation is
    /// heard, and with the poll — a fold or unfold that reports no rotation is still a shape.
    private func refreshWindowShape() {
        let bounds = Self.currentWindowBounds
        let shortSide = min(bounds.width, bounds.height)
        if shortSide != windowShortSide { windowShortSide = shortSide }
        let landscape = bounds.width > bounds.height
        if landscape != windowIsLandscape { windowIsLandscape = landscape }
    }
#endif

    /// Signed out on the unfolded Duo, where the two halves hold the landing page and the
    /// instructions rather than two panes — there is nothing to pick between yet.
    private var landingSplits: Bool { duoExpanded && !isSignedIn }

    /// Whether the instructions below the panes are drawn in two columns.
    ///
    /// One arrangement only: the Duo unfolded, held in landscape, with the screen part-folded —
    /// the window is at its widest, the crease already divides it, and the panes above are two
    /// columns, so the steps below are drawn as two as well rather than as three long lines
    /// stacked in the top half of the width. Every other shape keeps the one column it has always
    /// had. A signed-out window is not this one: the guide is already the landing page's second
    /// column there, and splitting that in two would leave quarter-width columns.
    private var guideTwoColumns: Bool {
#if os(iOS)
        duoExpanded && hingePartiallyOpen && windowIsLandscape && !landingSplits
#else
        false
#endif
    }

    /// Whether the advisories above the panes are drawn over the balance half alone.
    ///
    /// The same arrangement as `guideTwoColumns`, and for the same reason: the crease already
    /// divides the window, so a strip that spanned both halves would sit half over a pane it has
    /// nothing to do with and take height from it. Narrower than `splitsPanes` on purpose — the
    /// Duo laid flat and the iPad's split view keep the strip across the window as they always
    /// have.
    private var advisoriesOverBalanceOnly: Bool {
#if os(iOS)
        duoExpanded && hingePartiallyOpen && windowIsLandscape && !landingSplits
#else
        false
#endif
    }

    /// Whether this device is an iPhone Duo, read from its model identifier — the idiom cannot
    /// say, because the Duo reports `.phone` like every other iPhone and what it has extra is
    /// width once it is unfolded, not a different family.
    ///
    /// A simulated app runs on the host's own machine name, so the device it is imitating comes
    /// from the environment instead; a real one answers through `uname`. Read by the app delegate
    /// too, which keeps every other iPhone in portrait.
    static let isIPhoneDuo: Bool = {
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated == "iPhone19,4"
        }
        var info = utsname()
        guard uname(&info) == 0 else { return false }
        // Read before the field is borrowed as a pointer: the capacity cannot be measured through
        // the same inout access.
        let capacity = MemoryLayout.size(ofValue: info.machine)
        let machine = withUnsafePointer(to: &info.machine) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) {
                String(cString: $0)
            }
        }
        return machine == "iPhone19,4"
    }()

    /// The width one pane's content is drawn at — 392pt of it, plus the 24pt of padding either
    /// side that lines it up with the window's edge. `nil` when the two panes share the screen.
    private var columnWidth: CGFloat? {
        splitsPanes ? nil : 392 + 48
    }

    /// The width the instructions below the panes are drawn at, and the divider above them.
    ///
    /// The column wherever the window is no wider than it — a phone held upright, and the
    /// macOS window, which is one pane wide by design. Everywhere there is width to take it is
    /// taken: a phone in landscape is wider than the column and the steps are drawn across the
    /// whole of it, which puts a long instruction on one line instead of two.
    private var guideWidth: CGFloat? {
#if os(iOS)
        if windowIsLandscape { return nil }
#endif
        return columnWidth
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
                VStack(spacing: 0) {
                    // Part-folded, the advisories belong to this half alone, above the heading
                    // they are about the account of. Inside the column rather than in a row
                    // across the window: a row above both panes starts the fact-check pane at
                    // its foot, which is the height this half is meant to give back.
                    if advisoriesOverBalanceOnly, !messages.isEmpty {
                        // The pane's own box below it — 392pt of content and the 24pt of gutter
                        // either side — so the cards line up with the heading instead of
                        // reaching past it into the half's spare width. Centred, because
                        // `TopUpView` centres its own column in the half rather than leading it,
                        // and a strip pinned to the edge would read as belonging to the window.
                        messagesNotice
                            .padding(.horizontal, 24)
                            .padding(.top, 18)
                            .frame(maxWidth: 392, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                    TopUpView(headerTitle: "Balance", footer: account)
                }
                .frame(maxWidth: .infinity)
                // Part-folded, the crease is already the division: a rule beside it draws a second
                // one down the middle of a window that has its own.
                if !hingeSeparatesPanes { Divider() }
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

    /// How tall the grabber is drawn. The fold's resting height, and the least the panel can be.
    private static let grabberHeight: CGFloat = 30

    /// How far a pull has to travel before it is a pull rather than a press. Below this the
    /// grabber is being tapped, which is the fold it has always answered with.
    private static let guideDragThreshold: CGFloat = 6

    /// How long a let-go pull takes to land. Measured against the spring below rather than
    /// guessed at: the frame that follows the finger has to outlive the whole of the settle.
    private static let guideSettleDuration: Double = 0.55

    /// The fold's own cadence, and the pull's: a sheet is letting go of something heavy, so it
    /// lands with a little weight on it rather than snapping. A reader who has asked for less
    /// movement gets the new arrangement with no travel at all.
    private static func guideAnimation(reduceMotion: Bool) -> Animation? {
        reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.86)
    }

    /// Puts the guide in the given fold, and only if it is in the other one — a pull names the
    /// state it is asking for, and pulling down at a guide already folded asks for nothing.
    private func fold(_ collapsed: Bool) {
        guard collapsed != guideCollapsed else { return }
        withAnimation(Self.guideAnimation(reduceMotion: reduceMotion)) { guideCollapsed = collapsed }
    }

    /// The grabber's pull: from the first point of travel the panel's top edge follows the
    /// finger, and on the way up it lands in whichever fold the finger was heading for. A press
    /// that never moves is the tap this has always answered, so one recogniser covers both.
    ///
    /// Measured against the window rather than against the grabber. The edge the grabber sits on
    /// is the one the pull moves, so a measurement taken in its own space would be reading the
    /// finger from an edge that is travelling with it — each frame would report less travel than
    /// the last, and the panel would stall and stutter instead of following. The window does not
    /// move, so what it reports is the finger's own travel.
    private var guideDragGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in guideDrag = value.translation.height }
            .onEnded { value in endGuideDrag(value) }
    }

    /// Answers a pull that has just been let go of.
    ///
    /// The fold is chosen by where the finger was *going* rather than where it stopped — the
    /// predicted end, so that a short flick carries as far as it was thrown, the way it does on
    /// a sheet. A press that never moved asks for the other fold, which is the tap.
    ///
    /// The panel keeps the pull's height until the settle has landed, and is only then handed
    /// back to its own content: releasing that frame at the moment of the let-go would drop the
    /// animation's last frames on the floor and snap the panel the rest of the way.
    private func endGuideDrag(_ value: DragGesture.Value) {
        let ceiling = guideCeiling
        let resting = guideCollapsed ? Self.grabberHeight : ceiling
        let travelled = value.translation.height
        let wantsOpen = abs(travelled) < Self.guideDragThreshold
            ? guideCollapsed
            : resting - value.predictedEndTranslation.height > (Self.grabberHeight + ceiling) / 2

        let settles = !reduceMotion
        withAnimation(Self.guideAnimation(reduceMotion: reduceMotion)) {
            guideCollapsed = !wantsOpen
            guideDrag = 0
            guideSettling = settles
        }
        guard settles else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.guideSettleDuration) {
            guideSettling = false
        }
    }

    /// The height the guide's panel is held at while it is folded, being pulled, or settling into
    /// one of the two — and `nil` the rest of the time, when the panel draws itself exactly as it
    /// always did: at its own height where that fits, scrolling where it does not.
    ///
    /// A pull names a height rather than a state: what the finger has travelled is taken off the
    /// height the panel is coming from — down is shorter, up is taller, as it is for anything
    /// whose top edge is being held — and the result is clamped to the guide's own height, so the
    /// edge stays under the finger for the whole drag and cannot be pulled past the last line of
    /// the steps. See `fittedInstructions` for where it is applied.
    ///
    /// A guide with no grabber has no pull and no fold: it draws itself whatever the remembered
    /// fold says, which is what keeps a sign-out from taking a clipped panel with it — one with
    /// no control left to open it again, and with the instructions' own measurement squeezed to
    /// nothing inside the clip.
    private func guideSheetHeight(showsGrabber: Bool) -> CGFloat? {
        guard showsGrabber, guideCollapsed || guideDrag != 0 || guideSettling else { return nil }
        let resting = guideCollapsed ? Self.grabberHeight : guideCeiling
        return min(max(resting - guideDrag, Self.grabberHeight), guideCeiling)
    }

    /// What a pull opens onto and stops at: the guide's own height, or the height it is laid out
    /// at when that is less than its own — the scrolling arrangement, which is as open as the
    /// window allows it to be.
    private var guideCeiling: CGFloat {
        let natural = max(guideNatural, Self.grabberHeight)
        return guideOpenHeight > 0 ? min(natural, max(guideOpenHeight, Self.grabberHeight)) : natural
    }

    /// The grabber that folds the instructions away to itself, and the whole of what is left when
    /// they are folded.
    ///
    /// Five points thick and hit at thirty: it has to be findable as the only thing on the panel,
    /// without being noticeable while it is not.
    ///
    /// Drawn above the panel's content rather than inside it, so a pull holds one view for the
    /// whole of the gesture. What sits under the grabber changes shape the moment a pull starts —
    /// the panel stops drawing itself and is held at the pull's height instead — and a grabber
    /// that changed with it would take the going gesture with it: pulling up would still work,
    /// because that is the shape it starts from, and pulling down would not.
    private func guideGrabber(foldedAway: Bool) -> some View {
        Capsule()
            .fill(.quaternary)
            .frame(width: 36, height: 5)
            .frame(width: 88, height: Self.grabberHeight)
            .contentShape(Rectangle())
            // Ahead of the scroll: the steps scroll whenever they are taller than the window, and
            // a vertical pull that starts here is the grabber's.
            .highPriorityGesture(guideDragGesture)
            // The grabber draws no word, so this is the whole of what VoiceOver has to say — and,
            // with no button around it any more, what announces it as one.
            .accessibilityElement()
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel(Text(foldedAway ? "Show more" : "Show less"))
            .accessibilityAction { fold(!foldedAway) }
    }

    /// The steps themselves, in the one arrangement every surface draws them in.
    ///
    /// `measuring` draws them as a copy that exists only to be measured, which reports none of
    /// the measurements the real one does.
    private func guideSteps(measuring: Bool) -> some View {
        // The puzzle piece is Safari's own address-bar button, which a phone never draws however
        // wide its screen: the Duo splits its window but keeps an iPhone's Safari, so it is told
        // about an iPhone's control even while both panes are up.
        SafariGuide(
            isSignedIn: isSignedIn && popupOpened,
            showsAddressBarPuzzlePiece: splitsPanes && !Self.isIPhoneDuo,
            twoColumns: guideTwoColumns
        )
            // No width of its own: the sentence takes every point the row can give it, which is
            // what keeps a long step on one line and the guide short. The column is the frame's
            // job below — 392pt of content inside the 24pt padding that lines it up with the
            // window's edge, and the whole window where the two panes share it.
            .padding(.horizontal, 24)
            .padding(.top, 14)
            .padding(.bottom, 18)
            .background {
                if !measuring {
                    GeometryReader { proxy in
                        Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(guide: proxy.size.height))
                    }
                }
            }
            .frame(maxWidth: guideWidth)
    }

    /// The instructions in the room there is for them.
    ///
    /// They are text, and text grows: at a reader's larger sizes the steps are taller than the
    /// window they sit under, and as they are drawn on their own they take the page above them
    /// with them — the pane, or the landing page, is squeezed to nothing and the steps are cut
    /// off at both ends. Where they fit they are drawn exactly as before; where they do not, they
    /// are given what height is left and scroll in it, which is what the split landing page
    /// already does with them.
    ///
    /// The panel is also the sheet the grabber pulls. While it is folded, being pulled, or
    /// settling, its height is the pull's rather than its content's, and the block is drawn from
    /// its top edge down and clipped below — so pulling up uncovers the steps a line at a time
    /// and stops at the last one. At rest the height is `nil`, the frame has nothing to say, and
    /// the block draws exactly as it did before any of this existed.
    private func fittedInstructions(showsGrabber: Bool) -> some View {
        // Only a guide that has a grabber can be folded: without one there is nothing to bring it
        // back with, and a sign-out while folded would otherwise take the instructions with it.
        let foldedAway = showsGrabber && guideCollapsed
        // A collapsed guide being pulled open is not folded away: the panel's own frame is what
        // hides the steps it has not uncovered yet. Leaving them unbuilt as well is what made the
        // sheet read blank the whole way up and fill in all at once on the let-go — the frame was
        // growing over nothing.
        let folded = foldedAway && !(guideDrag < 0 || guideSettling)

        return VStack(spacing: 0) {
            // Outside the arrangements below rather than inside them, so the pull keeps the view
            // it started on. See `guideGrabber`.
            if showsGrabber {
                guideGrabber(foldedAway: foldedAway)
            }

            if !folded {
                if let sheetHeight = guideSheetHeight(showsGrabber: showsGrabber) {
                    // Folded, being pulled, or settling: the guide is drawn whole at its own height
                    // and the frame's clip uncovers it a line at a time. Drawn directly rather than
                    // through `ViewThatFits`, which answers by what fits: at a height nothing fits it
                    // hands out the panel's own squeezed layout instead, and the steps it squeezes
                    // away are not drawn until the pull ends — the panel reads blank on the way up
                    // and fills in all at once. `fixedSize` is what keeps the guide at its own height
                    // here rather than letting the short frame compress the text out of it.
                    //
                    // The grabber is drawn above this and is the panel's own first row, so what the
                    // frame holds is the rest of it: the whole panel at the fold's resting height,
                    // and the steps alone once a pull has made room for them.
                    guideSteps(measuring: false)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(height: max(sheetHeight - Self.grabberHeight, 0), alignment: .top)
                        .clipped()
                } else {
                    ViewThatFits(in: .vertical) {
                        guideSteps(measuring: false)
                        ScrollView {
                            guideSteps(measuring: false)
                        }
                        .scrollIndicators(.never)
                    }
                }
            }
        }
        .frame(maxWidth: guideWidth)
        // A copy of the guide drawn where nothing clips it, and only for its height: the panel
        // above cannot answer how tall it would be at a height it is being held at. Hidden rather
        // than absent, because a view that is not laid out has no height to give. It is the whole
        // block, grabber included, because that is what a pull opens onto.
        .background {
            if showsGrabber {
                VStack(spacing: 0) {
                    guideGrabber(foldedAway: false)
                    guideSteps(measuring: true)
                }
                .frame(maxWidth: guideWidth)
                .fixedSize(horizontal: false, vertical: true)
                .hidden()
                .background(GeometryReader { proxy in
                    Color.clear.preference(key: GuideNaturalKey.self, value: proxy.size.height)
                })
            }
        }
        .background(GeometryReader { proxy in
            Color.clear.preference(key: GuideOpenKey.self, value: proxy.size.height)
        })
        .onPreferenceChange(GuideNaturalKey.self) { height in
            // Only when it has actually changed: a preference report arrives with every layout,
            // and writing state from one that repeats itself would ask for another layout for
            // ever.
            guard height > 0, abs(height - guideNatural) > 0.5 else { return }
            guideNatural = height
        }
        .onPreferenceChange(GuideOpenKey.self) { height in
            // Only at rest: a height taken while the panel is clipped is the pull's height, and
            // capping the next pull at that would walk the guide shut a little at a time.
            guard guideSheetHeight(showsGrabber: showsGrabber) == nil, height > 0, abs(height - guideOpenHeight) > 0.5 else { return }
            guideOpenHeight = height
        }
    }

    /// Its own literal, like the three others — `TopUpView`, `FactCheckView` and `SafariGuide` each
    /// carry one rather than sharing a constant, and a shared one here would be the only colour in
    /// this file that the others do not also define for themselves.
    private static let accent = Color(red: 4 / 255, green: 120 / 255, blue: 87 / 255)

    var body: some View {
        VStack(spacing: 0) {
            if showSignedIn {
                signedInNotice
                    .padding(.horizontal, 24)
                    .padding(.top, 18)
                    .frame(maxWidth: columnWidth)
            }

            // The panes' own advisory strip: drawn with the tabs and not on the landing page,
            // which is a sign-in form and not a surface for service notices. Above the tabs
            // rather than inside one, and outside the block the guide's overlay darkens for the
            // same reason the notice above is: the overlay is about the panes, and an advisory it
            // covered would be one the reader is asked not to read. Side by side that puts it
            // over both halves at once, which is where a message about the service belongs — and
            // part-folded it is the balance half's instead, drawn inside that column: see `panes`.
            if isSignedIn, !advisoriesOverBalanceOnly, !messages.isEmpty {
                messagesNotice
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
                    // VoiceOver does not follow z-order the way a finger does, so the panes are
                    // still swiped through while the panel covers them — and the panel is what
                    // says why they cannot be used yet. Hidden for as long as it is due, so the
                    // one thing to reach is the one thing to read.
                    .accessibilityHidden(if: dueOverlay != nil)
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
            } else if landingSplits {
                // Signed out on the Duo in landscape: the window is two halves and only one of
                // them has a surface, so the instructions take the other. The landing page keeps
                // the guide's own arrangement beside it rather than below it, which is the same
                // page the iPad's width would give if it had nothing to pick between either.
                HStack(spacing: 0) {
                    SignInView()
                        .frame(maxWidth: .infinity)
                    // The crease divides the two halves on its own when the phone is part-folded;
                    // see `hingeSeparatesPanes`.
                    if !hingeSeparatesPanes { Divider() }
                    // A column of its own scrolls, as each pane does: half a phone's landscape is
                    // shorter than the guide in some translations.
                    ScrollView {
                        guideSteps(measuring: false)
                    }
                    .scrollIndicators(.never)
                    .frame(maxWidth: .infinity)
                }
            } else {
                // Signed out, the landing page takes the panes' place and the picker with it:
                // there is nothing to pick between until there is a session. The guide below
                // stays, because the extension still has to be enabled in Safari and that is the
                // step nobody can look up for themselves. See `SafariGuide`.
                SignInView()
                    .frame(maxWidth: columnWidth)
            }

            // Beside the landing page above, in that one arrangement, rather than under it.
            if !landingSplits {
                // Below the panes rather than inside one of them, because the tab this belongs on
                // is both of them: it is about getting the extension running at all, and a user
                // who cannot get DisinfaX to appear in Safari may well be sitting on the
                // fact-check tab while they work out why. Outside their ScrollViews as well, so it
                // stays put instead of scrolling away with whichever pane is up — neither pane is
                // guaranteed to reach the bottom of the window.
                Divider()
                    .padding(.horizontal, 24)
                    .frame(maxWidth: guideWidth)

                // Signed in is not enough to make the setup steps redundant: a user who signed in
                // here and never opened the popup may not have enabled the extension at all, and
                // the how-to-fact-check steps name a control they cannot reach yet.
                //
                // The grabber is the signed-in guide's alone: the landing page's instructions are
                // the only content besides it, and folding them away there would leave a blank
                // window.
                fittedInstructions(showsGrabber: isSignedIn)
            }
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
#if os(iOS)
        // The hinge is heard rather than read: see `HingeReport`. Zero-sized, so it draws nothing;
        // written after the update that carried the report so a state change never lands in the
        // middle of one.
        .background {
            if Self.isIPhoneDuo {
                HingeReport { partiallyOpen in
                    DispatchQueue.main.async {
                        if hingePartiallyOpen != partiallyOpen { hingePartiallyOpen = partiallyOpen }
                    }
                }
            }
        }
#endif
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
            // The same rule the overlay's `onChange` applies, for a launch: that one only hears
            // an overlay arriving while this view is up, and a device signed in before the app
            // was opened has one due from the first frame — the fold remembered from last time
            // would otherwise be painted under it.
            if dueOverlay != nil, guideCollapsed { guideCollapsed = false }
#if os(iOS)
            refreshWindowShape()
#endif
        }
#if os(iOS)
        // Turning the phone, or unfolding it, is heard rather than measured: the window's shorter
        // side decides whether the Duo splits, and this is when it changes. See `duoExpanded`.
        .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
            refreshWindowShape()
        }
#endif
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
        // A panel drawn over the panes points down at the instructions, so it cannot be pointing
        // at something folded away: the guide unfolds as soon as one is due. It stays unfolded
        // once the panel is gone — a fold after that is the user's own, and reversing it would be
        // the app arguing with them about a panel that is no longer there.
        .onChange(of: dueOverlay != nil) { due in
            if due, guideCollapsed { guideCollapsed = false }
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
        .onReceive(ticker) { _ in
            refreshGuide()
#if os(iOS)
            // A fold or an unfold that reports no rotation is still a shape, and this is the
            // only thing that would hear it.
            refreshWindowShape()
#endif
        }
        // The advisories above the tabs come from the extension's endpoint rather than from the
        // extension, whose cache lives in its own storage: so the app asks for them itself, on the
        // same daily cadence the extension's alarm keeps. Checked hourly rather than drawn by the
        // ticker above, because the whole point of the stamp is not to ask until it has aged out —
        // and a macOS window left open for days is the case that would otherwise never ask again.
        .task {
            var firstCheck = true
            while !Task.isCancelled {
                // The popup asks once every time the browser starts, whatever its cache says —
                // asking again is how a message published since the last launch arrives at all —
                // and an app launch is that same moment. Only the hourly checks behind it wait
                // for the stamp to age out.
                let fresh = firstCheck ? await ServiceMessages.refreshOnLaunch() : await ServiceMessages.refreshIfStale()
                firstCheck = false
                if let fresh, fresh != messages {
                    messages = fresh
                }
                try? await Task.sleep(nanoseconds: 60 * 60 * 1_000_000_000)
            }
        }
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

    /// The advisories the popup shows, one card each. Read-only: they are notices, not controls,
    /// and the only thing a reader can do with one is follow a link the message itself carries.
    private var messagesNotice: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "info.circle")
                        .font(.callout)
                        .accessibilityHidden(true)
                    Text(ServiceMessages.attributed(message))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(advisoryFill, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(advisoryBorder, lineWidth: 1))
                .foregroundStyle(advisoryText)
            }
        }
    }

    /// The popup's advisory card, in the popup's own reds: `red-950` at half over the page,
    /// a `red-900` hairline and `red-300` words. The popup has only ever drawn these on its dark
    /// surface, so the light window takes the same three steps down the same ramp rather than
    /// red ink on white, which is a different card and not this one.
    private var advisoryFill: Color {
        colorScheme == .dark
            ? Color(red: 0x45 / 255, green: 0x0A / 255, blue: 0x0A / 255).opacity(0.5)
            : Color(red: 0xFE / 255, green: 0xF2 / 255, blue: 0xF2 / 255)
    }

    private var advisoryBorder: Color {
        colorScheme == .dark
            ? Color(red: 0x7F / 255, green: 0x1D / 255, blue: 0x1D / 255)
            : Color(red: 0xFE / 255, green: 0xCA / 255, blue: 0xCA / 255)
    }

    private var advisoryText: Color {
        colorScheme == .dark
            ? Color(red: 0xFC / 255, green: 0xA5 / 255, blue: 0xA5 / 255)
            : Color(red: 0xB9 / 255, green: 0x1C / 255, blue: 0x1C / 255)
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
    /// Localized where it is set, rather than carried as a key: the failure is also announced,
    /// and an announcement takes the words, not the key. See `announce`.
    @State private var error: String?
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
                        // The words beside it say what it says, and say it better: the label is
                        // the state ("Show less" once open), the rotation is only for the eye.
                        .accessibilityHidden(true)
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
        // A refusal appears under the button that was pressed, and the button goes back to
        // saying what it said before — nothing moves the cursor to the words. See `announce`.
        .onChange(of: error) { error in
            if let error { announce(error) }
        }
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
            error = String(localized: "Something went wrong on our end. Please try again in a moment.")
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
            error = String(localized: "Something went wrong on our end. Please try again in a moment.")
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

    /// Whether the panel holds the VoiceOver cursor. It is drawn over the panes and hides them
    /// from the cursor while it is due, so without being taken the cursor would simply have
    /// nowhere to be: it lands here as the panel arrives, and the panel is the one thing to read.
    @AccessibilityFocusState private var focused: Bool

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
        // Named rather than left to the gesture. A tap is the gesture a finger makes; an
        // assistive technology asks the view to act, and this is the act it asks for.
        .accessibilityAction { onDismiss() }
        .accessibilityFocused($focused)
        // After the cursor has somewhere to land rather than while the tree is still being
        // built: the panel is created and taken in the same pass that hides the panes under it.
        .onAppear { focused = true }
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

    /// Apple's button ships in fixed styles, so the dark page gets the white one rather than the
    /// black plate vanishing into the background.
    @Environment(\.colorScheme) private var colorScheme

    /// The provider the last sign-in used, read from the record both this app and the popup write.
    /// Taken when the page appears: a successful sign-in replaces this page, and the next one is
    /// built from whatever the store says then.
    @State private var lastOAuthProvider: String?

    private static let accent = Color(red: 4 / 255, green: 120 / 255, blue: 87 / 255)

    /// The height both sign-in plates are drawn at, and Apple's own corner radius, which the
    /// Google plate wears too.
    private static let plateHeight: CGFloat = 46
    private static let plateRadius: CGFloat = 6

    /// The weight the Google label is set at. Measured against Apple's own label at this same
    /// 17-point size and 46-point plate: Apple's ink is ~13.7 pixels per pixel of label width and
    /// `semibold` is ~13.6 — level on a simulator, a shade heavy on a device, which is what iOS
    /// showed and macOS did not.
    private static var plateWeight: Font.Weight {
        #if os(iOS)
        .medium
        #else
        .semibold
        #endif
    }

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
                            // The name is written beside it, so the mark has nothing to add.
                            .accessibilityHidden(true)
                        Text("DisinfaX")
                            .scaledFont(30, weight: .black, relativeTo: .largeTitle)
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
                    providerButton(.google, label: "Continue with Google",
                                   isLastUsed: lastOAuthProvider == SignInCoordinator.Provider.google.rawValue) {
                        Image("GoogleLogo")
                            .resizable()
                            .interpolation(.high)
                            .scaledToFit()
                            // The label beside it already says which provider this is; the
                            // artwork's asset name is not something to read out.
                            .accessibilityHidden(true)
                    }
                    // Apple's own button, with Apple's own sheet behind it: a native app may not
                    // ask for an Apple ID through a web page, and the button's design is part of
                    // what the guidelines fix in place.
                    Group {
                        #if os(macOS)
                        // SwiftUI's macOS wrapper pins the control to its 30-point default and
                        // centres it in a taller frame, which is what left the label small. The
                        // control itself draws its label to the frame it is given, so it is
                        // hosted directly — and given a height rather than a floor, since it
                        // only grows to a height it is proposed.
                        AppleIDControl(style: colorScheme == .dark ? .white : .black,
                                       isEnabled: !isBusy) {
                            Task { await coordinator.signIn(provider: .apple) }
                        }
                        // The style is fixed at construction, so a mode change builds a new one.
                        .id(colorScheme)
                        .frame(height: Self.plateHeight)
                        #else
                        SignInWithAppleButton(.continue) { request in
                            coordinator.beginApple()
                            AppleSignIn.shared.prepare(request)
                        } onCompletion: { result in
                            Task { await coordinator.completeApple(result) }
                        }
                        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                        .frame(minHeight: Self.plateHeight)
                        .disabled(isBusy)
                        #endif
                    }
                    .frame(maxWidth: .infinity)
                    // The popup's own badge, in the same corner Google's wears: a return visit
                    // offers the provider that worked last, and both surfaces say so the same
                    // way.
                    .overlay(alignment: .topTrailing) {
                        if lastOAuthProvider == SignInCoordinator.Provider.apple.rawValue {
                            lastUsedBadge.padding(5).allowsHitTesting(false)
                        }
                    }
                    .disabled(isBusy)
                    .opacity(isBusy && coordinator.inFlight != .apple ? 0.5 : 1)
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
        .onAppear {
            lastOAuthProvider = SharedTopUpStore.lastOAuthProvider?.provider
            coordinator.startPendingIfNeeded()
        }
        // A window that was already up when the URL arrived has no `onAppear` to catch: the
        // signal is the only way it hears about an entry point that does not come through a tap.
        .onReceive(NotificationCenter.default.publisher(for: .disinfaxSignInRequested)) { _ in
            coordinator.startPendingIfNeeded()
        }
        // The sheet has just closed on a failure, and the words for it have appeared below the
        // button that started it. Nothing moves the cursor there — see `announce`.
        .onChange(of: coordinator.failure) { message in
            if let message { announce(message) }
        }
    }

    /// The providers are a closed set here — Google and Apple are what the popup offers and what
    /// the project has configured. `provider` is the string the coordinator hands to Supabase.
    private func providerButton(
        _ provider: SignInCoordinator.Provider,
        label: LocalizedStringKey,
        isLastUsed: Bool = false,
        @ViewBuilder icon: () -> some View
    ) -> some View {
        Button {
            Task { await coordinator.signIn(provider: provider) }
        } label: {
            ZStack {
                // Apple's plate through the same two modes, so the pair reads as one stack.
                RoundedRectangle(cornerRadius: Self.plateRadius, style: .continuous)
                    .fill(colorScheme == .dark ? Color.white : Color.black)
                // Set to the size and weight Apple's own label is drawn at, and the mark to the
                // size its own is drawn at, so the two plates read as one pair.
                HStack(spacing: 10) {
                    icon().frame(width: 15, height: 15)
                    Text(label)
                        // A literal size, not a scaled one. Apple's label is drawn by the system
                        // control at a fixed size whatever the reader's text-size setting —
                        // measured at this same 46-point height, its ink is the same 49 pixels at
                        // every setting — so a label that answered to the setting was the pair
                        // drifting apart on any device that is not on the default size.
                        .font(.system(size: 17, weight: Self.plateWeight))
                        .foregroundStyle(colorScheme == .dark ? Color.black : Color.white)
                }
            }
            // A floor rather than a height: the row is drawn at the plate's height, and a name
            // set larger than the plate was cut for grows it instead of being clipped by it.
            .frame(maxWidth: .infinity, minHeight: Self.plateHeight)
            // The popup's own badge, in the same corner and the same words: a return visit offers
            // the provider that worked last, and both surfaces say so the same way.
            .overlay(alignment: .topTrailing) {
                if isLastUsed { lastUsedBadge.padding(5) }
            }
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
        .opacity(isBusy && coordinator.inFlight != provider ? 0.5 : 1)
    }

    /// The "last used" hint both providers carry, in the same corner of whichever plate was used
    /// last.
    private var lastUsedBadge: some View {
        Text("Last Used")
            .scaledFont(8, weight: .black, relativeTo: .caption2)
            // Set in capitals as the popup sets it, so a translated badge is cased the
            // same way on both surfaces rather than one of them title-casing English.
            .textCase(.uppercase)
            .tracking(0.4)
            .foregroundStyle(Self.accent)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Self.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .stroke(Self.accent.opacity(0.35), lineWidth: 1)
            }
            // The button already names its provider; the badge is a hint about which
            // one, not a second name to read out ahead of it.
            .accessibilityHidden(true)
    }
}

#if os(macOS)
/// Apple's own sign-in button, hosted directly so its label is drawn at the height the row gives
/// it. SwiftUI's macOS wrapper is the one that fixes the label's size; the control does not.
///
/// The control is held by a plain host view rather than handed to SwiftUI itself: asked to lay
/// out the control, SwiftUI sizes it from its 30-point intrinsic height and centres it, and the
/// host has no intrinsic size to offer.
@available(macOS 13.0, *)
private struct AppleIDControl: NSViewRepresentable {
    let style: ASAuthorizationAppleIDButton.Style
    let isEnabled: Bool
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    func makeNSView(context: Context) -> PlateHost {
        let host = PlateHost(style: style)
        host.button.target = context.coordinator
        host.button.action = #selector(Coordinator.fire)
        return host
    }

    func updateNSView(_ host: PlateHost, context: Context) {
        context.coordinator.action = action
        host.button.isEnabled = isEnabled
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: PlateHost, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 30)
    }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) { self.action = action }

        @objc func fire() { action() }
    }

    final class PlateHost: NSView {
        let button: ASAuthorizationAppleIDButton

        init(style: ASAuthorizationAppleIDButton.Style) {
            button = ASAuthorizationAppleIDButton(authorizationButtonType: .continue,
                                                  authorizationButtonStyle: style)
            super.init(frame: .zero)
            addSubview(button)
        }

        required init?(coder: NSCoder) { fatalError() }

        override func layout() {
            super.layout()
            button.frame = bounds
        }
    }
}
#endif

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

    /// Whether the steps read across two columns rather than down one. Decided by the window, not
    /// by this view: see `guideTwoColumns` on the controller.
    let twoColumns: Bool

    /// The app's own appearance — the system's, since this surface has no appearance setting of
    /// its own. Only the brand mark asks: it is the one drawing that ships in both inks.
    @Environment(\.colorScheme) private var colorScheme

    /// Carried over from `TopUpView`'s own tint, which no longer reaches here — the guide sits
    /// under both tabs now, and a `.tint` on the root would recolour the tab picker with it. Its
    /// own literal, like the other two, rather than a shared constant.
    private static let accent = Color(red: 4 / 255, green: 120 / 255, blue: 87 / 255)

    /// Wide enough for "1." at the size the steps are set in, and scaled with them: the number and
    /// its sentence share a first baseline, and a number clipped by its own column would take the
    /// indent with it.
    @ScaledMetric(relativeTo: .callout) private var stepNumberWidth: CGFloat = 18

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
    ///
    /// iOS 27 draws the button as three lines before any extension has run, with no card behind
    /// them — so the setup steps, which are read before the extension is enabled, show that.
    /// Earlier systems keep the card-and-two-lines drawing below.
    private static let extensionsIcon: Image = {
        if #available(iOS 27.0, *) {
            let drawn = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { _ in
                UIColor.black.setStroke()
                // The top two lines are the same length and the third is the short one — three
                // equal lines would be a generic hamburger, and the short tail is what makes this
                // Safari's own menu.
                for (y, end) in [(3.9, 9.95), (6.0, 9.95), (8.1, 7.45)] {
                    let line = UIBezierPath()
                    line.move(to: CGPoint(x: 2.05, y: y))
                    line.addLine(to: CGPoint(x: end, y: y))
                    line.lineWidth = 1.15
                    line.lineCapStyle = .round
                    line.stroke()
                }
            }
            return Image(uiImage: drawn.withRenderingMode(.alwaysTemplate))
        }
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
    /// is the one the how-to-fact-check steps name — by the time the reader gets there the popup
    /// has been opened, so the menu is showing it.
    ///
    /// Filled rather than stroked, with the two lines below it, on every system: the notch is a
    /// bite out of an edge rather than a line drawn inside the shape, so the silhouette carries the
    /// tab and the notch at twelve points where an outline lost them in the box around them.
    ///
    /// The piece is bigger before iOS 27 than on it. That is the control those systems draw — a
    /// piece that fills the space above the lines rather than sitting in a corner of it — and the
    /// two are only similar, not the same drawing. Everything else is shared.
    private static func puzzlePiece(x0: CGFloat, x1: CGFloat, y0: CGFloat, y1: CGFloat,
                                    corner: CGFloat, knob: CGFloat) -> UIBezierPath {
        let mid = (y0 + y1) / 2
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
        return card
    }

    private static let extensionsEnabledIcon: Image = {
        // The piece is about three fifths the width of the lines below it and sits at their left
        // edge, as Safari draws it: at the card's old full width the silhouette had no room left
        // for a notch and read as a bar.
        let card = puzzlePiece(x0: 2.05, x1: 6.99, y0: 1.5, y1: 5.7, corner: 0.9, knob: 0.75)
        // The earlier systems' larger piece, over the same two lines: as wide as they are, filling
        // the space above them rather than sitting in a corner of it, with the notch and the tab
        // scaled with the shape rather than left at a smaller piece's size.
        let earlier = puzzlePiece(x0: 1.9, x1: 9.9, y0: 0.5, y1: 7.5, corner: 1.42, knob: 1.2)

        let drawn = UIGraphicsImageRenderer(size: CGSize(width: 12, height: 12)).image { _ in
            // Two thirds opaque, which is how the button reads beside the lines rather than over
            // them: the piece is the control's reminder, not its subject. Template rendering keeps
            // the alpha channel, so this is the drawing's own weight and not a tint.
            UIColor.black.withAlphaComponent(2.0 / 3.0).setFill()
            if #available(iOS 27.0, *) {
                card.fill()
            } else {
                earlier.fill()
            }
            UIColor.black.setStroke()
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
        if #available(iOS 27.0, *) { return safariIcon27 }
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

    /// The same mark as iOS 27 draws it: the dial sits in a pale rounded square, carries tick
    /// marks around its rim, and the needle turns on a pink hub. Three details that are all but
    /// invisible at twelve points on their own — the rim is what the squircle adds, and the ticks
    /// are what stop the dial reading as a plain blue disc, which is why the old drawing could
    /// leave them out.
    private static let safariIcon27: Image = {
        let side: CGFloat = 12
        let drawn = UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { ctx in
            let face = UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: side, height: side),
                                    cornerRadius: side * 0.24)
            UIColor(red: 0.93, green: 0.96, blue: 1, alpha: 1).setFill()
            face.fill()

            let middle = CGPoint(x: side / 2, y: side / 2)
            let radius = side * 0.39
            let dial = UIBezierPath(ovalIn: CGRect(x: middle.x - radius, y: middle.y - radius,
                                                   width: radius * 2, height: radius * 2))
            dial.addClip()
            let gradient = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: [UIColor(red: 0.24, green: 0.68, blue: 0.98, alpha: 1).cgColor,
                         UIColor(red: 0.02, green: 0.42, blue: 0.88, alpha: 1).cgColor] as CFArray,
                locations: [0, 1])
            if let gradient {
                ctx.cgContext.drawLinearGradient(gradient,
                                                 start: CGPoint(x: 0, y: middle.y - radius),
                                                 end: CGPoint(x: 0, y: middle.y + radius),
                                                 options: [])
            }

            UIColor(white: 1, alpha: 0.55).setStroke()
            for step in 0..<12 {
                let angle = CGFloat(step) * .pi / 6
                let tick = UIBezierPath()
                tick.move(to: CGPoint(x: middle.x + cos(angle) * radius * 0.90,
                                      y: middle.y + sin(angle) * radius * 0.90))
                tick.addLine(to: CGPoint(x: middle.x + cos(angle) * radius * 0.72,
                                         y: middle.y + sin(angle) * radius * 0.72))
                tick.lineWidth = 0.3
                tick.lineCapStyle = .round
                tick.stroke()
            }

            let reach = side * 0.26, breadth = side * 0.065
            let north = CGPoint(x: middle.x + reach, y: middle.y - reach)
            let south = CGPoint(x: middle.x - reach, y: middle.y + reach)
            let east = CGPoint(x: middle.x + breadth, y: middle.y + breadth)
            let west = CGPoint(x: middle.x - breadth, y: middle.y - breadth)
            let red = UIBezierPath()
            red.move(to: north); red.addLine(to: east); red.addLine(to: south); red.close()
            UIColor(red: 0.95, green: 0.16, blue: 0.14, alpha: 1).setFill()
            red.fill()
            let white = UIBezierPath()
            white.move(to: north); white.addLine(to: south); white.addLine(to: west); white.close()
            UIColor.white.setFill()
            white.fill()

            let hub = UIBezierPath(ovalIn: CGRect(x: middle.x - side * 0.055,
                                                  y: middle.y - side * 0.055,
                                                  width: side * 0.11, height: side * 0.11))
            UIColor(red: 0.97, green: 0.45, blue: 0.52, alpha: 1).setFill()
            hub.fill()
        }
        return Image(uiImage: drawn.withRenderingMode(.alwaysOriginal))
    }()
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
            stepRows
        }
        .tint(Self.accent)
    }

    /// The steps in the arrangement the window has room for: one column of three, or two columns
    /// that read down the first and continue at the top of the second. The heading stays whole
    /// above both, since it names the section rather than any one step.
    @ViewBuilder
    private var stepRows: some View {
        if twoColumns {
            HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    stepRow(1)
                    stepRow(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 8) {
                    stepRow(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                stepRow(1)
                stepRow(2)
                stepRow(3)
            }
        }
    }

    @ViewBuilder
    private func stepRow(_ n: Int) -> some View {
        if isSignedIn {
            selectionStep(n)
        } else {
            setupStep(n)
        }
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
            .scaledFont(10, weight: .semibold).tracking(0.6)
            .foregroundStyle(.secondary)
            .padding(.bottom, 2)
            // Drawn at ten points, this is the smallest words on the screen and the name of the
            // section under it — which is exactly what the rotor's Headings entry is for.
            .accessibilityAddTraits(.isHeader)
    }

    /// How to get DisinfaX into Safari at all, by number: `stepRows` is what arranges them.
    @ViewBuilder
    private func setupStep(_ n: Int) -> some View {
        switch n {
        case 1:
            // Where Safari is named its own mark goes beside it: the steps are read by someone
            // with a browser open, and the name alone is the one word they are expected to find
            // in a menu.
            step(1, Self.sentence("Open {1} Safari and go to any website.", [.artwork(Self.safariIcon)]))
                .accessibilityLabel(Text(Self.spoken("Open {1} Safari and go to any website.")))
#if os(macOS)
        case 2:
            // The pane to turn it on in is named twice over, because "Extensions" on its own is
            // ambiguous with the rows inside it. The arrow is Safari's own path; the puzzle piece
            // is the mark Safari uses for the same pane once the extension is running.
            step(2, Self.sentence("Enable {1} DisinfaX in Safari → {2} Safari Extensions.",
                                  [.artwork(brandIcon(colorScheme)), .symbol(Image(systemName: "puzzlepiece"))]))
                .accessibilityLabel(Text(Self.spoken("Enable {1} DisinfaX in Safari → {2} Safari Extensions.")))
        default:
            // The mark stands where "the DisinfaX icon" stood, so it is spaced like any other
            // word rather than drawn tight against a noun it names. Safari's compass is not
            // repeated in the bar's name either: the word "Safari" is already the one the reader
            // is looking for.
            step(3, Self.sentence("Click {1} in the Safari toolbar to open the popup.",
                                  [.artwork(brandIcon(colorScheme), spaced: true)]))
                // Spoken, the mark has no name of its own, so this sentence keeps the words the
                // visible one drops — and that is the key the previous wording left in every
                // language, which is why the label reads it rather than the string above.
                .accessibilityLabel(Text(Self.spoken("Click the {1} DisinfaX icon in the {2} Safari toolbar to open the popup.")))
#else
        case 2:
            // The extensions button, NOT the Aa page-settings menu this used to name — they are
            // different controls in the address bar and only one of them lists extensions. The
            // sentence is one localization key with its inline images at `{1}`–`{3}`, so each
            // translation decides where the puzzle piece, the name and the checkmark fall
            // instead of inheriting English word order from a fixed split.
            step(2, Text("Tap the ") + Self.iconLeading(extensionsButtonMark,
                " icon in the address bar, then {1} Manage Extensions, and turn on {2} DisinfaX, and validate {3}.",
                [.symbol(Image(systemName: "puzzlepiece")), .artwork(brandIcon(colorScheme)), .symbol(Image(systemName: "checkmark.circle"))]))
                // An inline image carries no translation — spoken, it is only the symbol's own
                // name. The sentence without its markers is the localized thing, so read that.
                .accessibilityLabel(Text(
                    String(localized: "Tap the ")
                    + Self.spoken(" icon in the address bar, then {1} Manage Extensions, and turn on {2} DisinfaX, and validate {3}.")
                ))
        default:
            // The menu stays open once the extension is validated — it does not close itself —
            // so DisinfaX is listed where the reader already is. Naming the menu again would
            // send them to reopen one that never shut.
            step(3, Self.sentence("Tap {1} DisinfaX to open the popup.",
                                  [.artwork(brandIcon(colorScheme))]))
                .accessibilityLabel(Text(Self.spoken("Tap {1} DisinfaX to open the popup.")))
#endif
        }
    }

    /// The web selection: what the extension does once it is running, by number.
    @ViewBuilder
    private func selectionStep(_ n: Int) -> some View {
        switch n {
        case 1:
            step(1, "On any webpage, select the text you want to fact-check.")
#if os(macOS)
        case 2:
            step(2, "Right-click the selected text and choose Disinfact (also works on unselected text).")
        default:
            step(3, "The fact-check starts right away and is charged to your balance.")
#else
        case 2:
            // One sentence for both tablets: the extensions button sits in the address bar on the
            // iPhone and — once the extension is enabled, which is the only state this guide is
            // shown in — on the iPad too. The name inside the sentence is the one image the
            // translation has to place, so it is a marker in a single key rather than a split at
            // a fixed word.
            step(2, Text("With the text still selected, tap the ") + Self.iconLeading(extensionsButtonOnMark,
                " icon in the address bar, then choose {1} DisinfaX.", [.artwork(brandIcon(colorScheme))]))
                .accessibilityLabel(Text(
                    String(localized: "With the text still selected, tap the ")
                    + Self.spoken(" icon in the address bar, then choose {1} DisinfaX.")
                ))
        default:
            step(3, "The fact-check starts right away and is charged to your balance.")
#endif
        }
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n).").font(.callout).bold().foregroundStyle(.secondary).frame(width: stepNumberWidth, alignment: .trailing)
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
    /// of its own: the extensions button in the address bar, which points at itself rather than at
    /// the sentence it sits in.
    ///
    /// A mark written against the last word of its sentence is that word's own suffix, naming
    /// nothing — the checkmark closing "and validate" — and takes no such space: the pair is one
    /// word, and a break between them leaves the checkmark on a line it does not belong to.
    private struct GuideMark {
        let text: Text
        let spaced: Bool

        static func artwork(_ image: Image, spaced: Bool = false) -> GuideMark {
            GuideMark(text: Text(image).baselineOffset(-1.5) + Self.join(spaced: spaced), spaced: spaced)
        }

        static func symbol(_ image: Image, spaced: Bool = false) -> GuideMark {
            GuideMark(text: Text(image) + Self.join(spaced: spaced), spaced: spaced)
        }

        /// U+2060 WORD JOINER, carried in the mark's own text.
        ///
        /// An inline image is an object replacement character (U+FFFC), which Unicode gives the
        /// line-break class CB — a break is allowed on either side of it, whatever the text
        /// around it says. So "choose ⚙DisinFAX" broke after the mark however tightly the words
        /// were set: "then choose ⚙" / "DisinFAX." A word joiner forbids a break on either side
        /// of itself, which is what glues the mark to the word it names.
        ///
        /// A `spaced` mark is not glued to anything — it stands where a word would — so it gets
        /// nothing, and its own ordinary spaces keep providing the breaks around it.
        private static func join(spaced: Bool) -> Text {
            spaced ? Text(verbatim: "") : Text(verbatim: "\u{2060}")
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
                // A `spaced` mark names no word at all — the extensions button: it stands where a
                // word would, so it keeps both spaces as they are written, and a line may fall on
                // either side of it. Anything that DOES name words is tight
                // against them even when those words are a phrase rather than one noun: the
                // puzzle piece is "🧩 Safari Extensions", one name, not a button beside two words.
                //
                // Which word a mark is tight against depends on which side it was written
                // without a space, and the space on the other side is the one that may break. A
                // mark the sentence follows with a space opens the phrase it belongs to — "…choose
                // ⚙ DisinFAX" — so the space before it is left ordinary; one written against the
                // end of the phrase — "DisinFAX ⚙" — is that phrase's own suffix, and the space
                // before it becomes a no-break one. Either way the mark cannot be carried onto a
                // line of its own: the word joiner inside the mark forbids that side too — see
                // `GuideMark.join`.
                let spaced = images[n - 1].spaced
                let opensPhrase = i + 3 < characters.count && characters[i + 3] == " "
                if !spaced, !opensPhrase, run.hasSuffix(" ") { run.removeLast(); run.append("\u{00A0}") }
                text = text + Text(verbatim: run) + images[n - 1].text
                run = ""
                i += 3
                if !spaced, opensPhrase { i += 1 }
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
