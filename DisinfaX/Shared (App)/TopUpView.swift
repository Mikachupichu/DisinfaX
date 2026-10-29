import SwiftUI
import StoreKit
import Combine
import Foundation

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The app's top-up surface.
///
/// This exists because the purchase cannot happen in the Safari extension: `Product.purchase()`
/// needs a window to present its sheet and an appex has none (measured — the fetch succeeds,
/// then purchase throws `StoreKitError.unknown` in 36 ms). App Review 4.4 also says extensions
/// "may not include ... in-app purchases", so this screen is the initiating surface, not a
/// pass-through: the user picks an amount here and confirms here.
///
/// It is also usable on its own. Someone can open the app directly and top up without touching
/// the popup, which is why the amount falls back through requested → last used → 5, and why the
/// Safari guide is always visible rather than shown only on first run — though that guide is now
/// `RootView`'s, below both tabs, rather than the tail of this one.
@available(macOS 13.0, iOS 16.0, *)
struct TopUpView: View {

    /// What the header calls this pane. The app's own name when it stands alone; the pane's name
    /// when it is laid out beside the other one, where two "DisinfaX" headings say nothing.
    var headerTitle: LocalizedStringKey = "DisinfaX"

    /// Content that belongs to the tab region but to neither pane in particular — the account
    /// actions. Drawn at the end of this pane's own scroll content, so they scroll with it and
    /// are covered by the guide's overlay along with the rest of the tab.
    var footer: AnyView? = nil

    /// Product ids exist for 1...100 only (com.disinfax.topup.v6.N), so the field is bounded to
    /// match. Anything outside it would fail the StoreKit lookup with an opaque error.
    private static let minAmount = 1
    private static let maxAmount = 100

    /// Tailwind `emerald-700` (#047857): the same green the popup's own Top Up button is painted
    /// in, and its primary buttons with it — the popup re-points `emerald-600` to this value for
    /// exactly the reason below.
    ///
    /// `emerald-600` (#059669), Tailwind's own shade, reads at 3.8:1 both ways round — white ink
    /// on it, and it as the type on white — under the 4.5:1 small text needs. One step down takes
    /// the "after top-up" figure and the button's label past 5.5:1 without leaving the family, so
    /// the two surfaces still read as the same product. Hard-coded rather than an asset-catalogue
    /// colour, and applied as a `.tint` so the button, the stepper and the Markdown links all
    /// follow it instead of the system blue.
    private static let accent = Color(red: 4 / 255, green: 120 / 255, blue: 87 / 255)

    @State private var amount: Int = SharedTopUpStore.initialAmount()
    @State private var amountText: String = ""
    /// The field is exactly wide enough for three digits at the size it is drawn. Measured
    /// rather than left to the digits themselves, so the stepper beside it does not step aside
    /// as the number is typed — and scaled with the text, so the digits are not the part that
    /// gets clipped when the reader asks for larger text.
    @ScaledMetric(relativeTo: .body) private var amountFieldWidth: CGFloat = 78
    @State private var isPurchasing = false
    /// Amount bought but not yet visible in the balance.
    ///
    /// The credit is posted from here, but the figure itself arrives over the funds channel (see
    /// `SupabaseRealtime`), which writes what the server sends into the shared container. Until
    /// that figure moves the balance is knowably out of date, so rather than display it with no
    /// explanation the purchase is named as in flight.
    @State private var pendingCredit: Int?

    /// The balance the shared container held when this purchase was posted, so "has it landed?" is
    /// answered against that figure rather than against whatever the last tick happened to read.
    ///
    /// The two differ because the funds push can arrive while the credit request is still in
    /// flight: the tick then records the new balance before `pendingCredit` is set, and a comparison
    /// against it never moves again — the notice stuck forever and the popup the only way out.
    @State private var creditBaseline: Double?

    /// Whether the app itself confirmed the credit for the purchase in flight.
    ///
    /// The awaiting notice's only line that names Safari is the one telling the reader the popup
    /// is where the balance appears. When the app has already credited the purchase that is not
    /// just redundant, it is wrong — so it is shown only on the path that actually needs it.
    @State private var creditConfirmed = false

    /// Ticks elapsed since the purchase, counted by the same poll that watches for the new balance.
    @State private var pendingTicks = 0

    /// How long the Top Up button stays blocked while a credit is in flight.
    ///
    /// Bounded on purpose. Blocking is right — while a purchase is unconfirmed the displayed balance
    /// is unknown, so "after top-up" would be a guess, and buying the same amount again just returns
    /// the unfinished transaction — but a block whose release condition might never arrive would
    /// strand the user with no way to spend money at all. Two minutes is far longer than the credit
    /// normally takes, and after it the button returns with the notice still showing.
    private static let pendingBlockTicks = 60   // × the 2s poll ≈ 2 minutes

    private var isAwaitingCredit: Bool { pendingCredit != nil }
    private var purchaseBlocked: Bool { isAwaitingCredit && pendingTicks < Self.pendingBlockTicks }
    @State private var message: String?
    @State private var messageIsError = false

    // State, not `let`. The balance was captured once when the view was constructed, so the app
    // kept showing the figure as it stood at launch — top up, watch the popup credit it, come
    // back, and the app was still displaying the old figure. The extension writes the fresh value
    // into the shared container whenever the popup sees it; the app has to actually re-read it.
    // (Identity is re-read by the same ticker for the same reason, and read live from the store at
    // sale time: selling must see the stamp as it is now, not as it was when the pane last drew.)
    @State private var balance: Double? = SharedTopUpStore.balance

    /// Coming back from Safari is precisely when the shared container has new values in it, and
    /// activation is the one event that reliably marks it — whether the user switched apps, clicked
    /// the Dock icon, or followed the "Return to Safari" round trip.
    private static let didBecomeActive: Notification.Name = {
#if os(macOS)
        NSApplication.didBecomeActiveNotification
#else
        UIApplication.didBecomeActiveNotification
#endif
    }()

    /// Polls the shared container while this view is on screen.
    ///
    /// Activation alone is not enough: the balance is credited server-side, and the extension can
    /// take up to a minute to wake and mirror it across, by which time the user is already sitting
    /// here having activated long ago. Without this they would have to switch away and back to see
    /// a number that had already arrived.
    ///
    /// The work per tick is a UserDefaults read, so the cost is negligible; SwiftUI only delivers
    /// it while the view is in the hierarchy.
    private static let pollInterval: TimeInterval = 2

    /// Whether the shared container holds a session this app may sell against.
    ///
    /// The whole top-up card (balance included) renders only with a session, because that
    /// session is what the backend authenticates the purchase as — without it there is no
    /// account to attach `appAccountToken` to and nobody to credit.
    ///
    /// State, and re-read by the ticker, rather than read from the store where the card renders.
    /// The store is not observable, so a body that read it directly was only ever as live as its
    /// last render: a pane drawn while signed out went on showing the signed-out sentence after
    /// a sign-in that nothing had re-rendered — so switching tabs, which re-renders the tree, was
    /// the only thing that made the pane appear to correct itself. See `refreshFromStore`.
    /// Seeded from the store like `balance` above, so the first draw is the state the store is
    /// actually in: starting at `false` and letting `onAppear` correct it would flash the sign-in
    /// sentence over a card that then appears.
    @State private var hasSession = SharedTopUpStore.signedInUserId != nil

    /// Whether this pane has already asked the server for a figure it found missing. Reset by a
    /// change of session and by coming back to the app; see `readBalanceIfMissing`.
    @State private var didReadFunds = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header

                // The top-up card appears only when a purchase could actually be credited.
                // Without a session in the shared container there is no account to attach
                // `appAccountToken` to and the backend has nobody to credit, so showing an
                // amount field would be an invitation to pay into a void.
                //
                // There is no longer a third state between "signed in" and "signed out": the app
                // holds the refresh token too (`AppSession`), so a session it can see is one it
                // can keep alive, and the ticker's renewal is what moves this between the two.
                if SharedTopUpStore.isAvailable && hasSession {
                    topUpCard
                } else if !SharedTopUpStore.isAvailable {
                    misconfiguredNotice
                } else {
                    Text("You're not signed in. Please sign in and try again.")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let footer { footer }
            }
            .padding(24)
            .tint(Self.accent)
            // A ceiling rather than a fixed width, like `FactCheckView`'s: the macOS window is
            // sized to 440 (see `applyMeasuredHeight`), so this still stops at 392 there, while a
            // phone narrower than 392 gets its own width instead of a canvas hanging over both
            // edges — which also drags the guide's heading off the padding it asks for.
            .frame(maxWidth: 392, alignment: .leading)
            // How tall the balance view is when nothing is squeezing it. Measured here, inside
            // the scroll, because the ScrollView around this reports only the space it was given
            // and so can never say how much it wanted. Read by `ViewController` to size the
            // window; see `PaneHeights`.
            .background(GeometryReader { proxy in
                Color.clear.preference(key: PaneHeightsKey.self, value: PaneHeights(topUp: proxy.size.height))
            })
        }
        .onAppear {
            amountText = String(amount)
            refreshFromStore()
            // Started for the user rather than by them. An incoming `disinfax://topup` means they
            // already picked this amount and pressed Top Up in the Safari popup, so the same button
            // on this screen would only be asking them to say it twice — and the app is the only
            // surface that can actually charge, so the second tap is pure ceremony.
            //
            // Ordered after `refreshFromStore`, which is what brings in the identity the sale has
            // to be bound to, and consumed whether or not the sale can proceed: an appearance that
            // cannot sell (a stamp that has aged past the freshness window, no shared container)
            // clears the intent and leaves the user the sentence explaining what to do instead.
            // Parking it would arm a purchase to fire at some later launch they never asked for.
            //
            // Every launch that can sell is a correct one: the flag and the amount are written by
            // `handleTopUp` before this view exists, and a hand-off to an already-running app
            // rebuilds the tree through `.disinfaxTopUpRequested`, which constructs a new
            // `TopUpView` — seeded from the store — before this runs again.
            if SharedTopUpStore.takeAutoStartPurchase() {
                Task { await purchase() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Self.didBecomeActive)) { _ in
            // Coming back is when a read that failed — a launch with no network, a session the
            // server had not finished minting — is worth taking again.
            didReadFunds = false
            refreshFromStore()
        }
        // A `.task` rather than `Timer.publish` held as a `let` on the view: that publisher is
        // rebuilt with every new copy of this struct, and each rebuild restarts its countdown — so
        // a re-rendering parent could keep the poll from ever firing, leaving a landed credit
        // behind a notice that only a return from the popup cleared.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
                refreshFromStore()
            }
        }
        // What a purchase came to — a credit, or the App Store's refusal — is written into
        // `message` beneath the button that was pressed, and nothing moves the cursor to it. The
        // balance blocks above change at the same moment and are replaced outright once a credit
        // is in flight, so that one is said too. See `announce`.
        .onChange(of: message) { message in
            if let message { announce(message) }
        }
        .onChange(of: pendingCredit) { credit in
            guard let credit else { return }
            announce(creditConfirmed
                     ? String(localized: "Your US$\(credit) top-up is being applied.")
                     : String(localized: "Open the popup in Safari to view your updated balance"))
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(headerTitle).scaledFont(26, weight: .bold, relativeTo: .largeTitle)
                // What the pane is, for the heading rotor. The sentence under it describes the
                // pane and stays an ordinary element.
                .accessibilityAddTraits(.isHeader)
            Text("Add funds to your balance")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    // MARK: - Top-up card

    private var topUpCard: some View {
        VStack(alignment: .leading, spacing: 18) {

            // Balance → future balance. While a purchase is unconfirmed the balance shown here is
            // knowably out of date, and "after top-up" would be arithmetic on a stale figure.
            // Saying so is more use than displaying two numbers that are both wrong.
            if let pendingCredit {
                awaitingBalanceNotice(amount: pendingCredit)
            } else {
                balanceComparison
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("TOP-UP AMOUNT")
                    .scaledFont(10, weight: .semibold).tracking(0.6)
                    .foregroundStyle(.secondary)
                    // A caption for the eye. The field under it is labelled with these same
                    // words, and the stepper beside it too — read as well, it is the third time
                    // in three swipes.
                    .accessibilityHidden(true)
                HStack(spacing: 6) {
                    // "US$", never "$". Every amount here is a USD tier, but Apple charges in the
                    // buyer's own storefront currency — the $3 tier bills CAD 4.00 in Canada. A bare
                    // "$" in front of a Canadian or Australian customer states a price that is not
                    // what they will be charged. Prefix or suffix following the device locale's own
                    // USD convention (e.g. "US$5" vs "5 US$") — see UsdFormat.
                    if !UsdFormat.symbolAfterAmount {
                        usdSymbol(size: 17, weight: .medium).foregroundStyle(.secondary)
                    }
                    TextField("", text: $amountText)
                        .textFieldStyle(.roundedBorder)
                        .scaledFont(17, weight: .medium).monospacedDigit()
                        .accessibilityLabel(Text("TOP-UP AMOUNT"))
                        .frame(width: amountFieldWidth)
                        .multilineTextAlignment(.trailing)
#if os(iOS)
                        .keyboardType(.numberPad)
#endif
                        // Sanitise on every keystroke rather than on submit: strips anything
                        // non-numeric (so a pasted "$5.00" or a typed "-" cannot get in) and
                        // clamps to the product range. Empty is allowed transiently so the
                        // field can be cleared and retyped without snapping back to 1.
                        // The single-parameter closure, deprecated in macOS 14 / iOS 17 but the
                        // only form available on 13 / 16 — which is where this view starts.
                        .onChange(of: amountText) { new in
                            let digits = new.filter(\.isNumber)
                            if digits.isEmpty { amountText = ""; return }
                            let clamped = min(max(Int(digits) ?? Self.minAmount, Self.minAmount), Self.maxAmount)
                            amount = clamped
                            // Remembered as it is typed, not on purchase: someone who abandons a
                            // top-up and comes back later still finds their amount waiting, and
                            // this is what initialAmount() falls back to when the app is opened
                            // directly rather than handed off from the popup.
                            SharedTopUpStore.lastAmount = clamped
                            let normalised = String(clamped)
                            if normalised != new { amountText = normalised }
                        }

                    Stepper("") { increment(1) } onDecrement: { increment(-1) }
                        .labelsHidden()
                        .accessibilityLabel(Text("TOP-UP AMOUNT"))

                    // Suffix counterpart to the "US$" prefix above: in suffix locales the
                    // currency group sits after the field (e.g. "5 US$").
                    if UsdFormat.symbolAfterAmount {
                        usdSymbol(size: 17, weight: .medium).foregroundStyle(.secondary)
                    }

                    Spacer()
                }
                // 1 and 100 are baked in as literal text, not interpolated: they are the fixed
                // product-range constants above and never change, so hardcoding them removes any
                // risk of mismatching Swift's compiler-generated %lld placeholder format in the
                // translation catalog, for a string that would only ever show these two numbers.
                Text("Whole US dollars, 1–100. Charged in your App Store currency.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                Task { await purchase() }
            } label: {
                HStack {
                    if isPurchasing { ProgressView().controlSize(.small).accessibilityHidden(true) }
                    Text(isPurchasing ? "Contacting the App Store…" : "Top Up Balance")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(Self.accent)
            .disabled(isPurchasing || amountText.isEmpty || purchaseBlocked)

            disclaimer

            if let message {
                VStack(alignment: .leading, spacing: 10) {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(messageIsError ? Color.red : Self.accent)
                        .fixedSize(horizontal: false, vertical: true)

                    // Only after a successful payment, and only on macOS. iOS gives an app no way
                    // to hand control back to Safari, so there the sentence above is all there is —
                    // which is why it names the step instead of implying a button will do it.
#if os(macOS)
                    if !messageIsError {
                        Button("Return to Safari") { SafariSettingsOpener.activateSafari() }
                    }
#endif
                }
            }
        }
        .padding(16)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary, lineWidth: 1))
    }

    // MARK: - Balance → future balance

    /// The two figures the purchase moves between, side by side while they fit and stacked when
    /// they do not.
    ///
    /// The arrow is what makes the outcome explicit before the payment sheet appears, which is the
    /// whole point of confirming here; which way it points is decided by the room there is for it
    /// rather than by the width of the window. The amounts are the widest thing in the card and
    /// they grow with the balance — and the labels grow with the language — so a four-figure
    /// balance, a larger text size or a longer translation is what turns a comfortable row into two
    /// numbers cut off mid-digit. Stacked, they are short enough for anything.
    ///
    /// `ViewThatFits` takes the first candidate that fits, and the row has to be measured by what it
    /// needs rather than by what it is offered: `usdAmount` pins its own width for exactly this, so
    /// a row that cannot hold both amounts whole reports the width it required and the stack is
    /// used instead. An amount left flexible would report whatever it was given, the row would
    /// always claim to fit, and the second candidate would never be reached.
    private var balanceComparison: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                balanceBlock(label: "BALANCE", value: balance, accented: false)
                arrow("arrow.right")
                balanceBlock(label: "AFTER TOP-UP", value: futureBalance, accented: true)
            }
            VStack(alignment: .leading, spacing: 12) {
                balanceBlock(label: "BALANCE", value: balance, accented: false)
                arrow("arrow.down")
                balanceBlock(label: "AFTER TOP-UP", value: futureBalance, accented: true)
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// What the balance becomes if the amount in the field is bought. Nil when the popup has never
    /// reported a balance, which the blocks show as "—" rather than as a figure.
    private var futureBalance: Double? { balance.map { $0 + Double(amount) } }

    private func arrow(_ name: String) -> some View {
        Image(systemName: name)
            .scaledFont(13, weight: .semibold)
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }

    /// The same fine print the popup shows under its own Top Up button, and for the same reason:
    /// this is now a place a purchase is initiated, so the terms have to be in front of the user
    /// here too, not only in the surface they may have come from.
    ///
    /// Matches the popup's Safari build, which shows the agreement line and the FX note but not
    /// the jurisdiction list. Written as Markdown so the two links are tappable without building
    /// an AttributedString by hand; they open in the default browser.
    private var disclaimer: some View {
        Text("By topping up, you agree to our [Terms of Service](https://disinfax.app/terms-of-use) and [Privacy Policy](https://disinfax.app/privacy-policy). Foreign exchange fees may apply if you pay in a currency other than USD.")
            .scaledFont(10)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
    }

    private func balanceBlock(label: LocalizedStringKey, value: Double?, accented: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .scaledFont(10, weight: .semibold).tracking(0.6)
                .foregroundStyle(.secondary)
            // "—" when the popup has never reported a balance. Showing 0 would read as a real
            // balance of zero, which is a different and alarming thing. Position follows the
            // device locale's USD convention ("US$3.24" vs "3,24 US$") — see UsdFormat.
            if let value {
                usdAmount(value, size: 22)
                    .foregroundStyle(accented ? Self.accent : Color.primary)
            } else {
                Text("—")
                    .scaledFont(22, weight: .semibold).monospacedDigit()
                    .foregroundStyle(accented ? Self.accent : Color.primary)
                    // A dash is punctuation; the reader needs what it stands for. Read inside the
                    // combined block, this says "BALANCE, Not available yet".
                    .accessibilityLabel(Text("Not available yet"))
            }
        }
        // The label and its figure are one reading — "BALANCE, US$84.9954" — and the dash that
        // stands in for an unreported balance is only understandable beside the label it sits
        // under, where a cursor arriving at it otherwise just hears "dash".
        .accessibilityElement(children: .combine)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Currency

    /// The "US" that marks the currency, at 60% of the amount's size.
    ///
    /// Centered against the number rather than sharing its baseline: an `HStack` centers the two
    /// runs' own boxes, and because ascent, descent and cap height all scale with the point size,
    /// the box centers sit at the same fraction of each — which lands this on the digits' midline
    /// instead of on their feet.
    ///
    /// The treatment and the 60% are the popup's own (`Dashboard.tsx`, `Usd`).
    private func usdQualifier(size: CGFloat) -> some View {
        Text("US").scaledFont(size * 0.6, weight: .semibold)
    }

    /// A USD amount as the popup states one: "US" small, "$" at full size, and the mark on the
    /// OUTSIDE of the pair so the "$" is always the glyph against the number — "US$3.24" in
    /// English, "3,24 $US" in French. An app that ordered those its own way would be a second
    /// convention for the same balance.
    private func usdAmount(_ value: Double, size: CGFloat, weight: Font.Weight = .semibold) -> some View {
        let number = UsdFormat.number(from: value)
        return HStack(alignment: .center, spacing: 0) {
            if UsdFormat.symbolAfterAmount {
                Text(number).scaledFont(size, weight: weight).monospacedDigit()
                // The space is inside the run, so the "$" cannot be wrapped away from the number
                // it belongs to.
                Text("\u{00A0}$").scaledFont(size, weight: weight)
                usdQualifier(size: size)
            } else {
                usdQualifier(size: size)
                Text("$" + number).scaledFont(size, weight: weight).monospacedDigit()
            }
        }
        // Three runs, one figure. Read separately they are "US", "$84.9954" and — in a suffix
        // locale — a currency word after the number: a sum taken apart at its own currency mark.
        .accessibilityElement(children: .combine)
        // Pinned rather than flexible, and only this side of the pair: this is the width
        // `balanceComparison` measures to decide whether a row can hold both amounts. A flexible
        // one reports whatever it is offered, so the row would claim to fit at any width and the
        // stacked candidate would never be reached.
        .fixedSize(horizontal: true, vertical: false)
    }

    /// The mark alone, for the field that holds the number itself: the same pair `usdAmount` puts
    /// around an amount, in the locale's own order.
    private func usdSymbol(size: CGFloat, weight: Font.Weight) -> some View {
        HStack(alignment: .center, spacing: 0) {
            if UsdFormat.symbolAfterAmount {
                Text("$").scaledFont(size, weight: weight)
                usdQualifier(size: size)
            } else {
                usdQualifier(size: size)
                Text("$").scaledFont(size, weight: weight)
            }
        }
    }

    /// Shown in place of the balance while a purchase is being applied.
    ///
    /// The figure cannot be read back locally: it arrives on the funds channel, so this stands in
    /// until a delivery lands and moves the balance.
    private func awaitingBalanceNotice(amount: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("BALANCE")
                .scaledFont(10, weight: .semibold).tracking(0.6)
                .foregroundStyle(.secondary)
            // Only when the popup is genuinely how this purchase gets applied — i.e. the app's own
            // attempt did not confirm the credit.
            if !creditConfirmed {
                Text("Open the popup in Safari to view your updated balance")
                    .scaledFont(15, weight: .semibold)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(purchaseBlocked
                 ? "Your US$\(amount) top-up is being applied."
                 : "Your US$\(amount) top-up is taking longer than usual to appear.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Re-reads the values the extension owns. Cheap enough to run on every activation, and the
    /// success message is cleared once the balance actually moves so a stale "Payment complete"
    /// does not sit above a figure that has already been updated.
    private func refreshFromStore() {
        // Before the ask below, because what it authenticates with is what this brings in.
        SharedTopUpStore.reloadFromDisk()
        let latestBalance = SharedTopUpStore.balance

        // The session is re-read here rather than where the card renders, so the pane's verdict on
        // it moves with the store instead of with the last re-render the tab switch happened to
        // cause. Nothing else in this function observes it, so this is the transition that matters
        // and not a per-tick flip.
        let latestSignedIn = SharedTopUpStore.signedInUserId != nil
        if latestSignedIn != hasSession {
            hasSession = latestSignedIn
            // A session this pane has not asked for yet — the next tick reads the figure for it.
            didReadFunds = false
        }

        // Renew, then ask for the balance to be pushed. Renewal comes first because this channel
        // authenticates with whatever token is on disk, and one that lapsed since the last tick
        // joins a channel that row-level security then keeps silent — healthy socket, no events.
        // Both are no-ops when the token is live and the channel is up, so every tick can do this.
        Task { @MainActor in
            _ = await AppSession.current()
            SharedTopUpStore.reloadFromDisk()
            SupabaseRealtime.shared.ensureFundsChannel()
            readBalanceIfMissing()
        }

        // The balance as it stands before this credit is posted. A move away from it — whether the
        // tick saw it or the store already held it when the purchase returned — is the landing.
        let landed = pendingCredit != nil && creditBaseline.map { $0 != latestBalance } == true
        if latestBalance != balance || landed {
            // The balance moved, so the purchase has landed: drop the notice, unblock the button and
            // clear the success message rather than leaving any of them over a figure that is now
            // correct. Keyed on the balance changing at all, not on it matching the expected total,
            // because a concurrent spend would make an exact comparison never come true.
            pendingCredit = nil
            creditBaseline = nil
            pendingTicks = 0
            creditConfirmed = false
            if !messageIsError, message != nil { message = nil }
        } else if pendingCredit != nil {
            pendingTicks += 1
        }
        balance = latestBalance
    }

    /// One direct read of the funds row, when the shared container has no figure to show.
    ///
    /// The socket's join already reads the row once, and that is the ordinary path — but it is a
    /// channel that has to join first, and a sign-in this app performed itself has no other
    /// reader behind it. The figure then stayed blank until the popup was opened, which is a
    /// dependency on the extension for something the app has everything it needs to ask for:
    /// the session, the RPC and the store. Once per session, and again on each return to the
    /// app, because `get_funds` bills a `funds` unit every time it is called.
    @MainActor
    private func readBalanceIfMissing() {
        guard hasSession, !didReadFunds, SharedTopUpStore.balance == nil else { return }
        didReadFunds = true
        Task { @MainActor in
            guard let total = await FactCheckNotifier.fetchTotal() else { return }
            SharedTopUpStore.balance = total
            SharedTopUpStore.reloadFromDisk()
            if let stored = SharedTopUpStore.balance { balance = stored }
        }
    }

    private func increment(_ delta: Int) {
        amount = min(max(amount + delta, Self.minAmount), Self.maxAmount)
        amountText = String(amount)
    }

    // MARK: - States where selling would be wrong

    private var misconfiguredNotice: some View {
        notice(
            title: Text("Setup incomplete"),
            body: Text(String(localized: "This build cannot reach its shared container (App Group \(SharedTopUpStore.appGroupIdentifier)). Top-ups are unavailable until the App Groups capability is added to both the app and the extension.")),
            systemImage: "exclamationmark.triangle"
        )
    }

    private func notice(title: Text, body: Text, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage).font(.title2).foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                title.font(.headline)
                body.font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Purchase

    private func purchase() async {
        // Double-check the session at the moment of sale, not just at render: it can be dropped
        // between the view appearing and the user tapping. Re-reads the store rather than
        // trusting @State, and refreshes so the next render shows the signed-out screen instead
        // of a dead button.
        //
        // The refresh is the whole of the answer: it moves `hasSession`, which is what the card
        // and the sentence are chosen by, so the card is replaced by that sentence as the tap
        // returns rather than by a message set here — a message would outlive the state it was
        // about, which is exactly the sentence a user could dismiss by leaving the tab and
        // coming back.
        guard let saleUserId = SharedTopUpStore.signedInUserId, !saleUserId.isEmpty else {
            refreshFromStore()
            return
        }
        let userId = saleUserId
        guard let value = Int(amountText), value >= Self.minAmount, value <= Self.maxAmount else {
            message = String(localized: "Enter a whole dollar amount between 1 and 100.")
            messageIsError = true
            return
        }

        isPurchasing = true
        message = nil
        defer { isPurchasing = false }

        do {
            let outcome = try await StoreKitManager.shared.purchaseProduct(amount: value, userId: userId)
            // Read BEFORE appendPendingTransaction below, which would otherwise make every
            // transaction look already-known.
            let wasAlreadyRecorded = SharedTopUpStore.isPending(transactionId: outcome.transactionId)

            // Recorded before anything else can fail. A crash or a force-quit between here and
            // the credit leaves a recoverable record rather than a charge with nothing to show.
            SharedTopUpStore.appendPendingTransaction(jws: outcome.jws,
                                                      transactionId: outcome.transactionId,
                                                      amount: outcome.amount)

            // Credited here rather than left for the popup: the app holds its own session, so it
            // can post the same receipt the popup would — and the funds row that changes is what
            // its realtime channel delivers back to the balance below. The popup's settlement
            // pass remains the recovery route for anything that fails here.
            //
            // Read before the post, because the new figure can arrive over the channel while the
            // request is still in flight; a baseline taken afterwards would already contain it.
            let baseline = SharedTopUpStore.balance
            let credited = await StoreKitManager.shared.creditPendingTransaction(
                jws: outcome.jws,
                transactionId: outcome.transactionId)

            // Every branch names the amount Apple actually returned, never the one in the field.
            // StoreKit hands back an existing UNFINISHED transaction rather than charging again for
            // the same product, and a transaction stays unfinished until it is credited — so
            // pressing Top Up twice for the same amount before the first is settled returns that
            // purchase in about 30ms with no payment sheet. Nothing was bought the second time, and
            // reporting "Payment complete" there reads as a second charge that never happened.
            if credited {
                // Nothing to add: the balance below is about to move, and that is the receipt.
                message = nil
            } else if wasAlreadyRecorded {
                message = String(localized: "You already have a US$\(outcome.amount) top-up waiting to be applied — you have not been charged again. Return to Safari and open the DisinfaX popup to apply it to your balance.")
            } else if outcome.amount > 0 && outcome.amount != value {
                message = String(localized: "An earlier US$\(outcome.amount) purchase was still waiting to be applied, so that one was completed instead of charging you again. Return to Safari and open the DisinfaX popup to see your updated balance.")
            } else {
                message = String(localized: "Payment complete. Return to Safari and open the DisinfaX popup to see your updated balance.")
            }
            messageIsError = false
            creditConfirmed = credited
            pendingTicks = 0

            // A confirmed credit ends the in-flight state: the money is in, so there is nothing
            // left to wait for and nothing to tell the reader about. The figure is read once here
            // rather than waited for over the funds channel — waiting on that push is what left
            // the notice standing over a balance that had already been credited.
            if credited {
                pendingCredit = nil
                creditBaseline = nil
                Task { @MainActor in
                    if let total = await FactCheckNotifier.fetchTotal() {
                        SharedTopUpStore.balance = total
                        SharedTopUpStore.reloadFromDisk()
                        if let stored = SharedTopUpStore.balance { balance = stored }
                    } else {
                        // The read failed, so the figure on screen is knowably old after all.
                        pendingCredit = outcome.amount
                        creditBaseline = baseline
                    }
                }
            } else {
                pendingCredit = outcome.amount
                creditBaseline = baseline
            }
        } catch {
            message = error.localizedDescription
            messageIsError = true
        }
    }
}
