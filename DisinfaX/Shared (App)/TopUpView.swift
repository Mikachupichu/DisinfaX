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
/// Safari instructions below are always visible rather than shown only on first run.
@available(macOS 13.0, iOS 16.0, *)
struct TopUpView: View {

    /// Product ids exist for 1...100 only (com.disinfax.topup.v6.N), so the field is bounded to
    /// match. Anything outside it would fail the StoreKit lookup with an opaque error.
    private static let minAmount = 1
    private static let maxAmount = 100

    /// Tailwind `emerald-600` (#059669), the exact colour of the popup's Top Up button. Hard-coded
    /// rather than an asset-catalogue colour so the two surfaces cannot drift apart silently, and
    /// applied as a `.tint` so the button, the stepper and the Markdown links all follow it
    /// instead of the system blue.
    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

    @State private var amount: Int = SharedTopUpStore.initialAmount()
    @State private var amountText: String = ""
    @State private var isPurchasing = false
    /// Amount bought but not yet visible in the balance.
    ///
    /// The balance is credited server-side within seconds, but this app cannot see that: it has no
    /// session of its own and reads the figure the Safari extension mirrors into the shared
    /// container. On iOS that mirror is frozen while the app is in the foreground, because iOS
    /// suspends Safari — and with it the extension — the moment it is backgrounded. So rather than
    /// display a number that is knowably out of date with no explanation, the purchase is named as
    /// in flight until the real figure moves.
    @State private var pendingCredit: Int?

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

    // State, not `let`. These were captured once when the view was constructed, so the app kept
    // showing the balance as it stood at launch — top up, watch the popup credit it, come back,
    // and the app was still displaying the old figure. The extension writes the fresh value into
    // the shared container whenever the popup sees it; the app has to actually re-read it.
    @State private var userId: String? = SharedTopUpStore.userId
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
    private let ticker = Timer.publish(every: pollInterval, on: .main, in: .common).autoconnect()

    private var signedIn: Bool { userId?.isEmpty == false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header

                // The top-up card appears only when a purchase could actually be credited.
                // Without a user id from the shared container there is no account to attach
                // `appAccountToken` to and the backend has nobody to credit, so showing an
                // amount field would be an invitation to pay into a void. In that case the
                // Safari instructions are the whole screen — getting the user signed in via
                // the popup IS the next step, so it is the only thing worth showing.
                if SharedTopUpStore.isAvailable && signedIn {
                    topUpCard
                    Divider()
                } else if !SharedTopUpStore.isAvailable {
                    misconfiguredNotice
                    Divider()
                } else {
                    Text("Sign in from the DisinfaX popup in Safari to add funds.")
                        .font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                instructions
            }
            .padding(24)
            .tint(Self.accent)
            // A fixed content width rather than a flexible one: the window is now sized from this
            // view's ideal size, so letting it stretch would make the window's width arbitrary.
            .frame(width: 392, alignment: .leading)
        }
        .onAppear {
            amountText = String(amount)
            refreshFromStore()
        }
        .onReceive(NotificationCenter.default.publisher(for: Self.didBecomeActive)) { _ in
            refreshFromStore()
        }
        .onReceive(ticker) { _ in
            refreshFromStore()
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("DisinfaX").font(.system(size: 26, weight: .bold))
            Text("Add funds to your balance")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    // MARK: - Top-up card

    private var topUpCard: some View {
        VStack(alignment: .leading, spacing: 18) {

            // Balance → future balance. The arrow makes the outcome of the purchase explicit
            // before the payment sheet appears, which is the whole point of confirming here.
            // While a purchase is unconfirmed the balance shown here is knowably out of date, and
            // "after top-up" would be arithmetic on a stale figure. Saying so is more use than
            // displaying two numbers that are both wrong.
            if let pendingCredit {
                awaitingBalanceNotice(amount: pendingCredit)
            } else {
                HStack(alignment: .center, spacing: 12) {
                    balanceBlock(label: "BALANCE", value: balance, accented: false)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.tertiary)
                    balanceBlock(label: "AFTER TOP-UP",
                                 value: balance.map { $0 + Double(amount) },
                                 accented: true)
                }
                .frame(maxWidth: .infinity)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("TOP-UP AMOUNT")
                    .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                    .foregroundStyle(.secondary)
                HStack(spacing: 6) {
                    // "US$", never "$". Every amount here is a USD tier, but Apple charges in the
                    // buyer's own storefront currency — the $3 tier bills CAD 4.00 in Canada. A bare
                    // "$" in front of a Canadian or Australian customer states a price that is not
                    // what they will be charged.
                    Text("US$").font(.system(size: 17, weight: .medium)).foregroundStyle(.secondary)
                    TextField("", text: $amountText)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 17, weight: .medium)).monospacedDigit()
                        .frame(width: 78)
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
                    if isPurchasing { ProgressView().controlSize(.small) }
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

    /// The same fine print the popup shows under its own Top Up button, and for the same reason:
    /// this is now a place a purchase is initiated, so the terms have to be in front of the user
    /// here too, not only in the surface they may have come from.
    ///
    /// Matches the popup's Safari build, which shows the agreement line and the FX note but not
    /// the jurisdiction list. Written as Markdown so the two links are tappable without building
    /// an AttributedString by hand; they open in the default browser.
    private var disclaimer: some View {
        Text("By topping up, you agree to our [Terms of Service](https://disinfax.app/terms-of-use) and [Privacy Policy](https://disinfax.app/privacy-policy). Foreign exchange fees may apply if you pay in a currency other than USD.")
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
    }

    private func balanceBlock(label: LocalizedStringKey, value: Double?, accented: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            // "—" when the popup has never reported a balance. Showing 0 would read as a real
            // balance of zero, which is a different and alarming thing.
            Text(value.map { String(format: "US$%.2f", $0) } ?? "—")
                .font(.system(size: 22, weight: .semibold)).monospacedDigit()
                .foregroundStyle(accented ? Self.accent : Color.primary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Shown in place of the balance while a purchase is being applied.
    ///
    /// The app cannot see the credit itself: it has no session, and reads the figure the Safari
    /// extension mirrors into the shared container. On iOS that mirror is frozen while this app is
    /// in the foreground, because iOS suspends Safari and its extension the moment they are
    /// backgrounded — so on iOS this really does wait for the user to go back.
    private func awaitingBalanceNotice(amount: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("BALANCE")
                .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            Text("Open the popup in Safari to view your updated balance")
                .font(.system(size: 15, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)
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
        SharedTopUpStore.reloadFromDisk()
        let latestUserId = SharedTopUpStore.userId
        let latestBalance = SharedTopUpStore.balance

        if latestBalance != balance {
            // The balance moved, so the purchase has landed: drop the notice, unblock the button and
            // clear the success message rather than leaving any of them over a figure that is now
            // correct. Keyed on the balance changing at all, not on it matching the expected total,
            // because a concurrent spend would make an exact comparison never come true.
            pendingCredit = nil
            pendingTicks = 0
            if !messageIsError, message != nil { message = nil }
        } else if pendingCredit != nil {
            pendingTicks += 1
        }
        userId = latestUserId
        balance = latestBalance
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
            VStack(alignment: .leading, spacing: 4) {
                title.font(.headline)
                body.font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Always-visible Safari instructions

    private var instructions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("USING DISINFAX IN SAFARI")
                .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
                .padding(.bottom, 2)
            step(1, "Open Safari and go to x.com.")
#if os(macOS)
            step(2, "Enable DisinfaX in Safari Settings → Extensions.")
            step(3, "Click the DisinfaX icon in the Safari toolbar to open the popup.")
            Button("Open Safari Extension Settings…") { openSafariSettings() }
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
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(n).").font(.callout).bold().foregroundStyle(.secondary).frame(width: 18, alignment: .trailing)
            text.font(.callout).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View { step(n, Text(text)) }

    private func openSafariSettings() {
#if os(macOS)
        SafariSettingsOpener.open()
#endif
    }

    // MARK: - Purchase

    private func purchase() async {
        guard let userId, !userId.isEmpty else { return }
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

            // Recorded before anything else can fail. The extension credits the balance and only
            // then finishes the transaction, so an interruption here leaves a recoverable record
            // rather than a charge with nothing to show for it.
            SharedTopUpStore.appendPendingTransaction(jws: outcome.jws,
                                                      transactionId: outcome.transactionId,
                                                      amount: outcome.amount)

            // Every branch names the amount Apple actually returned, never the one in the field.
            // StoreKit hands back an existing UNFINISHED transaction rather than charging again for
            // the same product, and a transaction stays unfinished until the popup applies it — so
            // pressing Top Up twice for the same amount before opening the popup returns the first
            // purchase in about 30ms with no payment sheet. Nothing was bought the second time, and
            // reporting "Payment complete" there reads as a second charge that never happened.
            if wasAlreadyRecorded {
                message = String(localized: "You already have a US$\(outcome.amount) top-up waiting to be applied — you have not been charged again. Return to Safari and open the DisinfaX popup to apply it to your balance.")
            } else if outcome.amount > 0 && outcome.amount != value {
                message = String(localized: "An earlier US$\(outcome.amount) purchase was still waiting to be applied, so that one was completed instead of charging you again. Return to Safari and open the DisinfaX popup to see your updated balance.")
            } else {
                message = String(localized: "Payment complete. Return to Safari and open the DisinfaX popup to see your updated balance.")
            }
            messageIsError = false
            pendingCredit = outcome.amount
            pendingTicks = 0
        } catch {
            message = error.localizedDescription
            messageIsError = true
        }
    }
}
