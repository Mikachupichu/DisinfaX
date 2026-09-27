import SwiftUI

/// The share sheet's fact-check surface: the app's own `FactCheckView`, run on what was shared
/// before the user has a chance to ask for it.
///
/// Deliberately nothing but the app's view, minus the header the sheet's own bar already says. The
/// model is the app's `FactCheckModel` and the run is `disinfact()`, so preclassification, the
/// lone-claim shortcut, the annotation subscription and the billing are one code path, not two that
/// have to be kept in agreement.
///
/// The model belongs to the controller rather than to this view, for the reason `FactCheckView`
/// gives — and here for one more. The shared text is read asynchronously, so a view that took it as
/// a `let` could not be built until the read came back; on macOS that meant installing the hosting
/// view in the middle of the host's own layout pass, which AppKit refuses reentrantly and answers by
/// skipping the pass, leaving the panel empty. Taking the model instead lets the controller build
/// the hierarchy when its view loads and hand the text over later.
struct ShareFactCheckView: View {
    @ObservedObject var model: FactCheckModel

    /// Ends the share request, which is what takes the panel down. Supplied on macOS and not on
    /// iOS, and the difference is the container's rather than ours: an iOS sheet is dismissed by
    /// swiping it, the way every other sheet is, and a button there would draw a second way out of
    /// something that already had one. A macOS panel is a bare service window — no title bar,
    /// ShareKit puts no control of its own on it — so without this there is no way out but to end
    /// the share in the host app. Absent, no button is drawn.
    var onClose: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            if let onClose {
                // Trailing rather than right: an RTL language mirrors this, which is the corner
                // its reader looks in for a dismissal, the same way the panes themselves mirror.
                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    closeButton(onClose)
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
            }

            // The header is dropped: the sheet is presented under a bar that already reads
            // "DisinfaX", and a second one directly beneath it says nothing the user does not
            // already know. Nothing else is taken away — this is the app's view, with the app's own
            // controls.
            FactCheckView(model: model, showsHeader: false)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Its own row rather than an overlay on the corner of the fact-check surface: the surface
    /// starts with an editor card that reaches that corner, and a button floating over it would sit
    /// on the first line the user is typing into.
    private func closeButton(_ close: @escaping () -> Void) -> some View {
        Button(action: close) {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .semibold))
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(Text("Close"))
#if os(macOS)
        .help(Text("Close"))
#endif
    }
}
