import SwiftUI
import Combine
import Foundation

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The field's text system font, so the editor can be measured in the font it is drawn in.
/// `Font.body` is this font: SwiftUI's text styles are the platform's own, and a
/// `boundingRect` answer is only worth having if both sides agree on it.
#if os(macOS)
typealias PlatformFont = NSFont
#else
typealias PlatformFont = UIFont
#endif

/// The app's fact-checking surface: the popup's Fact-Check tab, natively.
///
/// Same protocol, same workers, same hashes as the extension — see `FactCheckClient` for why the
/// hashes in particular have to match. What it does not reproduce is the parts of the popup that
/// live in Supabase rather than in the workers: Realtime updates arriving while a claim is being
/// researched, and the on-demand translation buttons. Those read and write through Postgres
/// directly, and reaching them from here would mean porting a database client.
///
/// Annotations are here, by a different road. The popup is told about them over a subscription;
/// this app has no socket to be told on, so it reads the row instead — once for the text it is
/// checking, and once more behind an Annotate tap when a claim has no id yet. Research carries the
/// annotation locators, so the worker annotates a freshly researched claim inside the same run
/// the user paid for, and the follow-up tap finds those ranges stored and is served them without
/// a model call. What that costs is the app's own read of the row, which is metered — see
/// `cachedRows` — so it is spent once per check and never in a loop.
@available(macOS 13.0, iOS 16.0, *)
struct FactCheckView: View {

    /// Tailwind `emerald-600`, the popup's Top Up colour — the same one `TopUpView` uses. Kept as
    /// its own literal rather than shared, because sharing one colour would mean one of the two
    /// surfaces owning a constant the other depends on.
    private static let accent = Color(red: 5 / 255, green: 150 / 255, blue: 105 / 255)

    /// Observed, not owned. `ViewController` holds it, because the top-up hand-off re-hosts this
    /// whole hierarchy and a `@StateObject` would go down with it — taking a fact-check that has
    /// already been paid for along with the text behind it. The state belongs to the surface the
    /// user returns to, not to the view instance that happened to be on screen.
    @ObservedObject var model: FactCheckModel

    /// Whether to draw the `DisinfaX` / `Fact-Check` name above everything else. True everywhere
    /// in the app, where this view is the whole of what is on screen and has to say what it is.
    /// False in the share sheet, which is presented under a bar that already carries the name —
    /// and which is the reason this is a flag on the name rather than a second view: the rest of
    /// the surface is the same one the app's tab draws, down to the controls that bill.
    var showsHeader = true

    /// Re-read rather than captured: the extension rewrites this every time its popup opens, and
    /// that is exactly the action the signed-out state asks the user to take.
    @State private var session: SharedTopUpStore.Session?

    /// The editor's own width, which is the width its height is measured at. Read from the
    /// layout rather than assumed: the app's window is one width on macOS and an iOS sheet is
    /// whatever the device is, and a field measured at the wrong width wraps at the wrong place
    /// and grows by a line that is not there. Zero until the first pass.
    @State private var editorTextWidth: CGFloat = 0

    /// Coming back from Safari is precisely when the shared container has new values in it, and
    /// activation is the one event that reliably marks it. The poll covers the rest: the popup can
    /// be closed long before the token lands, by which time this view has been on screen a while.
    private static let didBecomeActive: Notification.Name = {
#if os(macOS)
        NSApplication.didBecomeActiveNotification
#else
        UIApplication.didBecomeActiveNotification
#endif
    }()
    private static let pollInterval: TimeInterval = 2
    private let ticker = Timer.publish(every: pollInterval, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if showsHeader {
                    header
                }
                if session == nil {
                    signedOutNotice
                } else {
                    inputCard
                    if !model.claims.isEmpty {
                        claimsSection
                    }
                }
            }
            .padding(24)
            .tint(Self.accent)
            // Up to, not exactly: the app hosts this in a pane wider than 392 and is unchanged,
            // but a share sheet on a narrow iPhone is narrower than 392 and would otherwise clip.
            .frame(maxWidth: 392, alignment: .leading)
        }
        .onAppear { refreshSession() }
        .onReceive(NotificationCenter.default.publisher(for: Self.didBecomeActive)) { _ in refreshSession() }
        .onReceive(ticker) { _ in refreshSession() }
    }

    // MARK: - Header

    /// Drawn everywhere except the share sheet. See `showsHeader`.
    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("DisinfaX").font(.system(size: 26, weight: .bold))
            Text("Fact-Check").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    // MARK: - States where there is nothing to check with

    /// Deliberately the same sentence `TopUpView` uses for its dead-identity case: it is already
    /// in the catalog, and the remedy is identical — the popup is what refreshes the hand-over.
    /// The app genuinely cannot tell "never signed in" from "the token expired", since both are
    /// just an unusable container, and "open the popup" is the right move for either.
    private var signedOutNotice: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.crop.circle.badge.exclamationmark")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("Your session needs refreshing — open the DisinfaX popup in Safari, then try again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: - Input

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.hasChecked {
                analyzedText
            } else {
                editor
            }

            HStack(spacing: 10) {
                if model.hasChecked {
                    Button {
                        model.startOver()
                    } label: {
                        Label("Edit", systemImage: "pencil").labelStyle(.iconOnly)
                    }
                    .buttonStyle(.bordered)
                    .help(Text("Edit"))

                    // Run again, on the same text: the check that is on screen is one the backend
                    // may have moved past, and this is the popup's Disinfact button one state
                    // further along. It re-runs preclassification rather than answering out of
                    // the rows already on screen — a refresh that read the cache back would come
                    // back with nothing to show. It does read those rows afterwards, to put back
                    // the verdicts and ids the re-run does not return.
                    Button {
                        model.disinfact()
                    } label: {
                        Label("Disinfact", systemImage: "arrow.clockwise").labelStyle(.iconOnly)
                    }
                    .buttonStyle(.bordered)
                    .help(Text("Disinfact"))
                    // Dimmed while anything is in flight, a lone claim's research included: a
                    // re-run taken now would cancel that run — already paid for — and buy the
                    // same classification again when the row it left behind reads unanswered.
                    // See `disinfact`.
                    //
                    // And dimmed when there is no usable session, with the rest of the controls
                    // that bill: this is the one that would cancel the check on screen on its way
                    // to a request it cannot authenticate. See `canSpend`.
                    .disabled(model.isBusy || !model.canSpend)

                    // Preclassifying is a state the editor branch can never show: the moment a
                    // check starts, the text is already read-only. So the progress belongs here,
                    // where the user is actually looking.
                    if model.isPreclassifying {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Fact-Checking").foregroundStyle(.secondary)
                        }
                    } else if model.claims.count > 1, model.hasUnrunClaims {
                        Button {
                            model.researchAll()
                        } label: {
                            Text("Fact-Check All").fontWeight(.semibold)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!model.canSpend)
                    }
                } else {
                    Button {
                        model.disinfact()
                    } label: {
                        Text("Disinfact")
                            .fontWeight(.semibold)
                            .padding(.vertical, 4)
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        model.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !model.canSpend
                    )

                    // The charge is disclosed before it happens, not after: this button spends the
                    // user's balance, and the popup says so too.
                    Text(FactCheckModel.clickWarning(button: String(localized: "Disinfact")))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Before anything is attempted, not only after a run has been refused. The token is in
            // the container and its expiry is readable, and a token the workers have already turned
            // down is remembered — so "this cannot be spent" is knowable the moment the tab opens,
            // which is when the user would otherwise have had to find it out by clicking. The same
            // sentence a refused run prints, read off the error rather than written out again.
            //
            // Above `message` rather than instead of it: this is the standing condition, and that
            // one is whatever the last attempt had to say. In the case this exists for there is
            // only ever the first, because the controls are already down when the user looks.
            if !model.canSpend {
                Text(FactCheckError.sessionUnavailable.localizedDescription)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let message = model.message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text("DisinfaX can make mistakes. Double-check information.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary, lineWidth: 1))
    }

    private var editor: some View {
        TextEditor(text: $model.inputText)
            .font(.body)
            .scrollContentBackground(.hidden)
            // Return runs the check, Shift+Return breaks the line — see `SubmitOnReturn`.
            .modifier(Self.SubmitOnReturn { model.disinfact() })
            // One line when empty, one more for every line the text wraps to, and scrolling once
            // it has `editorMaxLines` of them — see `editorHeight`.
            .frame(height: editorHeight)
            .background(editorWidthReader)
            // Room for the clear control, taken out of the text area rather than laid over it, so
            // the last word of a line can never end up underneath the ×. The popup reserves the
            // same gap the same way, as right padding on its textarea.
            .padding(.trailing, 26)
            // Both are overlays of the TextEditor itself, before the 6pt padding below, so each is
            // positioned from the text area's own top-leading corner rather than from the rounded
            // rectangle's. That is the whole alignment fix: the old placeholder was placed from the
            // rectangle and from hand-tuned numbers, so it sat a few points right of the caret and
            // most of a line below it.
            .overlay(alignment: .topLeading) { placeholder }
            .overlay(alignment: .topTrailing) { clearButton }
            .padding(6)
            .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary, lineWidth: 1))
    }

    /// How tall the editor is, from the text it holds.
    ///
    /// `TextEditor` cannot be left to size itself: it is a text view in a scroll view, so given a
    /// range it takes all of it, and given nothing it takes its whole content — which, for a
    /// passage pasted into a claim, is a field taller than the window, scrolled to its own middle.
    /// So the height is worked out and handed over as a fact.
    ///
    /// Measured through the text system rather than observed through SwiftUI. The same string, in
    /// the same font, at the same width, laid out with `boundingRect`, is the height the editor
    /// lays it out to — and it answers synchronously, on the keystroke that changed the text. A
    /// mirror view behind the editor would say the same thing a render later through a preference
    /// and a state write, measured at whatever width SwiftUI had reached by then.
    private var editorHeight: CGFloat {
        let oneLine = Self.editorTextHeight(of: "A", width: editorWrappingWidth)
        guard editorTextWidth > 0 else { return oneLine + Self.editorHeightSlack }
        let text = Self.editorTextHeight(of: model.inputText, width: editorWrappingWidth)
        let lines = min(max(text, oneLine), oneLine * CGFloat(Self.editorMaxLines))
        return lines + Self.editorHeightSlack
    }

    /// The width the editor lays its text out at: its own, less the text system's line fragment
    /// padding, which it keeps on both sides — `editorTextInset` is one side of it.
    private var editorWrappingWidth: CGFloat {
        max(editorTextWidth - Self.editorTextInset * 2, 40)
    }

    /// The editor's own width, for the measurement above to wrap at. In a background, so it cannot
    /// take space from what it measures.
    private var editorWidthReader: some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { editorTextWidth = proxy.size.width }
                .onChange(of: proxy.size.width) { editorTextWidth = $0 }
        }
    }

    /// The height `text` occupies at `width`, paragraph by paragraph.
    ///
    /// Per paragraph rather than in one measurement of the whole string, because a paragraph
    /// ending in a newline has a last line the editor shows and a single measurement does not
    /// count: the caret sits on it, and Shift+Return is how the user gets there.
    private static func editorTextHeight(of text: String, width: CGFloat) -> CGFloat {
        text.components(separatedBy: "\n").reduce(0) { height, paragraph in
            let line = NSAttributedString(
                string: paragraph.isEmpty ? " " : paragraph,
                attributes: [.font: PlatformFont.preferredFont(forTextStyle: .body)]
            )
            // `context:` is spelled out even though it is always nil — UIKit has no default for
            // it, so the shorter call compiles on macOS and not on iOS.
            let rect = line.boundingRect(
                with: CGSize(width: width, height: .greatestFiniteMagnitude),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                context: nil
            )
            return height + ceil(rect.height)
        }
    }

    /// How many lines the editor grows to before it stops growing and scrolls instead. A claim is
    /// regularly a pasted passage, so the ceiling is generous; a field that kept growing would push
    /// the claims — the thing the user came for — off the bottom of the window.
    private static let editorMaxLines = 8

    /// The points of the editor's height that are not text. The text system's insets are
    /// horizontal (see `editorTextInset`), so a field given exactly its text's height has nothing
    /// between the first line's descenders and the border: enough to look clipped, not enough for
    /// a second line to fit, whichever way it rounds.
    private static let editorHeightSlack: CGFloat = 2

    /// `TextEditor` has no placeholder of its own before macOS 14 / iOS 17 and this app starts at
    /// 13/16, so it is drawn here — in the field, in the field's font, at the field's own origin.
    ///
    /// Drawn with no vertical offset at all, because the overlay already begins on the first line:
    /// the corner it is pinned to IS the top of the first line box, so the only thing between it
    /// and where a typed character would appear is the text system's own leading inset. Faded out
    /// rather than removed when there is text, so nothing reflows on the first keystroke.
    private var placeholder: some View {
        Text("Enter a claim")
            .font(.body)
            .foregroundStyle(.secondary)
            .padding(.leading, Self.editorTextInset)
            .allowsHitTesting(false)
            .opacity(model.inputText.isEmpty ? 1 : 0)
    }

    /// Leading inset of the first glyph inside a `TextEditor`: the text system's own line fragment
    /// padding, which SwiftUI leaves at its default and which is the same 5 points on
    /// `NSTextView` and `UITextView` alike. Measured, not guessed — the field was screenshotted
    /// empty and again with this placeholder's exact text typed into it, and the two agreed to the
    /// pixel at this value. Nothing else separates the corner from the first glyph, which is why
    /// there is no vertical counterpart to it.
    private static let editorTextInset: CGFloat = 5

    /// Return runs the check; Shift+Return breaks the line. This is the popup's rule for its own
    /// textarea (`FactCheckTab`'s `onKeyDown`: Enter without Shift calls `handleDisinfact`), and
    /// the reason it needs an exception there applies here too — a claim is regularly a pasted
    /// passage, and a field four lines tall has to be able to hold one.
    ///
    /// A local event monitor rather than a key modifier, because the key to intercept is the one
    /// the focused text view is already handling: SwiftUI's `onKeyPress` needs macOS 14, and below
    /// that the text system has consumed Return long before SwiftUI sees it.
    ///
    /// Filtering on the first responder is what keeps this to the editor. The monitor is
    /// app-wide for as long as the view is on screen, and the top-up amount's field editor is an
    /// `NSTextView` too — its delegate is the `NSTextField` it belongs to, which is the one thing
    /// that tells the two apart. Anything that is not this editor is returned untouched.
    private struct SubmitOnReturn: ViewModifier {
        let action: () -> Void
#if os(macOS)
        @State private var monitor: Any?
#endif

        func body(content: Content) -> some View {
#if os(macOS)
            content
                .onAppear {
                    // Re-hosted hierarchies re-appear without disappearing first (the top-up
                    // hand-off), so an old monitor is dropped before a new one is added.
                    if let monitor { NSEvent.removeMonitor(monitor) }
                    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                        // 36 is Return and 76 the keypad's — both are `Enter` to the popup's
                        // `e.key === 'Enter'`, so both behave the same way here.
                        guard event.keyCode == 36 || event.keyCode == 76 else { return event }
                        guard !event.modifierFlags.contains(.shift) else { return event }
                        guard let textView = NSApp.keyWindow?.firstResponder as? NSTextView,
                              !(textView.delegate is NSTextField) else { return event }
                        // Mid-composition Return belongs to the input method: it is what accepts
                        // a marked candidate. Swallowing it would run the check against half a
                        // word — and the marked text is still in the field when it did.
                        guard !textView.hasMarkedText() else { return event }
                        action()
                        return nil
                    }
                }
                .onDisappear {
                    if let monitor { NSEvent.removeMonitor(monitor) }
                    monitor = nil
                }
#else
            content
#endif
        }
    }

    /// The popup's clear control (`handleClearAll`): empty the field and everything derived from
    /// it. Inside the field, centred on the first line, and kept in the layout while there is
    /// nothing to clear — only faded out and inert — so the control cannot come and go under the
    /// caret as the user types.
    private var clearButton: some View {
        Button {
            model.clearAll()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 14, height: 14)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(4)
        .contentShape(Rectangle())
        .help(Text("Clear"))
        .disabled(model.inputText.isEmpty)
        .opacity(model.inputText.isEmpty ? 0 : 1)
        .offset(y: -Self.clearControlLift)
    }

    /// Half the difference between the clear control's box — a 14pt glyph plus its 4pt padding on
    /// each side — and one line of `.body`. The overlay is pinned to the top of the text container
    /// and a line is shorter than that box, so without this the glyph hangs half the difference
    /// below the first line's centre. Measured against the line's own ink rather than estimated.
    private static let clearControlLift: CGFloat = 3

    /// The text as it was sent, with each claim marked and the claims' corrections painted on it,
    /// shown once there is something to mark.
    ///
    /// Read-only from here on, which is what makes the marks mean anything: the ranges are offsets
    /// into the exact string that was hashed, so editing it afterwards would leave them pointing
    /// at text that no longer matches. Editing is one button away, and it starts the check over.
    ///
    /// The corrections are here as well as on the claims' own cards because this is the text a
    /// reader is reading: a correction that only exists inside a card has to be found there first.
    /// The offsets the annotations are stored under are absolute into the whole input, which is
    /// what this is, so nothing is subtracted — a claim's card subtracts its own start instead.
    /// (The popup's top block is the same painting, over `combinedAnnotations` at `segStart` 0.)
    private var analyzedText: some View {
        let text = model.inputText
        let length = text.utf16.count
        var shading: [(start: Int, end: Int)] = []
        var ranges: [(start: Int, end: Int, correction: String)] = []
        for claim in model.claims {
            if let range = claim.range { shading.append((range.start, range.end)) }
            ranges.append(contentsOf: FactCheckClient.annotationRanges(
                claim.annotations,
                textLength: length,
                segStart: 0
            ))
        }
        // A correction is written a little past the line it annotates — the web renderers' `1.08em`
        // — and the line here is `.body`, which is not the same size on the two platforms.
#if os(macOS)
        let correctionSize: CGFloat = 13 * 1.08
#else
        let correctionSize: CGFloat = 17 * 1.08
#endif
        return Text(AnnotatedClaimText.painted(
            text,
            ranges: ranges,
            shading: (intervals: shading, color: Self.accent.opacity(0.22)),
            correctionSize: correctionSize
        ))
        .font(.body)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Claims

    private var claimsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(model.claims) { claim in
                FactCheckClaimCard(
                    claim: claim,
                    accent: Self.accent,
                    tabIsBusy: model.isBusy,
                    canSpend: model.canSpend,
                    onResearch: { model.research(claim.id) },
                    onAnnotate: { model.annotate(claim.id) }
                )
            }
        }
        // The session gate is on the cards' own controls rather than on this section, which is
        // where it used to be and where it took the rest of the card down with it. It is only the
        // controls that bill that have to come down when a spend cannot be authenticated; a
        // verdict's reasoning, its sources and the percentages behind its badge were all being
        // made unreachable — not merely unspendable — by a stale token. See `canSpend`.
    }

    private func refreshSession() {
        SharedTopUpStore.reloadFromDisk()
        session = SharedTopUpStore.session
        // The poll this view already runs, for the same reason: the session it watches expires on
        // its own, and the controls that bill have to come down when it does rather than at the
        // next click. See `canSpend`.
        model.refreshSpendability()
    }
}

// MARK: - One claim

@available(macOS 13.0, iOS 16.0, *)
private struct FactCheckClaimCard: View {
    let claim: FactCheckClaim
    let accent: Color

    /// Whether any pass on the tab is in flight, this claim's own included.
    ///
    /// While one is, nothing here may be clicked. A preclassification streams its claims in as the
    /// worker finds them, so a card appears and settles long before the run behind it has finished
    /// — and a research started off that card is not merely early, it is answered against a claim
    /// whose row the preclassifier may still be writing, while the run it interrupts goes on being
    /// billed behind it. Fact-Check All is the exception and is not in these cards: it is the
    /// control that runs whatever is left, and a claim it is waiting on is one it can absorb.
    let tabIsBusy: Bool

    /// Whether a spend has any chance of being authenticated: the model's own `canSpend`, read by
    /// the two controls here that bill and by nothing else in the card.
    let canSpend: Bool

    let onResearch: () -> Void
    let onAnnotate: () -> Void

    /// True while one of this claim's own runs is in flight: its button then says what is
    /// happening rather than offering to start it, which is the state the popup's single busy
    /// flag covers while it works on one claim at a time.
    private var isOperating: Bool { claim.isResearching || claim.isAnnotating }

    /// A claim that has been researched already: running it again is a re-run, and says so with
    /// the refresh icon the on-page buttons use for the same thing.
    private var isReclassification: Bool { claim.isClassified || claim.needsReclassify }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // The claim as the worker rewrote it — what was researched, and what the verdict is
            // about — with the copy button beside it the popup puts there.
            HStack(alignment: .top, spacing: 8) {
                Text(claim.rewritten)
                    .font(.callout).fontWeight(.medium)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                CopyButton(text: claim.rewritten)
            }

            // The input's own words for the claim, with the corrections painted on them.
            VStack(alignment: .leading, spacing: 4) {
                AnnotatedClaimText(
                    text: claim.rawText,
                    annotations: claim.annotations,
                    segStart: claim.range?.start ?? 0
                )
                if claim.awaitingAnnotations, claim.isClassified {
                    Text("Annotating").font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.18), in: RoundedRectangle(cornerRadius: 8))

            action

            // The verdict lands with the first streamed event, so the badge is on screen rising
            // while the reasoning is still being written — which is the movement worth seeing, and
            // the reason this is not hidden behind the end of the run.
            if claim.isClassified || (claim.needsReclassify && isOperating) {
                results
            }

            if let message = claim.errorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary, lineWidth: 1))
    }

    /// Annotate is for a claim that has been researched and has no annotations yet — the same gate
    /// the on-page badges use. Before research there is nothing to annotate and the worker skips
    /// such a run anyway. Not while Flow A's own annotation of this claim is in flight, though:
    /// that button would buy the run already on its way, and the card says so in the text box
    /// instead.
    ///
    /// It sits BESIDE the re-run, never in place of it. The two used to be either/or, which meant
    /// that a researched claim with no annotations yet — the one state Annotate appears in — had
    /// no way to be researched again, and the re-run is the paid request a user is most likely to
    /// want on a claim whose verdict they doubt. Nothing on the page has that hole: a claim's
    /// refresh control belongs to its popover and is there whatever its annotation state is.
    @ViewBuilder
    private var action: some View {
        HStack(spacing: 8) {
            if claim.missingAnnotations, claim.isClassified, !claim.awaitingAnnotations {
                Button(action: onAnnotate) {
                    Text(claim.isAnnotating ? String(localized: "Annotating") : String(localized: "Annotate"))
                        .font(.system(size: 12, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 2)
                }
                .buttonStyle(.bordered)
                .disabled(isOperating || tabIsBusy || !canSpend)
            }

            Button(action: onResearch) {
                HStack(spacing: 6) {
                    // This claim's own run, not `isOperating`: while the annotation pass is what
                    // is in flight the re-run is disabled but has nothing to report, and saying
                    // "Fact-Checking" for it would name the wrong pass.
                    if claim.isResearching {
                        Text("Fact-Checking")
                    } else {
                        if isReclassification {
                            Image(systemName: "arrow.clockwise").font(.system(size: 11))
                        }
                        Text("Fact-Check")
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)
            }
            .buttonStyle(.bordered)
            .disabled(isOperating || tabIsBusy || !canSpend)
        }
    }

    @ViewBuilder
    private var results: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let verdict = claim.verdict {
                VerdictBadgeView(confidence: verdict.confidence, veracity: verdict.veracity)

                if !verdict.reasoning.isEmpty {
                    labelled("Reasoning") {
                        HStack(alignment: .top, spacing: 8) {
                            Text(verdict.reasoning)
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                            CopyButton(text: verdict.reasoning)
                        }
                    }
                }
                if !verdict.sources.isEmpty {
                    labelled("Sources") { sourceList(verdict.sources) }
                }
            }
        }
        .padding(.top, 10)
        .overlay(alignment: .top) { Divider() }
    }

    private func labelled<Content: View>(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 10, weight: .semibold)).tracking(0.6)
                .foregroundStyle(.secondary)
            content()
        }
    }

    /// One row per source, each with its favicon in front of its title — the popup's `SourceLink`,
    /// with the same icon chain and the same letter standing in for it when nothing loads.
    ///
    /// This used to be a single markdown blob rendered as one `Text`. It was a run of links with
    /// nothing to tell one source from another, which is what a source list is for: the icon is
    /// what a reader recognises before reading a word of the title.
    @ViewBuilder
    private func sourceList(_ sources: [FactCheckSource]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(sources) { source in
                let title = source.title?.isEmpty == false ? source.title! : (source.url ?? "")
                if let url = source.url, let destination = URL(string: url), !title.isEmpty {
                    Link(destination: destination) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            SourceFavicon(domain: Self.domain(of: url))
                                // On the first line's baseline rather than its bottom: the icon is
                                // 16pt against an 11pt caption, and a bottom-aligned one sits half
                                // a line low next to the words it belongs to.
                                .alignmentGuide(.firstTextBaseline) { $0.height - 2 }
                            Text(title)
                                .font(.caption)
                                .underline()
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .buttonStyle(.plain)
                    .tint(accent)
                } else if !title.isEmpty {
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    /// The host, minus a leading `www.`, for the letter that stands in for a missing icon.
    /// `SourceLink`'s own `domainFromUrl`, including its fallback to the raw string — a malformed
    /// url still gets a letter rather than an empty box.
    private static func domain(of url: String) -> String {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// A source's favicon, with the first letter of its domain showing underneath as the one state
/// that always renders — the popup's `SourceLink`, including the order of what it tries: the
/// site's own /favicon.ico first, then Google's and DuckDuckGo's favicon services, which exist
/// because a great many sites serve no icon at any guessable path.
@available(macOS 13.0, iOS 16.0, *)
private struct SourceFavicon: View {

    let domain: String

    private static let side: CGFloat = 16

    /// Which icon source is being tried. Advanced on a failure, and past the end of the chain
    /// there is nothing left to ask for: the letter is showing and nothing replaces it.
    @State private var index = 0

    private static func sources(for domain: String) -> [URL] {
        let escaped = domain.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? domain
        return [
            URL(string: "https://\(domain)/favicon.ico"),
            URL(string: "https://www.google.com/s2/favicons?domain=\(escaped)&sz=32"),
            URL(string: "https://icons.duckduckgo.com/ip3/\(escaped).ico"),
        ].compactMap { $0 }
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 3).fill(.quaternary)
            Text(String((domain.first ?? "?").uppercased()))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
            // Whichever of the three is current. `dropFirst` rather than an index check, so that
            // running off the end is the same expression as a source that answered.
            if let url = Self.sources(for: domain).dropFirst(index).first {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                    case .failure:
                        // Nothing at this address — the next service is the answer, and the way to
                        // ask for it is to move the index. There is nothing to draw either way.
                        Color.clear.onAppear { index += 1 }
                    case .empty:
                        Color.clear
                    @unknown default:
                        Color.clear
                    }
                }
            }
        }
        .frame(width: Self.side, height: Self.side)
        .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}

// MARK: - Annotated text

/// Text with its corrections painted on it: each annotated span struck through, and the correction
/// that replaces it written in red beside it. Used twice — over a claim's own text on its card, and
/// over the whole input at the top of the tab, whose claims are shaded as well.
///
/// Port of the popup's `AnnotatedText`, run by run. The spans are built by concatenating the
/// pieces rather than by attributing ranges in place, because a correction is inserted text:
/// inserting into an attributed string moves every index after it, and the next range would then
/// describe characters that had shifted out from under it.
///
/// What is not reproduced is the popup's single-word treatment: its strike is drawn as a two-pixel
/// diagonal, which is an absolutely-positioned element over the word and has no equivalent inside
/// a run of text here. A single strikethrough stands in for both cases — the same strike the
/// popup itself uses for every multi-word span.
@available(macOS 13.0, iOS 16.0, *)
private struct AnnotatedClaimText: View {
    let text: String
    let annotations: [String: [String: String]]
    let segStart: Int

    private static let strikeRed = Color(red: 255 / 255, green: 60 / 255, blue: 60 / 255)
    private static let correctionRed = Color(red: 255 / 255, green: 75 / 255, blue: 75 / 255)

    var body: some View {
        let ranges = FactCheckClient.annotationRanges(
            annotations,
            textLength: text.utf16.count,
            segStart: segStart
        )
        Text(Self.painted(text, ranges: ranges))
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    /// The text with `ranges` painted on it, and `shading` — a claim's own span in the whole input
    /// — laid underneath where it is asked for.
    ///
    /// One painter for both surfaces rather than two: what the two disagree about is which ranges
    /// they pass and whether anything is shaded, and keeping that in the arguments is what stops
    /// the copies drifting apart. (The popup reads the same way: one `AnnotatedText`, told which
    /// offsets its text starts at.)
    static func painted(
        _ text: String,
        ranges: [(start: Int, end: Int, correction: String)],
        shading: (intervals: [(start: Int, end: Int)], color: Color)? = nil,
        correctionSize: CGFloat = 13
    ) -> AttributedString {
        var output = AttributedString()
        let units = Array(text.utf16)
        var cursor = 0

        /// Whether this UTF-16 offset is a boundary the text can be cut at. An offset inside a
        /// character — the middle of an emoji, say — is not: `String.Index(utf16Offset:)` traps on
        /// one, and decoding across it would replace the character with a replacement character.
        /// A range that has no boundary for one of its ends costs its own marking, nothing else.
        func splittable(_ offset: Int) -> Bool {
            guard offset >= 0, offset <= units.count else { return false }
            let utf16 = text.utf16
            guard let index = utf16.index(utf16.startIndex, offsetBy: offset, limitedBy: utf16.endIndex),
                  String.Index(index, within: text) != nil else { return false }
            return true
        }

        func emit(_ from: Int, _ to: Int, struck: Bool) {
            guard to > from, splittable(from), splittable(to) else { return }

            // The unmarked text between two annotated spans still has to carry the shading of the
            // claim it sits inside, so a run is cut at the shade's edges rather than painted whole.
            var edges: Set<Int> = [from, to]
            for interval in shading?.intervals ?? [] where interval.end > from && interval.start < to {
                edges.insert(max(from, interval.start))
                edges.insert(min(to, interval.end))
            }
            let ordered = edges.filter(splittable).sorted()

            for (start, end) in zip(ordered, ordered.dropFirst()) where end > start {
                let slice = String(decoding: units[start..<end], as: UTF16.self)
                guard !slice.isEmpty else { continue }
                var piece = AttributedString(slice)
                if struck {
                    piece.strikethroughStyle = Text.LineStyle(pattern: .solid, color: Self.strikeRed)
                }
                if let shading,
                   shading.intervals.contains(where: { $0.start <= start && $0.end >= end }) {
                    piece.backgroundColor = shading.color
                }
                output.append(piece)
            }
        }

        for range in ranges.sorted(by: { $0.start < $1.start }) {
            // Overlapping spans: the later one keeps only what the earlier one has not painted.
            var start = range.start
            let end = range.end
            if start < cursor {
                if end <= cursor { continue }
                start = cursor
            }
            guard splittable(start), splittable(end) else { continue }

            emit(cursor, start, struck: false)
            let insert = Self.unwrapInsertOnly(range.correction)
            emit(start, end, struck: !insert.insertOnly)
            if !insert.text.isEmpty {
                let shown = insert.text
                // The pair of spaces separates the correction from the words either side of it —
                // but only where they need separating. The struck span leaves the line and the
                // space that followed it does not, so a correction written with an unconditional
                // trailing space lands beside that one and doubles it: "China has" corrected to
                // "India" reads "India  has". (The popup's `AnnotatedText` and the page's paint
                // write the same pair; the guard belongs in all three.)
                let before = Self.isWordCharacter(units, at: end - 1)
                let after = Self.isWordCharacter(units, at: end)
                var piece = AttributedString((before ? " " : "") + shown + (after ? " " : ""))
                piece.foregroundColor = Self.correctionRed
                piece.font = Self.handwriting(size: correctionSize)
                output.append(piece)
            }
            cursor = end
        }
        emit(cursor, units.count, struck: false)
        return output
    }

    /// Whether this UTF-16 unit is something a correction has to be kept apart from. Past the end
    /// of the text there is no such thing.
    private static func isWordCharacter(_ units: [UInt16], at offset: Int) -> Bool {
        guard offset >= 0, offset < units.count else { return false }
        // A unit that is not a scalar by itself is half of a character outside the BMP, which is
        // never whitespace.
        guard let scalar = Unicode.Scalar(units[offset]) else { return true }
        return !CharacterSet.whitespacesAndNewlines.contains(scalar)
    }

    /// `{[inner]}` is an insert-only correction: keep the keyed substring, paint
    /// `inner` after it, no strikethrough. Ordinary values strike. Port of the
    /// page's `unwrapInsertOnlyCorrection`.
    private static func unwrapInsertOnly(_ correction: String) -> (text: String, insertOnly: Bool) {
        if correction.hasPrefix("{["), correction.hasSuffix("]}"), correction.count >= 4 {
            let start = correction.index(correction.startIndex, offsetBy: 2)
            let end = correction.index(correction.endIndex, offsetBy: -2)
            return (String(correction[start..<end]), true)
        }
        return (correction, false)
    }

    /// The extension ships a handwriting face for corrections and the app does not, so the closest
    /// thing the system has is asked for by name and an italic stands in when none of them is
    /// installed — which is what a correction is: a note in the margin, in someone else's hand.
    ///
    /// The size is asked for rather than fixed, because the web renderers write a correction a
    /// little larger than the line it annotates (`1.08em`) and the caller is what knows how large
    /// that line is.
    private static func handwriting(size: CGFloat) -> Font {
#if os(macOS)
        let names = ["Bradley Hand", "Chalkboard SE", "Marker Felt", "Comic Sans MS"]
#else
        let names = ["Chalkboard SE", "Bradley Hand", "Marker Felt", "Comic Sans MS"]
#endif
        for name in names where systemFontExists(name, size: size) {
            return .custom(name, size: size).weight(.bold)
        }
        return .system(size: size, weight: .bold).italic()
    }

    private static func systemFontExists(_ name: String, size: CGFloat) -> Bool {
#if os(macOS)
        return NSFont(name: name, size: size) != nil
#else
        return UIFont(name: name, size: size) != nil
#endif
    }
}

/// Copies a piece of text, and says so for a moment afterwards — the popup's copy button, which
/// is the only way to get a reasoning out of either surface.
@available(macOS 13.0, iOS 16.0, *)
private struct CopyButton: View {
    let text: String

    @State private var copied = false
    @State private var resetTimer: Task<Void, Never>?

    var body: some View {
        Button {
            if copy() {
                copied = true
                resetTimer?.cancel()
                resetTimer = Task {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard !Task.isCancelled else { return }
                    self.copied = false
                }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help(Text("Copy"))
        .onDisappear { resetTimer?.cancel() }
    }

    private func copy() -> Bool {
#if os(macOS)
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
#else
        UIPasteboard.general.string = text
        return true
#endif
    }
}

// MARK: - Verdict badge

/// Port of the popup's `VerdictBadge`, down to how it assembles a label and what a hover does.
///
/// Ported rather than approximated because the two surfaces describe the same model output: a
/// claim reading green in the popup and amber here would be worse than either colour on its own,
/// and a badge that says "Very Likely Mostly True" where the popup says "Likely to be Mostly True"
/// is the same claim described two different ways.
///
/// The adjectives come from the locale the app is running in, and the template that puts them in
/// order — and the separators between them — comes from the extension's own `_locales` files,
/// transformed into positional format strings. That is what lets a locale that orders the pieces
/// differently read correctly here (see `pieces(of:roles:)`).
@available(macOS 13.0, iOS 16.0, *)
private struct VerdictBadgeView: View {
    let confidence: Double?
    let veracity: Double?

    /// Which score a slot carries. The verdict word is not a slot: it is the piece the two slots
    /// hang off, and hovering it stands for the whole badge.
    private enum Slot: Hashable { case conf, ver }

    /// While the pointer is with a badge whose hover widened it, the reveal is held: the widening
    /// slides the badge's own parts out from under the pointer that caused it, and releasing there
    /// would shrink the badge back, re-hover it, and flicker at frame rate. Held until the pointer
    /// leaves the badge, exactly as the popup holds it.
    @State private var heldReveal = false
    /// Whether the verdict word is under the pointer: it stands for the whole badge and reveals
    /// every score, for as long as the pointer stays on it.
    @State private var hoveredVerdict = false
    /// The one slot whose percentage a hover has asked for, when it was not the whole badge.
    @State private var hoveredSlot: Slot?

    /// What a tap asked for, which is the whole badge: every score revealed, the state hovering the
    /// verdict word reaches. A tap on a piece reveals all of them rather than that piece alone,
    /// where the popup's own touch handling can tell which score a finger landed on — a badge is
    /// two numbers wide, and a finger choosing between them is a precision this does not need.
    ///
    /// A phone has no hover at all, so without this the percentages behind the adjectives were
    /// simply unreachable there: the numbers a verdict is *made of* were the one part of it that
    /// could not be read. The browser has no such hole — a hover on a desktop, and the tap's own
    /// sticky `:hover` on a touchscreen — and this is that gesture resolved in a place with no hover
    /// to stick. Additive rather than a replacement: an iPad with a pointer hovers as it did, and a
    /// trackpad and a finger on the same screen each get their own answer.
    @State private var tapped = false

    private static let neutral = Color(red: 180 / 255, green: 180 / 255, blue: 180 / 255)

    @ViewBuilder
    var body: some View {
        if let confidence {
            let pieces = Self.orderedPieces(Self.parts(confidence: confidence, veracity: veracity), confidence: confidence, veracity: veracity)
            // Only an adjective-less slot changes the badge's width, so only its reveal moves
            // anything, and only then is there a hover to hold onto. (VerdictBadge.tsx arms its
            // hold under the same condition.) Hovering an adjective swaps it for its percentage
            // within the slot's own width, which moves nothing.
            let canWiden = pieces.contains { $0.role != .verdict && $0.text == nil }
            let colour = Self.colour(confidence: confidence, veracity: veracity)
            HStack(spacing: 0) {
                ForEach(pieces) { piece in
                    pieceView(piece, canWiden: canWiden)
                }
            }
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(colour)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(colour.opacity(0.15), in: Capsule())
            .overlay(Capsule().strokeBorder(colour.opacity(0.3), lineWidth: 1))
            .fixedSize()
            // The capsule's own padding as well as the pieces, so a tap aimed at the badge rather
            // than at a word in it is answered too. With no pointer there is nothing to move off
            // with, so the same tap gives the percentages back: it toggles.
            .contentShape(Capsule())
            .onTapGesture { tapped.toggle() }
            .onHover { inside in
                if !inside {
                    heldReveal = false
                    hoveredVerdict = false
                    hoveredSlot = nil
                }
            }
        } else {
            // Nothing to be confident about yet, which is its own answer rather than a blank.
            Text("Unknown")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Self.neutral)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Self.neutral.opacity(0.15), in: Capsule())
                .overlay(Capsule().strokeBorder(Self.neutral.opacity(0.3), lineWidth: 1))
                .fixedSize()
        }
    }

    // MARK: - Pieces

    private struct Piece: Identifiable {
        let role: Role
        /// A slot's adjective, or the verdict word for the verdict piece. Nil for a slot the
        /// model was confident enough to drop.
        let text: String?
        let pct: String
        var glue: String

        /// A piece's role is unique within a badge — the layout holds one slot per score and one
        /// verdict word — and stable across renders, which is what a hover needs: the pieces are
        /// rebuilt on every redraw, and an identity that changed each time would take the pointer's
        /// hover away from it mid-swap.
        var id: Role { role }
    }

    private enum Role: Hashable { case conf, ver, verdict }

    @ViewBuilder
    private func pieceView(_ piece: Piece, canWiden: Bool) -> some View {
        Group {
            if piece.role == .verdict {
                Text(piece.text ?? "")
                    .onHover { inside in
                        hoveredVerdict = inside
                        if inside {
                            // The word takes the whole badge's reveal, and holds the width it
                            // costs only when there is a slot the badge had to widen to show.
                            if canWiden { heldReveal = true }
                            hoveredSlot = nil
                        }
                    }
                glue(piece)
            } else if let adj = piece.text {
                // Both occupants share one cell, so swapping them on hover moves nothing: the cell
                // is as wide as the wider of the two, whichever is showing.
                ZStack {
                    Text(adj).opacity(revealed(piece.role) ? 0 : 1)
                    Text(piece.pct).opacity(revealed(piece.role) ? 1 : 0)
                }
                .onHover { inside in
                    let slot: Slot = piece.role == .conf ? .conf : .ver
                    if inside { hoveredSlot = slot }
                    else if hoveredSlot == slot { hoveredSlot = nil }
                }
                glue(piece)
            } else if revealed(piece.role) {
                // A score of 0.9 or better gets no adjective, so its slot is not in the layout at
                // all until a hover widens the badge to hold it — and once it is, the pointer can
                // only be on it because the verdict word's hover put it there.
                Text(piece.pct)
                    .onHover { inside in
                        if inside { heldReveal = true }
                    }
                glue(piece)
            }
        }
        .fixedSize()
    }

    /// The locale's own separator, read back out of its template — the pieces carry it rather than
    /// the layout, because where it falls is the locale's business.
    ///
    /// It rides with the piece, and not in the row of pieces, because a slot that is out of the
    /// layout has to take its separator with it: a hidden slot that left its space behind would
    /// shift the badge's own text.
    @ViewBuilder
    private func glue(_ piece: Piece) -> some View {
        if !piece.glue.isEmpty {
            Text(piece.glue)
        }
    }

    /// Whether a slot is showing its percentage rather than its adjective — the state the popup's
    /// CSS reaches with `:hover` on a slot, on the verdict word, on an adjective-less slot, or
    /// with the hold class on the badge. `tapped` is the same question asked by a finger; see it.
    private func revealed(_ role: Role) -> Bool {
        heldReveal || hoveredVerdict || tapped
            || hoveredSlot == (role == .conf ? .conf : .ver)
    }

    // MARK: - Label

    /// The adjectives, the verdict word and the template that lays them out for a pair of scores.
    ///
    /// A port of `verdictBadgeParts` (utils/injecting.ts, and the popup's copy of it), branch for
    /// branch, so no two surfaces disagree about the same claim.
    private struct Parts {
        /// The template to lay the badge out with, positional so a locale can order the pieces its
        /// own way, plus the role each of its arguments plays. Nil when no adjective applies and
        /// the badge is a bare word.
        var template: String?
        var roles: [Role] = []
        var verdict: String = ""
        var confAdj: String?
        var verAdj: String?
    }

    private enum Adjective {
        case veryLikely, likely, possibly, mostly, arguably, partially, equivocally

        var text: String {
            switch self {
            case .veryLikely: return String(localized: "Very Likely")
            case .likely: return String(localized: "Likely")
            case .possibly: return String(localized: "Possibly")
            case .mostly: return String(localized: "Mostly")
            case .arguably: return String(localized: "Arguably")
            case .partially: return String(localized: "Partially")
            case .equivocally: return String(localized: "Equivocally")
            }
        }
    }

    /// The extension's badge templates, positional so a locale can reorder them, carried over
    /// verbatim from its `_locales` files — the same strings, and the same translations, the popup
    /// assembles its badge from. Keys are the templates themselves: there is no English sentence
    /// to name them by, which is why they read as format strings.
    private enum Templates {
        /// `badgeAdjVerdict`: one adjective, then the verdict word.
        static let adjVerdict = NSLocalizedString("%1$@ %2$@", comment: "Badge: an adjective and the verdict word")
        /// `badgeVerdictAdj`: the verdict word first, for the locales that read that way.
        static let verdictAdj = NSLocalizedString("%2$@ %1$@", comment: "Badge: the verdict word and an adjective")
        /// `badgeAdjVerdictAdj2`: both adjectives, then the verdict word.
        static let adjVerdictAdj = NSLocalizedString("%3$@ %1$@ %2$@", comment: "Badge: confidence adjective, veracity adjective, verdict word")
        /// `badgeAdjVerdictAdj2Verbose`: the same, with room for a phrase between them.
        static let adjVerdictAdjVerbose = NSLocalizedString("%3$@ to be %1$@ %2$@", comment: "Badge: confidence phrase, veracity adjective, verdict word")
    }

    private static func parts(confidence: Double, veracity: Double?) -> Parts {
        let trueLabel = String(localized: "True")
        let falseLabel = String(localized: "False")

        // Below 0.2 the model won't commit to a direction, whatever the veracity says.
        if confidence < 0.2 {
            return Parts(template: nil, verdict: String(localized: "Unknown"))
        }

        guard let veracity else {
            // Research has only landed one score: its magnitude reads as likelihood, and it takes
            // the template's single adjective slot, ahead of the verdict word.
            let adjective = likelihood(abs(confidence))
            return Parts(
                template: adjective == nil ? nil : Templates.adjVerdict,
                roles: adjective == nil ? [] : [.conf, .verdict],
                verdict: confidence >= 0 ? trueLabel : falseLabel,
                confAdj: adjective?.text,
                verAdj: nil
            )
        }

        let confidenceAdjective = likelihood(confidence)
        let veracityAdjective: Adjective? =
            abs(veracity) >= 0.9 ? nil
            : abs(veracity) >= 0.8 ? .mostly
            : abs(veracity) >= 0.5 ? .arguably
            : abs(veracity) >= 0.2 ? .partially
            : .equivocally

        var template: String?
        var roles: [Role] = []
        if let confidenceAdjective, let veracityAdjective {
            // A multi-word adjective gets the verbose pattern, which is what the extra words are
            // for: "Very Likely to be Mostly True" rather than a three-word pile-up.
            template = confidenceAdjective == .veryLikely ? Templates.adjVerdictAdjVerbose : Templates.adjVerdictAdj
            roles = [.ver, .verdict, .conf]
        } else if confidenceAdjective != nil {
            template = Templates.verdictAdj
            roles = [.verdict, .conf]
        } else if veracityAdjective != nil {
            template = Templates.adjVerdict
            roles = [.ver, .verdict]
        }

        return Parts(
            template: template,
            roles: roles,
            // A veracity of exactly 0 reads as "false", matching the on-page badge.
            verdict: veracity > 0 ? trueLabel : falseLabel,
            confAdj: confidenceAdjective?.text,
            verAdj: veracityAdjective?.text
        )
    }

    private static func likelihood(_ score: Double) -> Adjective? {
        let magnitude = abs(score)
        if magnitude >= 0.9 { return nil }
        if magnitude >= 0.8 { return .veryLikely }
        if magnitude >= 0.5 { return .likely }
        return .possibly
    }

    // MARK: - Template

    /// Stand-ins for a template's arguments while its literal text is read back. Control
    /// characters, so no locale string can contain one and the split stays exact.
    private static let sentinels: [Character] = ["\u{1}", "\u{2}", "\u{3}"]

    /// Walk a template in order, handing each literal run to the piece it follows.
    ///
    /// The sentinel a piece arrives as says which argument it is (`$1` and `$2` are told apart by
    /// the value substituted for each), and the roles array says what that argument means — so a
    /// locale that writes the verdict word first gets a badge that reads that way, with its own
    /// separators in the places its own template put them.
    private static func orderedPieces(_ parts: Parts, confidence: Double, veracity: Double?) -> [Piece] {
        var order: [Piece] = []

        if let template = parts.template {
            for piece in pieces(of: template, roles: parts.roles) {
                guard let role = piece.role else {
                    if !order.isEmpty { order[order.count - 1].glue += piece.text }
                    continue
                }
                if role == .verdict {
                    order.append(Piece(role: .verdict, text: parts.verdict, pct: "", glue: ""))
                } else {
                    order.append(Piece(
                        role: role,
                        text: role == .conf ? parts.confAdj : parts.verAdj,
                        pct: scorePercent(role == .conf ? confidence : (veracity ?? 0)),
                        glue: ""
                    ))
                }
            }
        }

        // A badge with no adjective at all ("True") has no template to walk, so the verdict word
        // goes in on its own and any slots are inserted ahead of it.
        if !order.contains(where: { $0.role == .verdict }) {
            order.append(Piece(role: .verdict, text: parts.verdict, pct: "", glue: ""))
        }

        // A score with no adjective still has a percentage worth showing, so its slot goes where
        // the template would have put it, borrowing the neighbouring slot's separator (or, with no
        // slot to copy from, the locale's own adjective→verdict join).
        var wanted = [Piece(role: .conf, text: parts.confAdj, pct: scorePercent(confidence), glue: "")]
        if let veracity {
            wanted.append(Piece(role: .ver, text: parts.verAdj, pct: scorePercent(veracity), glue: ""))
        }
        for piece in wanted {
            if order.contains(where: { $0.role == piece.role }) { continue }
            var slot = piece
            // A slot that the template has no place for goes where the veracity slot would have
            // been, or failing that just ahead of the verdict word.
            let at = order.firstIndex(where: { $0.role == .ver })
                ?? order.firstIndex(where: { $0.role == .verdict })
            if let at, order[at].role != .verdict {
                slot.glue = order[at].glue
            } else {
                slot.glue = verdictGlueFallback()
            }
            order.insert(slot, at: at ?? order.count)
        }
        return order
    }

    private static func pieces(of template: String, roles: [Role]) -> [(role: Role?, text: String)] {
        let rendered = String(
            format: template,
            arguments: roles.indices.map { String(sentinels[$0]) }
        )
        var pieces: [(role: Role?, text: String)] = []
        var literal = ""
        for character in rendered {
            if let index = sentinels.firstIndex(of: character), index < roles.count {
                pieces.append((nil, literal))
                pieces.append((roles[index], ""))
                literal = ""
            } else {
                literal.append(character)
            }
        }
        pieces.append((nil, literal))
        return pieces
    }

    /// The locale's own separator between an adjective and the verdict word, reused for a slot the
    /// template has no position for.
    private static func verdictGlueFallback() -> String {
        let pieces = pieces(of: Templates.adjVerdict, roles: [.conf, .verdict])
        guard let at = pieces.firstIndex(where: { $0.role == .conf }), at + 1 < pieces.count else { return " " }
        let after = pieces[at + 1]
        // With no slot to read from, the template key itself comes back as one literal, and a
        // plain space is the safe separator then.
        return after.role == nil ? after.text : " "
    }

    /// The score as a whole percentage, for the hover swap. Veracity's sign is dropped: the
    /// verdict word already says true or false, so the magnitude is all that is left.
    private static func scorePercent(_ score: Double) -> String {
        "\(min(100, max(0, Int((abs(score) * 100).rounded()))))%"
    }

    /// Red → yellow → green across veracity, desaturated by how unsure the model is, with a
    /// neutral grey for anything it did not really commit to.
    private static func colour(confidence: Double?, veracity: Double?) -> Color {
        let channels = channels(probability: confidence, veracity: veracity)
        return Color(red: channels.r, green: channels.g, blue: channels.b)
    }

    private static func channels(probability: Double?, veracity: Double?) -> (r: Double, g: Double, b: Double) {
        let grey = 180.0 / 255
        guard let probability, let veracity, probability >= 0.2 else {
            return (grey, grey, grey)
        }
        let truthFraction = (min(1, max(-1, veracity)) + 1) / 2
        let saturation = min(1, max(0, probability))

        var red: Double
        var green: Double
        if truthFraction <= 0.5 {
            red = 1
            green = truthFraction / 0.5
        } else {
            red = 1 - (truthFraction - 0.5) / 0.5
            green = 1
        }
        let luminance = 0.299 * red + 0.587 * green
        return (luminance + (red - luminance) * saturation,
                luminance + (green - luminance) * saturation,
                luminance - luminance * saturation)
    }
}

// MARK: - State

@available(macOS 13.0, iOS 16.0, *)
@MainActor
final class FactCheckModel: ObservableObject {

    /// The popup's warning sentence, so the app and the popup say the same thing about the same
    /// charge — the translations for it already exist.
    ///
    /// The catalog carries it with `%@` where the extension's own files carry `%BTN%`: the string
    /// catalog compiler reads every entry as a format string and `%B` is not a specifier it will
    /// accept, so the sentence would not compile as-is. `%@` is the one-for-one equivalent, and
    /// the extension's `_locales` files are untouched by that — they are a separate pipeline.
    ///
    /// Substituted by hand rather than through `String(format:)`, because the button's own name is
    /// the only thing going in and nothing about it should be re-read as a format directive.
    static func clickWarning(button: String) -> String {
        Bundle.main
            .localizedString(
                forKey: "Clicking %@ reveals claims and will charge your balance",
                value: nil,
                table: nil
            )
            .replacingOccurrences(of: "%@", with: button)
    }

    @Published var inputText = ""
    @Published private(set) var claims: [FactCheckClaim] = []
    @Published private(set) var isPreclassifying = false
    /// Whether a check has been run against the current text, which is what switches the input
    /// from an editor to its read-only marked-up form.
    @Published private(set) var hasChecked = false
    @Published private(set) var message: String?

    /// The access token a request has already been refused with.
    ///
    /// `FactCheckClient.liveSession` is not the whole of what makes a session unusable: the workers
    /// verify the token themselves, and one still inside its expiry can come back refused — revoked,
    /// rotated by a newer popup hand-over, or issued for an account that no longer exists. Only the
    /// server can answer that, and once it has, the only useful thing to do with the answer is stop
    /// offering controls that would produce the same one. Held against the token it was given for,
    /// so a new hand-over clears it without anything having to say so.
    private var refusedToken: String?

    /// Whether a spend — a preclassification, a research, an annotation — has any chance of being
    /// authenticated. Every control that bills reads it, and so do `disinfact` and the research
    /// entry points: a disabled button is a statement about the UI, not a guarantee about the call.
    ///
    /// Stored rather than derived, because half of what decides it is a clock. The token expires on
    /// its own, and a value nothing recomputes would leave the controls enabled for as long as the
    /// user does nothing — `refreshSpendability` is what the view's poll drives.
    @Published private(set) var canSpend = FactCheckClient.canAuthenticate

    /// Recomputes `canSpend`. Called by the view's two-second poll, and by `maySpend` on the click
    /// itself.
    func refreshSpendability() {
        canSpend = FactCheckClient.canAuthenticate
            && SharedTopUpStore.session?.accessToken != refusedToken
    }

    /// Whether a spend may go ahead, refreshing the answer first: a state that has only just become
    /// true — an expiry reached since the last poll — should stop the run on the click that found it
    /// rather than on the request that failed for it.
    private func maySpend() -> Bool {
        refreshSpendability()
        return canSpend
    }

    /// A run that failed, recorded against the token it failed with when the failure was the token
    /// itself. The two shapes of that: the app's own expiry check throwing before anything is sent,
    /// and a worker answering 401 for a token that had not expired yet. Both mean the same thing to
    /// the user and the same thing here — nothing can be spent until the popup hands over another.
    private func recordFailure(_ error: Error) {
        guard let failure = error as? FactCheckError else { return }
        switch failure {
        case .sessionUnavailable, .worker(status: 401, body: _):
            refusedToken = SharedTopUpStore.session?.accessToken
        case .worker, .unreadable:
            return
        }
        refreshSpendability()
    }

    /// Whether the tab has work in flight: a preclassification, a research still answering for a
    /// claim, or an annotation pass. The one expression the notifier and the controls both read, so
    /// a disabled button and the balance watch cannot disagree about what "busy" means.
    ///
    /// Annotations count, and did not. An Annotate run left the buttons that bill enabled — a
    /// Disinfact click through it cancels a run that has already been paid for — and left the
    /// balance watch shut, so an annotation's charge was the one charge this app makes that nothing
    /// announced.
    var isBusy: Bool { phase != nil }

    /// Which pass the tab is running at this instant. Read by `isBusy`, and passed to the notifier
    /// as the name of last resort for a charge read with no pass left to claim it.
    ///
    /// It names what is running, which is not the same as what a charge belongs to: a notification
    /// is posted when the balance poll *notices* a charge, and that is regularly after the pass
    /// that caused it has ended. Which pass bought a charge is settled by registering it at its own
    /// request — see `FactCheckNotifier.willBill`.
    private var phase: FactCheckNotifier.Activity? {
        if isPreclassifying { return .disinfact }
        if !annotateTasks.isEmpty { return .annotate }
        if !researchTasks.isEmpty { return .factCheck }
        return nil
    }

    private var preclassifyTask: Task<Void, Never>?
    private var researchTasks: [FactCheckClaim.ID: Task<Void, Never>] = [:]
    private var annotateTasks: [FactCheckClaim.ID: Task<Void, Never>] = [:]
    private var annotationWaitTasks: [FactCheckClaim.ID: Task<Void, Never>] = [:]

    // MARK: - Fact-Check All's admission

    /// Claims "Fact-Check All" was pressed for and that have not been admitted yet, in the order
    /// the snapshot found them. Empty whenever no batch is running.
    ///
    /// A claim waits here rather than starting, which is the whole of the guard: every claim this
    /// button runs reserves its worst case against one shared balance, so the number admitted at
    /// once has to be the number the balance can settle at once. See `pumpWaitlist`.
    private var waitlist: [FactCheckClaim.ID] = []

    /// The claims holding a reservation right now.
    ///
    /// A set of ids rather than a count, because a run can outlive the batch it belonged to: a
    /// cancellation reaches a task blocked on an await only when that await returns, so a run from
    /// the text the user just replaced can end after the next batch has admitted its own. Its id is
    /// gone from here by then, and its release is dropped rather than credited to a batch it was
    /// never part of. The ids are claim ids, fresh per preclassification, so the same text checked
    /// twice does not collide with itself here.
    private var admitted: Set<FactCheckClaim.ID> = []

    /// Σ of the reserves admitted and not yet finished — the size of the set above, which is what
    /// makes the two impossible to disagree. `availableToSpend` subtracts it, and that is what
    /// stops a batch from committing the same money twice.
    private var committedSpend: Double { Double(admitted.count) * Self.classificationReserve }

    /// Where this batch started: the balance + hold, read once when the button is pressed.
    ///
    /// Only the first admissions are decided against it. A press starts runs, runs start the
    /// notifier's watch, and from then on `availableToSpend` reads that live figure instead —
    /// which is the point, because only a total that moves with the settles lets a reservation be
    /// released by the whole of itself rather than by a charge nothing here knows.
    ///
    /// Nil until that read answers, and left nil when it fails: a balance nobody could read admits
    /// everything, which is what this did before there was an admission step at all.
    private var batchTotal: Double?

    /// The one read of it, in flight. Cancelled with the batch — a total that came back after the
    /// batch it was read for was torn down belongs to no batch, and keeping it would have the next
    /// press measure against a figure from before whatever the last one spent.
    private var batchTotalRead: Task<Void, Never>?

    /// The live Realtime subscription for the checked text's hash, if one is open. One at a time,
    /// because one text is on screen at a time; opening for a new hash closes the old handle.
    private var tweetSubscriptions: [String: RealtimeRowSubscription] = [:]

    /// Payloads the subscription has already delivered, by hash. A wait that starts after the
    /// broadcast it was waiting for has to find it here rather than wait for a second one that is
    /// never coming.
    private var claimRowsSeen: [String: [FactCheckClient.ClaimRow]] = [:]

    /// Research waiting on a preclassified claim's row. See `waitForClaimRow`.
    private var claimRowWaiters: [ClaimRowWaiter] = []

    /// The text the check on screen was run against, and the hash its rows are keyed by. Every
    /// later request for those rows — a re-read behind an Annotate tap — has to name the same
    /// text, so the envelope is kept rather than rebuilt.
    private var checkedInput: FactCheckInput?

    /// Who the text is attributed to in the hash, which is what makes two users' fact-checks of
    /// the same text different rows.
    ///
    /// Empty, because the hash is the key the backend stores a fact-check under and the
    /// extension's own Fact-Check tab hashes its input with an empty username
    /// (entrypoints/popup/FactCheckTab.tsx). Any other value here — the account id, say — keys
    /// the same text differently, and the app would then miss the row the extension already paid
    /// to write and pay to have it written a second time. Attribution is not what separates
    /// users on this path: row-level security does, on the token every request already carries.
    private static let username = ""

    /// The worst-case *settled charge* for one classification — what an admitted "Fact-Check All"
    /// claim reserves against the balance before it is allowed to run.
    ///
    /// The browser extension's `CLASSIFICATION_RESERVE` (`entrypoints/background.ts`), derived the
    /// same way rather than copied as a figure. The three terms are `classify-tweets`' own
    /// worst-case hold terms — the Gemini streams, the paid searches, and the post-research
    /// annotation — summed and fee-recovered once, and then marked up by the margin that worker
    /// charges. Deliberately the settled charge and NOT the backend hold: the hold excludes the
    /// margin, so reserving it would size a batch against roughly half of what its runs really
    /// debit, which is the mistake the extension already made once. The worker's hold carries no
    /// cap, so this reserve stays the conservative side of it. Change the worker's formula and
    /// this, and the extension's copy, together.
    private static let classificationReserve: Double = {
        let geminiIn = 0.75, geminiOut = 3.75, outputLimit = 2000.0   // gemini-3.6-flash
        let inputLimit = 6000.0, searchContextTokens = 3500.0, geminiStreams = 4.0
        let tavilySearchCost = 0.016, exaDeepCost = 0.015
        let annotIn = 0.99, annotOut = 2.20, annotFee = 1.055          // Qwen 3.8 27B via OpenRouter
        let annotInputLimit = 20000.0, annotOutputLimit = 2000.0
        let feeMultiplier = (4.0 / 3.0) * 1.03   // Apple/Stripe take + FX
        let profitMultiplier = 2.0               // classify-tweets' margin, on the whole charge

        let geminiWorst = ((inputLimit + searchContextTokens) * geminiIn + outputLimit * geminiOut) / 1e6 * geminiStreams
        let searchWorst = tavilySearchCost * 2 + exaDeepCost
        let annotWorst = (annotInputLimit * annotIn + annotOutputLimit * annotOut) / 1e6 * annotFee
        return (geminiWorst + searchWorst + annotWorst) * feeMultiplier * profitMultiplier
    }()

    /// How long a freshly researched claim waits for Flow A's annotation write before offering to
    /// buy one. The popup's own window (ANNOTATE_AUTO_PENDING_TIMEOUT_MS), and for the same
    /// reason: the write lands after the stream that caused it has closed, and until it does, an
    /// Annotate button would be selling a run that is already on its way.
    private static let annotationWait: TimeInterval = 3 * 60

    /// How long a claim subscription is held open. The popup's own window
    /// (ANNOTATION_TIMEOUT_MS) — Flow A's write is an LLM pass behind the research that caused
    /// it, so the route has to outlast that pass rather than a round trip. Past it the handle
    /// closes and the claim falls back to offering the button.
    private static let annotationSubscription: TimeInterval = 5 * 60

    /// How long research waits for a preclassified claim's row before running without it. The
    /// popup's own window (CLAIM_DB_ROW_TIMEOUT_MS): a few round trips, not seconds, because
    /// what is being waited on is a detached insert, and a claim that never gets its id is
    /// better researched by text than not researched at all.
    private static let claimRowWait: TimeInterval = 2

    /// Preclassifies the entered text, then researches it if it turns out to hold exactly one
    /// claim — the same shortcut the popup takes, where a single claim would otherwise need a
    /// second click to get the answer the user already asked for.
    ///
    /// Also the refresh: run again from the arrow button, where the text on screen is the text
    /// already run. That case skips the cache read below, for the reason the popup skips it
    /// (`isRedisinfact`, FactCheckTab.tsx) — answering the click out of the rows already on
    /// screen is what a dead button looks like. The refresh re-derives the claims on purpose,
    /// and reads the rows back afterwards for what preclassification does not return.
    func disinfact() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        // Refused while a research is in flight, which is the popup's own guard
        // (`if (!trimmed || isBusy) return`, handleDisinfact). The re-run cancels the research
        // tasks first, and a cancellation is not a refund: the classify worker this app started
        // has been paid for and keeps running, while the claim's row stays unanswered until it
        // writes. The re-run then reads that unanswered row, finds nothing to link to, and buys
        // the same classification over again. Measured in a debug run: a refresh taken seconds
        // after a first check bought a second classification for a claim whose first one had not
        // landed — with the row's own `is_classifying` flag set the whole time, which is what
        // says nobody should have read it as untouched.
        guard !text.isEmpty, !isBusy else { return }

        // The buttons carry this too; here it is the request behind them. A run that cannot
        // authenticate fails with the sentence the notice already shows — and it would first have
        // cancelled, and so thrown away, the check on screen to get there. See `canSpend`.
        guard maySpend() else { return }

        // The popup's condition, minus the half this view cannot reach: it is a re-Disinfact
        // when claims are on screen and the text under them is the text that produced them, and
        // while a check is on screen the editor is replaced by the read-only text, so the text
        // cannot have been edited out from under the claims. Read before the flags below move.
        let isRefresh = hasChecked && !claims.isEmpty

        cancelAll()
        claims = []
        message = nil
        isPreclassifying = true
        hasChecked = true
        refreshWorkState()

        let input = FactCheckInput(text: text, username: Self.username)
        checkedInput = input
        let locale = FactCheckClient.uiLocale

        preclassifyTask = Task {
            defer {
                isPreclassifying = false
                // Preclassification bills too, and it hands off to `autoResearchLoneClaim`, whose
                // research task is registered before this runs — so the tab is still working here
                // and the watch must stay open across the seam.
                refreshWorkState()
            }

            // The cache first, and not as an optimisation: the preclassify worker bills for every
            // request it serves, so this lookup is the difference between paying to be told
            // something the backend already knows and being given it. Only when it misses is the
            // paid path taken.
            //
            // It is also the only way this app learns a claim's id and its annotations, which is
            // why a hit is not just a cheaper answer but a fuller one. A refresh skips it.
            if !isRefresh {
                let rows = await FactCheckClient.cachedRows(for: input, locale: locale)
                guard !Task.isCancelled else { return }
                if !rows.isEmpty {
                    claims = rows.map { FactCheckClient.claim(from: $0, body: text, locale: locale) }
                    // Opened even on a hit, because a hit is exactly when a row is about to be
                    // linked to and researched: the rows above carry ids, but a claim whose row
                    // is already settled still gets Flow A's annotation write, and a claim the
                    // cache answered for has no research to carry the answer on either.
                    openAnnotationSubscription(for: input)
                    autoResearchLoneClaim()
                    return
                }
            }

            do {
                // The request goes out first, then this line puts the subscription alongside it —
                // the popup's ordering, and it is the ordering that matters rather than the idiom:
                // the routing row this subscription writes is what the worker's claim insert is
                // delivered to, and that write lands about a second and a quarter in, behind an LLM
                // pass that has not started yet. Opening it here leaves the whole run as margin.
                //
                // Open it after the read below instead — which is where this used to be, and where
                // the line still is for a first-time check — and the row can be written after the
                // link it was opened for: the preclassifier answers an already-classified claim by
                // LINKING to the row that holds it and returning the claim alone, so a missing
                // payload is a claim with no verdict and no id, researched again at full price.
                //
                // A refresh only, and not because a first-time check does not want it: there the
                // tweet does not exist yet, so `subscribe` parks the row on the hash and
                // `insert_tweet` resolves it — a race with the request above that the fresh path
                // does not have to run, because the handle below resolves cleanly against a tweet
                // that exists by the time the stream has closed. See `openAnnotationSubscription`.
                //
                // Registered at the request rather than at the click, because the request is what
                // is billed: the cache read above answers a text the backend already holds without
                // one, and a pass registered for it would sit in the queue naming whatever charge
                // came next. See `FactCheckNotifier.willBill`.
                FactCheckNotifier.shared.willBill(.disinfact)
                let stream = FactCheckClient.preclassify(input: input, locale: locale)
                if isRefresh { openAnnotationSubscription(for: input) }

                for try await streamed in stream {
                    guard !Task.isCancelled else { return }
                    claims = streamed
                }
                note("stream closed: refresh=\(isRefresh) claims=\(claims.count) classified=\(claims.filter(\.isClassified).count)")
                // Preclassification answers a claim the backend already knows by LINKING to the
                // row that holds it, and returns the claim alone: no verdict, no id (see
                // ClaimStreamParser). On a refresh those linked rows are the ones that were on
                // screen a moment ago, and both halves are needed — the verdict, because a
                // refresh that dropped it would be a refresh that lost the answer; the id,
                // because a claim without one is researched from scratch, and the user is then
                // charged twice for a text already paid for. So the rows are read back and folded
                // in, which is what the popup does here too.
                //
                // Every run with claims on screen, whatever its size — the popup reads here for a
                // refresh or a lone claim (`isRedisinfact || initialClaims.length === 1`), and
                // that second half is where this went wrong.
                //
                // A claim's row is not necessarily under this hash. The worker's matcher resolves
                // a claim to the row that already holds it and links THAT row, wherever it was
                // first researched, so no lookup taken before the request could have answered for
                // it — it asked for this hash, and the claim may be filed under another.
                //
                // A multi-claim fresh run used to be the exception, on the grounds that it had
                // just asked for this hash's rows and found none. Found-none is exactly the state
                // the request itself changes: the pipelines run detached, after the stream has
                // closed, and they LINK each row they matched to this hash. Measured on a
                // two-claim check: stream drained at +1461ms, the two links landed at +2279ms and
                // +2315ms — both rows answered, and both already in the database. Reading is what
                // puts them back on screen, and skipping it here charged for a second answer to a
                // two-claim text that a one-claim text was given for nothing.
                //
                // What the read can still miss is a link being written this instant, which is
                // what the wait below is for.
                if !claims.isEmpty {
                    let rows = await FactCheckClient.cachedRows(for: input, locale: locale)
                    guard !Task.isCancelled else { return }
                    for row in rows {
                        guard let match = claims.firstIndex(where: {
                            FactCheckClient.row(row, describes: $0, body: text)
                        }) else { continue }
                        adopt(row: row, on: claims[match].id, body: text)
                    }
                }
                // About to open its own, for the same reason as the refresh case above: this is
                // the first moment a first-time check can be subscribed at all. `subscribe` parks
                // a tweet that does not exist yet on its hash and `insert_tweet` resolves the row
                // when it lands, so a handle opened at the request would be resolved only if it
                // won that race — and a parked row that loses it is inert for the whole run.
                // Nothing after this point needs it less: a preclassified claim has no id (its row
                // is written by a pipeline detached from the stream just read), and the broadcast
                // this subscription carries is that write landing, which is what `waitForClaimRow`
                // waits for. Same in the popup (FactCheckTab.tsx).
                //
                // Skipped on a refresh, which already has a handle for this hash — opened with the
                // request, and alive for everything the same routing row reaches until the
                // preclassification teardown deletes it. A second would be the same broadcast
                // twice, billed twice. See `openAnnotationSubscription`.
                if !isRefresh { openAnnotationSubscription(for: input) }

                // Before the decision to research, and on a first-time check as much as on a
                // refresh. The read above is racing the write it is looking for and losing, and
                // that is as true of the first run as of the second: what the matcher links is a
                // row that may have been written days ago, and the run that links it is the one
                // this text has just paid for. `autoResearchLoneClaim` buys another
                // classification; this is the whole of what stands between the two. See the
                // helper.
                await adoptSettledClaimRows(input)
                autoResearchLoneClaim()
            } catch {
                guard !Task.isCancelled else { return }
                recordFailure(error)
                message = error.localizedDescription
                FactCheckNotifier.shared.reportFailure(error.localizedDescription)
            }
        }
    }

    func research(_ id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }), !claims[index].isResearching else { return }
        guard maySpend() else { return }
        startResearch(at: index)
    }

    /// Runs every claim still showing its button, admitting no more of them at once than the
    /// balance can settle at once.
    ///
    /// The alternative is what this did until the queue existed: a fan-out that started all of them
    /// in parallel, each taking a backend hold against the same balance. The holds are the problem
    /// — `acquire_hold` takes `LEAST(balance, requested)` and refuses only while the balance is at
    /// or below nothing, so a balance that covers one run and not five will still accept five, and
    /// the settles that follow debit past it. This is the same queue the extension keeps for the
    /// same button, decided the same way.
    func researchAll() {
        guard maySpend() else { return }
        // Indices are taken from a snapshot and re-resolved before each use: starting a research
        // asks the worker for work, and nothing about that may depend on the array not having
        // changed in the meantime.
        // A claim with a stale answer is included: "Fact-Check All" is the button that runs the
        // rest of the text, and a claim whose row is past its reclassification date is one of the
        // ones there is work left to do on.
        //
        // A claim already queued is not queued again: the button stays on screen while a batch
        // drains (the claims still waiting have not been researched), so a second press is the
        // ordinary thing to do and must not put the same claim in line twice.
        for id in claims.filter({ (!$0.isClassified || $0.needsReclassify) && !$0.isResearching }).map(\.id)
        where !waitlist.contains(id) {
            waitlist.append(id)
        }
        guard !waitlist.isEmpty else { return }
        message = nil

        // A batch already under way has its total, so what this press added goes through the same
        // pump as everything else waiting behind it.
        if batchTotal != nil {
            pumpWaitlist()
            return
        }
        // A read already out for this same batch. This press buys no second one, and pumps none
        // either: there is no total to decide against yet, and pumping without one reads the
        // balance as unbounded and admits the lot. The read's own pump follows a moment later.
        guard batchTotalRead == nil else { return }

        // One read per batch, and the whole of what the admission below is decided against. It is
        // billed — every `get_funds` is — so it happens at the press rather than at each claim.
        batchTotalRead = Task { [weak self] in
            let total = await FactCheckNotifier.fetchTotal()
            guard let self, !Task.isCancelled else { return }
            self.batchTotalRead = nil
            self.batchTotal = total
            self.pumpWaitlist()
        }
    }

    /// Admits every queued claim the balance funds in full; once it cannot, admits exactly one and
    /// stops until it finishes.
    ///
    /// Parallel admission needs the FULL reserve for each claim, because every admitted claim
    /// settles against the same balance at once. A partly-funded head is not refused, though: one
    /// claim at a time is safe, since the backend's own gate is only that the balance is positive
    /// and a run that overshoots what is left merely dips it negative and blocks the next one.
    /// Refusing it instead would block a user whose balance is positive but small.
    ///
    /// The reserve is the worst case, and every run settles for at most that, so `availableToSpend`
    /// under-states what is free rather than over-stating it — the direction a guard on money should
    /// be wrong in.
    private func pumpWaitlist() {
        while !waitlist.isEmpty {
            let available = availableToSpend()
            if available >= Self.classificationReserve {
                admit(waitlist.removeFirst())
                continue   // still fully funded — another claim can safely run alongside it
            }
            // The backend refuses a hold only while the balance is ≤ 0, and takes `LEAST(balance,
            // requested)` rather than rejecting a request larger than the balance — so with nothing
            // of this batch in flight, a balance above nothing is the whole of what it takes.
            if available > 0, admitted.isEmpty {
                admit(waitlist.removeFirst())
            }
            break
        }
        // A queue that could not advance with nothing running to free the room for it is not
        // waiting, it is stuck: only a balance at or below nothing does that. Said as the backend
        // would have said it — the sentence for it already exists and is translated — because the
        // alternative is what this did before the queue: dispatch every claim and let each come
        // back refused, which is one red row per claim saying one thing. A claim never admitted has
        // no request behind it and so no row to carry it, which leaves the tab as the only place
        // left to say it.
        if admitted.isEmpty, !waitlist.isEmpty {
            waitlist.removeAll()
            batchTotal = nil
            let refusal = FactCheckError.worker(status: 402, body: Data()).localizedDescription
            message = refusal
            FactCheckNotifier.shared.reportFailure(refusal)
        }
    }

    /// Money free to commit now, in the one figure that does not move when a hold is taken.
    ///
    /// Taking the live total where there is one, and this batch's own reading of it before that,
    /// is what lets `finishAdmittedClaim` release a whole reservation rather than the run's real
    /// charge — which nothing on this side knows. The reservation is deliberately larger than any
    /// charge, so releasing it against a total that has already moved with the settle reads
    /// correctly; releasing it against a figure frozen at the press would credit the batch the
    /// difference between the two, every claim, for the length of the batch.
    ///
    /// A total nobody has is unbounded, which admits everything: a balance that could not be read
    /// is not evidence of an empty one, and guessing otherwise would refuse to run work the user
    /// asked for. That is also the whole of the fallback for a failed read at the press.
    private func availableToSpend() -> Double {
        guard let total = FactCheckNotifier.shared.visibleTotal ?? batchTotal else { return .infinity }
        return total - committedSpend
    }

    /// Starts one queued claim, reserving its worst-case charge until it finishes.
    ///
    /// The order of these two lines is the reservation: `pumpWaitlist` reads what is free again as
    /// soon as this returns, so a claim admitted here has to be counted before it is.
    private func admit(_ id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        admitted.insert(id)
        startResearch(at: index, admitted: true)
    }

    /// Releases one admitted claim's reservation, then lets the queue past it.
    ///
    /// The only place a batch advances: every way an admitted run can end — a verdict, a refusal, a
    /// failure, a cancellation from `startOver` — comes through the `defer` in `startResearch`, so a
    /// claim that ends any way at all frees the room it was holding. Without that, one failure
    /// early in a batch would shrink what the rest of it could ever spend.
    ///
    /// A claim no longer in `admitted` is one released already — by `cancelAll`, which drops the
    /// whole set with the text it belonged to — and its release is dropped with it. See `admitted`.
    private func finishAdmittedClaim(_ id: FactCheckClaim.ID) {
        guard admitted.remove(id) != nil else { return }
        pumpWaitlist()
        // The batch is over when there is nothing left to admit and nothing running. The total it
        // was admitted against goes with it, so the next press reads the balance as it stands then
        // rather than measuring against a figure from before whatever this one spent.
        if waitlist.isEmpty, admitted.isEmpty {
            batchTotal = nil
        }
    }

    /// Whether the text on screen has any claim left to run, which is what the "Fact-Check All"
    /// button is for.
    var hasUnrunClaims: Bool {
        claims.contains { (!$0.isClassified || $0.needsReclassify) }
    }

    /// Gets annotations onto one claim: the ranges the backend already holds, or a model run if
    /// it holds none.
    ///
    /// The annotate worker names a claim by its id and by nothing else — Flow B has no text to
    /// match on — so a claim that does not have one yet has to be found first. That is one read
    /// of the row, matched to the claim exactly as every other read is, and it is the answer half
    /// the time: research carries the annotation locators, so the row often holds the ranges
    /// already and the tap costs a read instead of a run.
    func annotate(_ id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }), !claims[index].isAnnotating else { return }
        guard maySpend() else { return }
        claims[index].isAnnotating = true
        claims[index].errorMessage = nil

        let locale = FactCheckClient.uiLocale
        annotateTasks[id] = Task {
            defer {
                self.annotateTasks[id] = nil
                self.setAnnotating(false, on: id)
                self.refreshWorkState()
            }
            do {
                guard let input = self.checkedInput,
                      let snapshot = self.claims.first(where: { $0.id == id }) else { return }

                if snapshot.claimId == nil {
                    let rows = await FactCheckClient.cachedRows(for: input, locale: locale)
                    guard !Task.isCancelled else { return }
                    guard let row = rows.first(where: {
                        FactCheckClient.row($0, describes: snapshot, body: input.fullText)
                    }) else {
                        self.fail(with: String(localized: "That couldn't be found. Please try again."), on: id)
                        return
                    }
                    self.adopt(row: row, on: id, body: input.fullText)
                    // A read that came back with ranges for this revision is the whole answer;
                    // there is nothing left to run.
                    if self.claims.first(where: { $0.id == id })?.missingAnnotations == false {
                        self.setAwaitingAnnotations(false, on: id)
                        return
                    }
                }

                guard let index = self.claims.firstIndex(where: { $0.id == id }),
                      let claimId = self.claims[index].claimId else {
                    self.fail(with: String(localized: "That couldn't be found. Please try again."), on: id)
                    return
                }
                // Past the read above, which answers for a claim whose row already holds the ranges
                // and buys nothing: this is the annotation pass itself, the one charge of the three
                // that nothing else in this app could have reported as an annotation.
                FactCheckNotifier.shared.willBill(.annotate)
                let result = try await FactCheckClient.annotate(
                    claimId: claimId,
                    claimIndex: index,
                    locators: Self.locators(for: input, claimIndex: index, claimId: claimId, locale: locale),
                    locale: locale,
                    onPartial: { partial in
                        Task { @MainActor in self.paint(partial, on: id, locale: locale) }
                    }
                )
                // Nil is the worker declining to annotate this claim — a stale verdict, a claim it
                // cannot place. The button stays, which is how the user learns to re-run it.
                guard !Task.isCancelled, let result else { return }
                self.paint(result, on: id, locale: locale)
                self.setAwaitingAnnotations(false, on: id)
            } catch {
                guard !Task.isCancelled else { return }
                self.recordFailure(error)
                self.fail(with: error.localizedDescription, on: id)
            }
        }
        // In the map from the line above, so the tab counts as working from here — and the notifier
        // learns that what this opens is an annotation, which is the one thing it cannot read off
        // the balance. `startResearch` does the same thing for the same reason.
        refreshWorkState()
    }

    /// Clears everything back to the editor, cancelling work that is still streaming. The claims
    /// on screen describe a text the user is about to replace, and letting their responses land
    /// afterwards would attach verdicts to the wrong text.
    func startOver() {
        cancelAll()
        closeAnnotationSubscriptions()
        claims = []
        message = nil
        hasChecked = false
        checkedInput = nil
    }

    /// Empty the surface: the text, everything derived from it, and back to a blank editor — the
    /// popup's `handleClearAll`.
    ///
    /// Not folded into `startOver`, which deliberately keeps the text: that one is the Edit
    /// button, and bringing the text back is the whole point of it.
    func clearAll() {
        startOver()
        inputText = ""
    }

    // MARK: - Internals

    /// The tweet-shaped locators every claim request carries: the hash this text's rows are keyed
    /// by, the text itself, and the locale its offsets index.
    private static func locators(
        for input: FactCheckInput,
        claimIndex: Int,
        claimId: String?,
        locale: String
    ) -> FactCheckClient.ClaimLocators {
        FactCheckClient.ClaimLocators(
            tweetHash: FactCheckClient.hash(of: input),
            tweetText: input.fullText,
            textLocale: locale,
            claimIndex: claimIndex,
            claimId: claimId
        )
    }

    /// A line of the fact-check decision path, in debug builds only.
    ///
    /// This path spends money on a decision nothing on screen explains: whether a run was bought
    /// for a verdict the database already held is settled by a broadcast arriving inside a
    /// two-second window, and by a row describing the claim as the same words. Without this the
    /// answer only exists in the balance. Debug-only, so a release build says nothing.
    private func note(_ message: String) {
        #if DEBUG
        print("[factcheck] \(message)")
        #endif
    }

    /// Waits out the rows of every claim that has no answer yet — on either path, refresh or
    /// first-time — and takes the verdicts the broadcasts carry.
    ///
    /// The read made before this is racing the write it is looking for, and it loses by
    /// construction. The preclassify worker closes its event stream the moment the model is done
    /// — `data: [DONE]`, then `writer.close()` — and only afterwards embeds, matches and links the
    /// claim, awaiting those pipelines in the `finally` that follows (preclassify-tweets/index.js).
    /// The stream ending IS the write starting. Measured on a one-claim refresh: stream closed at
    /// +857ms, link landed at +1537ms, so the read is a full second early and a claim the database
    /// has already answered reads as untouched. Researching on that reading is not a wasted round
    /// trip — it is a charge for a verdict that already exists, and on a refresh of a one-claim
    /// text it is the normal outcome rather than the unlucky one.
    ///
    /// On a first-time check the same charge is on the table for the reason the matcher exists:
    /// `CLAIM_FETCHER` resolves a claim this text does not have a row for to the row that already
    /// holds it, and links that. The verdict is then in the database under another tweet's hash
    /// and the claim that streamed had no id, no verdict and no sign that either was waiting. That
    /// is as true of the second and third claim of a text as of its only one, and this used to run
    /// for a lone claim alone (`guard claims.count == 1`) — the reason a two-claim text came back
    /// with both claims unanswered while the worker's own log showed `matchedId` and
    /// `link_tweet_claim OK` for each of them.
    ///
    /// The claim-row broadcast is that write landing and the subscription is already carrying it,
    /// so this wait costs no request against the metered read. Taking the whole row rather than
    /// the id — which is all `nameClaim` takes — is the point: the id names the claim, and the
    /// verdict is what makes researching it unnecessary.
    ///
    /// The popup's path, which reads, then waits for the same broadcast, and only then decides
    /// whether to classify (adoptSettledRow, entrypoints/popup/FactCheckTab.tsx).
    private func adoptSettledClaimRows(_ input: FactCheckInput) async {
        // No LIVE session is no socket: an expired token is filtered rather than refused, so the
        // channel would be up and delivering nothing. Spending the window on it is the same waste
        // as spending it signed out, which is what this guard already refuses to do.
        guard FactCheckClient.canAuthenticate else { return }
        let hash = FactCheckClient.hash(of: input)
        guard !hash.isEmpty else { return }

        // Taken before anything is adopted: `adopt` moves `isClassified` and `needsReclassify`, and
        // a claim that has just been given its verdict must not drop the claims still to come.
        let pending = claims.filter { !$0.isClassified || $0.needsReclassify }.map(\.id)
        guard !pending.isEmpty else { return }

        // Concurrently, because the wait is a fixed window whenever no row arrives: a text with
        // four unrun claims would otherwise sit behind four of these in a row. They all resolve
        // against the same broadcast, and a payload answers whichever waiter it describes.
        await withTaskGroup(of: Void.self) { group in
            for id in pending {
                group.addTask { @MainActor in
                    guard let claim = self.claims.first(where: { $0.id == id }) else { return }
                    guard let row = await self.waitForClaimRow(
                        hash: hash,
                        claim: claim,
                        body: input.fullText
                    ) else {
                        self.note("nothing arrived for \(hash.prefix(8)) naming \"\(claim.rewritten.prefix(24))\"")
                        return
                    }
                    self.note("adopting \(row.id?.prefix(8) ?? "nil") reclassify=\(row.reclassify) answered=\(row.isAnswered) reasoning=\(row.reasoning?.count ?? -1)ch classifying=\(row.isClassifying)")
                    self.adopt(row: row, on: id, body: input.fullText)
                }
            }
        }
    }

    /// A lone claim skips the second click, and the row's already-settled answer skips the run:
    /// the same shortcut, with the same exception, the popup takes on its own cached rows.
    private func autoResearchLoneClaim() {
        guard claims.count == 1, let only = claims.first else { return }
        guard !only.isClassified || only.needsReclassify else {
            note("lone claim: settled by the row, nothing bought")
            return
        }
        note("lone claim: still unclassified (id=\(only.claimId?.prefix(8) ?? "none") needsReclassify=\(only.needsReclassify)) — buying a run")
        startResearch(at: 0)
    }

    /// - Parameter admitted: Whether "Fact-Check All" admitted this run through its queue, and so
    ///   whether it holds a reservation that has to be released when the run ends. False for the
    ///   two paths with no queue behind them — the button on a claim's own card, and the lone-claim
    ///   shortcut — where one run is the whole of what was asked for and there is nothing to wait
    ///   on. Those spend without reserving, exactly as the extension's own single-claim runs do.
    private func startResearch(at index: Int, admitted: Bool = false) {
        guard index < claims.count else { return }
        let id = claims[index].id
        let text = claims[index].rewritten
        claims[index].isResearching = true
        claims[index].errorMessage = nil

        let locale = FactCheckClient.uiLocale
        researchTasks[id] = Task {
            defer {
                self.researchTasks[id] = nil
                self.setResearching(false, on: id)
                // Before `refreshWorkState`, so the claim this frees the room for is already
                // marked researching by the time the notifier is told what is in flight.
                if admitted { self.finishAdmittedClaim(id) }
                self.refreshWorkState()
            }
            // Name the claim before researching it. Building the locators out here would hand the
            // worker a nil id and leave it to look the row up by text — a race it loses whenever
            // the insert has not landed, answered with "Claim not found for the provided
            // parameters". So the wait comes first, and the locators are built from what it found.
            await self.nameClaim(id)
            guard !Task.isCancelled else { return }
            guard let current = self.claims.firstIndex(where: { $0.id == id }) else { return }
            let locators = self.checkedInput.map { input in
                Self.locators(
                    for: input,
                    claimIndex: current,
                    claimId: self.claims[current].claimId,
                    locale: locale
                )
            }

            var received = false
            do {
                // This pass, as the request that bills it goes out — and this one place is every
                // research there is: the button, "Fact-Check All"'s loop, and the run a Disinfact
                // hands off to for a lone claim (see `autoResearchLoneClaim`). That last one is why
                // the registration is here and not at a button: it is a pass no button started, and
                // its charge used to be announced under whatever the user had pressed before it.
                FactCheckNotifier.shared.willBill(.factCheck)
                for try await verdict in FactCheckClient.research(claim: text, locale: locale, locators: locators) {
                    guard !Task.isCancelled else { return }
                    received = true
                    self.apply(verdict, to: id)
                }
                // A stream that ends without ever yielding is a worker that returned nothing to
                // say. Left alone the claim would sit on "researching" forever.
                if !received, !Task.isCancelled {
                    self.fail(with: String(localized: "Something went wrong on our end. Please try again in a moment."), on: id)
                }
                // Flow A annotates this claim server-side in `waitUntil`, after the stream above
                // has closed — so the write has no connection left to answer on, and nothing to
                // read it back would catch either: a read now would fire while Flow A is still on
                // its second LLM call and return the pre-annotation row every time. A NEW
                // subscription is the only route, opened here and not earlier for the reason
                // `openAnnotationSubscription` gives.
                if !Task.isCancelled, let input = self.checkedInput {
                    self.openAnnotationSubscription(for: input)
                }
                // Research that ran with locators is research Flow A will annotate, so until that
                // write has had its window the claim must not offer to buy the run already in
                // flight.
                if !Task.isCancelled, locators != nil {
                    self.markAwaitingAnnotations(on: id)
                }
            } catch {
                guard !Task.isCancelled else { return }
                self.recordFailure(error)
                self.fail(with: error.localizedDescription, on: id)
            }
        }
        // The task is in the map from the line above, so the tab counts as working from here —
        // which is the moment the run can start being charged for.
        refreshWorkState()
    }

    /// Give a claim the id of the backend row it names, waiting for the subscription to carry it
    /// when the claim does not have one yet. A claim that gets none is left unnamed, and research
    /// falls back to matching it by text — worse, but not fatal.
    private func nameClaim(_ id: FactCheckClaim.ID) async {
        // No LIVE session is no socket, so no broadcast could arrive however long the wait:
        // spending the window anyway would put two seconds in front of every research run for a
        // user who simply is not signed in — including one whose token has expired, which is the
        // state this used to miss.
        guard FactCheckClient.canAuthenticate else { return }
        guard let input = checkedInput,
              let index = claims.firstIndex(where: { $0.id == id }),
              claims[index].claimId == nil else { return }

        let snapshot = claims[index]
        let hash = FactCheckClient.hash(of: input)
        guard let landed = await waitForClaimRow(hash: hash, claim: snapshot, body: input.fullText)?.id else { return }
        guard let index = claims.firstIndex(where: { $0.id == id }), claims[index].claimId == nil else { return }
        claims[index].claimId = landed
    }

    /// Wait out Flow A's annotation write on a settled, keyless claim.
    ///
    /// The wait protects against a tap that would buy a run already under way, and a write that
    /// arrives ends it early (see `mergeAnnotationPayload`) rather than leaving the button dark for
    /// the full window. Past the window the button comes back regardless, so a write that never
    /// landed does not leave a claim that can never be annotated.
    private func markAwaitingAnnotations(on id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }), claims[index].missingAnnotations else { return }
        claims[index].awaitingAnnotations = true

        annotationWaitTasks[id]?.cancel()
        annotationWaitTasks[id] = Task {
            try? await Task.sleep(nanoseconds: UInt64(Self.annotationWait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self.setAwaitingAnnotations(false, on: id)
            self.annotationWaitTasks[id] = nil
        }
    }

    // MARK: - Realtime

    /// Fold a payload off the subscription into the claim it describes.
    ///
    /// Deliberately narrower than `adopt`, and the difference is the whole reason the two are
    /// separate. `adopt` fills a claim's verdict from a row it read back, where the row is the
    /// answer to a question the app just asked. A broadcast can arrive for a claim that is still
    /// being classified — carrying the verdict from before the run in flight — and letting that
    /// overwrite what is streaming in would walk the card backwards mid-answer. So a payload is
    /// taken for the two things the stream never carries: the row's id, and its annotations.
    private func mergeAnnotationPayload(_ payload: [String: Any], hash: String, body: String) {
        let locale = FactCheckClient.uiLocale
        let row = FactCheckClient.claimRow(fromPayload: payload, body: body, locale: locale)
        let named = claims.firstIndex(where: { FactCheckClient.row(row, describes: $0, body: body) })
        let id = row.id?.prefix(8) ?? "nil"
        let matched = named.map { String($0) } ?? "no"
        let reasoning = row.reasoning?.count ?? -1
        let locale_ = row.reasoningLocale ?? "nil"
        let veracity = row.veracity.map { String($0) } ?? "nil"
        note("payload \(id) for \(hash.prefix(8)): reclassify=\(row.reclassify) matched=\(matched) answered=\(row.isAnswered) reasoning=\(reasoning)ch locale=\(locale_) classifying=\(row.isClassifying) veracity=\(veracity)")
        if let id = row.id {
            var seen = claimRowsSeen[hash] ?? []
            // REPLACE by id, never skip: a claim's row is written more than once, and the
            // payloads are snapshots of the same row at different moments. The link comes first
            // (the preclassifier's own insert: no reasoning, veracity 0) and the classification's
            // write comes second (the verdict, the reasoning). Keeping the first — which is what
            // a `contains` guard here did — froze this cache at the pre-classification snapshot
            // for the rest of the tab's life, so EVERY later lookup adopted a row that said
            // "nobody has answered this" and the refresh bought a classification for a claim the
            // database had answered, the app had already paid for, and the subscription had
            // already delivered twice.
            //
            // A whole array per id rather than one row: a tweet links several claims, and each
            // keeps its own last-known row.
            if let existing = seen.firstIndex(where: { $0.id == id }) {
                seen[existing] = row
            } else {
                seen.append(row)
            }
            claimRowsSeen[hash] = seen
        }

        // This row is exactly what a research or an adoption waiting on this claim's row is waiting
        // for. Handed over whole, because whether the row says anything is the caller's business:
        // naming a claim needs only its id, and settling it needs the verdict.
        for waiter in claimRowWaiters
        where waiter.hash == hash && FactCheckClient.row(row, describes: waiter.claim, body: body) {
            guard row.id != nil else { continue }
            resolve(waiter, with: row)
        }

        guard let index = named else { return }

        // Adopted even when the payload carries no annotations: this is the id a later Annotate tap
        // hands the worker, and what makes the next match exact rather than textual, so a claim
        // first researched in this app stops being anonymous.
        if claims[index].claimId == nil { claims[index].claimId = row.id }
        if !row.annotations.isEmpty {
            claims[index].annotations = row.annotations
        }

        // A key in the payload at all — even one this locale cannot paint — is Flow A having
        // written, and that is what ends the wait. Read off the payload rather than off the
        // revision-filtered row, which drops keys for other revisions and would leave the wait
        // running against a write that has already happened.
        let wrote = !((payload["annotations"] as? [String: Any])?.isEmpty ?? true)
        if wrote { setAwaitingAnnotations(false, on: claims[index].id) }
    }

    /// Open a NEW subscription for this text's hash, replacing any handle already held.
    ///
    /// Always new, however alive the old one looks, and `utils/realtime.ts` says why: what a
    /// subscription needs is a server-side routing row, and only a NEW subscription writes one. A
    /// handle is not a routing row, and the two do not die together — the preclassification
    /// teardown DELETEs the tweet's routing rows while the subscription row behind the handle
    /// survives until its own expiry. A reused handle is then permanently inert while reporting
    /// itself open, and every write it should have relayed is dropped in silence.
    private func openAnnotationSubscription(for input: FactCheckInput) {
        let hash = FactCheckClient.hash(of: input)
        let body = input.fullText
        tweetSubscriptions[hash]?.close()

        let reference = SubscriptionReference()
        // Weak throughout, and not for the registration itself — that is over in a moment. The two
        // closures below outlive it, held by the client for the life of the subscription, and a
        // strong capture there would keep this view model alive behind a socket up to five minutes
        // after the text it belongs to is gone.
        Task { [weak self] in
            let handle = await SupabaseRealtime.shared.subscribeRow(
                kind: .tweet,
                hash: hash,
                timeout: Self.annotationSubscription,
                onClaim: { [weak self] payload in
                    self?.mergeAnnotationPayload(payload, hash: hash, body: body)
                },
                onDone: { [weak self] in
                    // Only forget the handle this closure was made for: a later subscription may
                    // already have taken its place, and removing that one would leave a live
                    // handle unreachable.
                    guard let self, let id = reference.id, self.tweetSubscriptions[hash]?.id == id else { return }
                    self.tweetSubscriptions[hash] = nil
                }
            )
            reference.id = handle?.id
            guard let handle, let self else { return }
            if self.tweetSubscriptions[hash] == nil || self.tweetSubscriptions[hash]?.id == handle.id {
                self.tweetSubscriptions[hash] = handle
            } else {
                // Something newer opened while this one was being registered; this handle is
                // redundant and the routing row it wrote is the newer one's to use.
                handle.close()
            }
        }
    }

    /// Close every open subscription and forget what they delivered. The checked text is going
    /// away, so neither a payload still on its way nor one already held describes anything on
    /// screen.
    private func closeAnnotationSubscriptions() {
        for handle in tweetSubscriptions.values { handle.close() }
        tweetSubscriptions.removeAll()
        claimRowsSeen.removeAll()
    }

    /// Wait for a preclassified claim's DB row, and answer with the row.
    ///
    /// A claim typed into this app is created by the preclassify worker's pipeline — embed, match,
    /// link, insert — which runs detached, after the claim text has already streamed. So at the
    /// moment the claim is on screen it has no row id, and research launched against it has
    /// nothing to name but the text. The subscription is what makes the insert observable.
    ///
    /// The whole row rather than the id the two callers used to get between them: `nameClaim` takes
    /// the id off it, and `adoptSettledClaimRows` needs what else the row says — a claim that is
    /// named but unanswered is not settled, and a lookup that answered with the id alone would have
    /// declared it so.
    ///
    /// Nil on timeout, and the caller carries on as before: waiting forever would be worse than a
    /// text match that misses, because the row may never arrive and research that never starts is
    /// a spinner with no end.
    private func waitForClaimRow(hash: String, claim: FactCheckClaim, body: String) async -> FactCheckClient.ClaimRow? {
        guard !hash.isEmpty else { return nil }
        // Already broadcast while the caller was doing something else, which is the common case
        // when several claims wait at once.
        if let known = claimRowsSeen[hash]?.first(where: {
            FactCheckClient.row($0, describes: claim, body: body)
        }) { return known }

        let waiter = ClaimRowWaiter(hash: hash, claim: claim)
        note("waiting \(Self.claimRowWait)s for \(hash.prefix(8)) to name \"\(claim.rewritten.prefix(30))\"")
        let expiry = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.claimRowWait * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.resolve(waiter, with: nil)
        }
        let row = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<FactCheckClient.ClaimRow?, Never>) in
                waiter.resume = { continuation.resume(returning: $0) }
                // Cancelled before we got here, so `onCancel` has already run and found nothing
                // to resume. Registering the waiter now would leave it waiting on a payload that
                // nothing is coming for — settle it here instead.
                if Task.isCancelled {
                    self.resolve(waiter, with: nil)
                } else {
                    self.claimRowWaiters.append(waiter)
                }
            }
        } onCancel: {
            Task { @MainActor in self.resolve(waiter, with: nil) }
        }
        expiry.cancel()
        return row
    }

    /// Settle one waiter, once. A waiter can be reached by the payload it was waiting for, by its
    /// own timeout, and by a cancelled research at the same moment; the first of those wins and
    /// the rest find nothing to resume.
    private func resolve(_ waiter: ClaimRowWaiter, with row: FactCheckClient.ClaimRow?) {
        guard let resume = waiter.resume else { return }
        waiter.resume = nil
        if let index = claimRowWaiters.firstIndex(where: { $0 === waiter }) {
            claimRowWaiters.remove(at: index)
        }
        resume(row)
    }

    /// Research waiting on a preclassified claim's DB row. The claim is held as it stood when the
    /// wait began, so the arrival test is the same text test the merge itself uses to decide which
    /// claim a payload describes.
    private final class ClaimRowWaiter {
        let hash: String
        let claim: FactCheckClaim
        var resume: ((FactCheckClient.ClaimRow?) -> Void)?

        init(hash: String, claim: FactCheckClaim) {
            self.hash = hash
            self.claim = claim
        }
    }

    /// Holds a subscription's id for the `onDone` closure, which is built before the handle it
    /// must recognise exists.
    private final class SubscriptionReference {
        var id: String?
    }

    /// Fold a row into the claim it describes: the id the annotate worker needs, the annotations
    /// the row holds, and — only when the claim has no answer of its own — the row's verdict. An
    /// answer already on screen belongs to the stream that produced it and is left alone.
    private func adopt(row: FactCheckClient.ClaimRow, on id: FactCheckClaim.ID, body: String) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        if claims[index].claimId == nil { claims[index].claimId = row.id }
        if !row.annotations.isEmpty { claims[index].annotations = row.annotations }

        guard claims[index].verdict == nil, row.isAnswered else { return }
        claims[index].verdict = FactCheckVerdict(
            confidence: row.probability ?? abs(row.veracity ?? 0),
            veracity: row.veracity,
            reasoning: row.reasoning ?? "",
            sources: row.sources
        )
        claims[index].isClassified = !row.reclassify
        claims[index].needsReclassify = row.reclassify
    }

    /// Show a set of annotations for the revision on screen, keyed by locale the way the worker's
    /// own column is — so "ranges to correct" and "reviewed, nothing to correct" (an empty dict
    /// under a locale key) stay as distinguishable here as they are in the database.
    private func paint(_ ranges: [String: String], on id: FactCheckClaim.ID, locale: String) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].annotations = [locale: ranges]
    }

    private func apply(_ verdict: FactCheckVerdict, to id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].verdict = verdict
        // A verdict that arrives clears whatever went wrong before it: the user pressed the button
        // again and it worked, and an old error above a fresh answer reads as a live failure.
        claims[index].errorMessage = nil
        // The answer this run was asked for is on screen, so the claim is settled — and no longer
        // a re-run, whatever the row it came from said about its date.
        claims[index].isClassified = true
        claims[index].needsReclassify = false
    }

    private func fail(with reason: String, on id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].errorMessage = reason
        // Every research failure lands here — a worker that refused, a worker that answered with
        // nothing, a request that never arrived — so this is the one place that has to know the
        // page's red toast has a native counterpart.
        FactCheckNotifier.shared.reportFailure(reason)
    }

    /// Whether the tab has work in flight, which is the only window in which a balance change can
    /// be attributed to it. One expression, called from every place that moves `isPreclassifying`,
    /// `researchTasks` or `annotateTasks`, so the notifier and the model cannot disagree about what
    /// "busy" means — or about which pass is running.
    ///
    /// `phase` goes along as the name of last resort, for a charge read with nothing left in the
    /// notifier's queue to claim it. Which pass a charge belongs to is registered at its request
    /// instead: one press can buy two passes, and the pass that ran on its own is not the pass the
    /// user pressed. See `FactCheckNotifier.willBill`.
    private func refreshWorkState() {
        FactCheckNotifier.shared.setWorking(isBusy, activity: phase)
    }

    private func setResearching(_ value: Bool, on id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].isResearching = value
    }

    private func setAnnotating(_ value: Bool, on id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].isAnnotating = value
    }

    private func setAwaitingAnnotations(_ value: Bool, on id: FactCheckClaim.ID) {
        guard let index = claims.firstIndex(where: { $0.id == id }) else { return }
        claims[index].awaitingAnnotations = value
    }

    private func cancelAll() {
        preclassifyTask?.cancel()
        preclassifyTask = nil
        for task in researchTasks.values { task.cancel() }
        researchTasks.removeAll()
        for task in annotateTasks.values { task.cancel() }
        annotateTasks.removeAll()
        for task in annotationWaitTasks.values { task.cancel() }
        annotationWaitTasks.removeAll()
        // Released rather than left suspended: every waiter belongs to a research task that was
        // just cancelled, and a continuation nobody will ever resume is a leak. Each then finds
        // its own task cancelled and stops.
        for waiter in claimRowWaiters { resolve(waiter, with: nil) }
        // The batch goes with the tasks that were carrying it. A queue left behind would be
        // admitted against the text that replaced this one, and its reservations would go on
        // sizing a balance nothing of it is spending from.
        //
        // Dropping `admitted` here is also what makes the cancelled runs safe: a cancellation
        // reaches a task blocked on an await only when that await returns, so some of these runs
        // end after a later batch has admitted its own, and every one of them then finds its id
        // already gone and releases nothing. See `admitted`.
        waitlist.removeAll()
        admitted.removeAll()
        batchTotal = nil
        batchTotalRead?.cancel()
        batchTotalRead = nil
        refreshWorkState()
    }
}
