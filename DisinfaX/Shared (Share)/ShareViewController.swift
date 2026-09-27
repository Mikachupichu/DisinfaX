import SwiftUI
import UniformTypeIdentifiers

#if os(iOS)
import UIKit

/// The share sheet's entry point on iOS.
///
/// A share extension is not the app: it is handed an `NSExtensionContext` instead of a
/// `UIApplication`, it cannot be launched on its own, and it is torn down the moment its request
/// ends. So this controller does the one thing that needs that context — read what was shared —
/// and hands everything else to `ShareFactCheckView`.
///
/// Nothing here ends the request, because nothing on screen offers to: the fact-check surface has
/// no completion of its own (the extension returns no items, and never did), so the sheet is
/// closed the way any other is, by the gesture the system puts on it. That leaves the swipe-down
/// dismissal as both the only exit and the correct one — the alternative was a Done button
/// drawing a way out that the container was already providing.
final class ShareViewController: UIViewController {
    /// The model is the controller's rather than the view's: the shared text arrives after the read,
    /// and a view that owned its model would have to be built with that text already in hand.
    private let model = FactCheckModel()
    private var installed = false

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Once: `viewWillAppear` runs again if the sheet is re-presented, and a second install
        // would be a second fact-check of the same text, and a second charge for it.
        guard !installed else { return }
        installed = true

        Task { @MainActor in
            let text = await ShareItem.text(from: extensionContext)
            install()
            run(text)
        }
    }

    private func install() {
        let host = UIHostingController(rootView: ShareFactCheckView(model: model))
        host.view.backgroundColor = .systemBackground
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        // The width the app's own pane is drawn at, so the shared UI is not reflowed into a shape
        // it was never laid out for; the height because an iPad popover is otherwise sized from a
        // proposal with nothing of its own to go on.
        preferredContentSize = CGSize(width: 392, height: 640)
    }

    /// The automatic run on whatever was shared — nil when the item carried no text, which leaves
    /// the app's own empty editor to type into.
    ///
    /// `disinfact()` is left to decide whether it may spend, exactly as the app's buttons are: a
    /// share into a session that needs refreshing draws `FactCheckView`'s own signed-out notice,
    /// which is the sentence that already tells the user what to do about it.
    private func run(_ text: String?) {
        guard let text else { return }
        model.inputText = text
        model.disinfact()
    }
}
#endif

#if os(macOS)
import AppKit

/// The share sheet's entry point on macOS.
///
/// The whole hierarchy is built in `loadView`, before the host has laid anything out, and the shared
/// text is handed to the model afterwards. Building it from the read instead — which is where the
/// text becomes available — put the hosting view into the hierarchy in the middle of ShareKit's own
/// layout pass. AppKit refuses that reentrantly, says so ("NSHostingView is being laid out
/// reentrantly while rendering its SwiftUI content"), skips the pass, and the panel comes up with
/// the SwiftUI content never laid out at all: a window with nothing in it. Hence a view that takes
/// the model rather than the text.
///
/// The size is set three times for a related reason. ShareKit takes the panel's size from
/// `preferredContentSize` but drops any request that arrives while the service is still `Opening`,
/// which is when the first two land; the one in `viewDidAppear` is the set it accepts.
final class ShareViewController: NSViewController {
    /// The width the app's own pane is drawn at, so the shared UI is not reflowed into a shape it
    /// was never laid out for; the height because a panel is otherwise sized from a proposal with
    /// nothing of its own to go on.
    private static let panelSize = NSSize(width: 392, height: 640)

    private let model = FactCheckModel()
    private var textRead: Task<Void, Never>?

    override func loadView() {
        // ShareKit does not size this view. Measured: the view is 0×0 when it loads and still 0×0
        // a second and a half after the panel is on screen, with the content pinned inside it 0×0
        // in turn — a panel with nothing in it, which is what "no window opens" turns out to mean.
        // `preferredContentSize` is published throughout and does not move it, so the frame is ours
        // to set.
        view = NSView(frame: NSRect(origin: .zero, size: Self.panelSize))
        preferredContentSize = Self.panelSize

        let host = NSHostingController(rootView: ShareFactCheckView(model: model, onClose: { [weak self] in
            self?.closePanel()
        }))
        // The app's own window needed this too, for the reason given where it sets it there. Here it
        // is load-bearing in a second way: the default `.preferredContentSize` has the hosting
        // controller publish a size computed from the SwiftUI content, and this controller is
        // publishing one of its own — the two resize each other mid-pass. AppKit refuses the
        // re-entry, logs the refusal, and skips the layout pass the content needed. The panel's size
        // is ours to set; the content is pinned to it.
        host.sizingOptions = []
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        report("loadView")
    }

    override func viewWillAppear() {
        super.viewWillAppear()
        preferredContentSize = Self.panelSize
        report("viewWillAppear")

        // Once: a second read would be a second fact-check of the same text, and a second charge
        // for it.
        guard textRead == nil else { return }
        textRead = Task { @MainActor in
            let text = await ShareItem.text(from: extensionContext)
            run(text)
        }
    }

    /// The set ShareKit honours: by the time the view has appeared the service has left `Opening`.
    override func viewDidAppear() {
        super.viewDidAppear()
        preferredContentSize = Self.panelSize
        assertPanelSize()
        report("viewDidAppear")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.report("t+1.5s") }
    }

    /// The frame is re-asserted rather than set once, for the same reason `ViewController` re-asserts
    /// its own: the view is put into the panel's window after it loads, and AppKit is free to give it
    /// that window's frame — or nothing at all, which is what it did — on the way in. Convergent: the
    /// second pass finds the sizes equal and does nothing.
    override func viewDidLayout() {
        super.viewDidLayout()
        assertPanelSize()
    }

    private func assertPanelSize() {
        guard view.frame.size != Self.panelSize else { return }
        view.frame = NSRect(origin: .zero, size: Self.panelSize)
    }

    /// The automatic run on whatever was shared — nil when the item carried no text, which leaves
    /// the app's own empty editor to type into.
    ///
    /// `disinfact()` is left to decide whether it may spend, exactly as the app's buttons are: a
    /// share into a session that needs refreshing draws `FactCheckView`'s own signed-out notice,
    /// which is the sentence that already tells the user what to do about it.
    private func run(_ text: String?) {
        report("run text=\(text?.count ?? -1)")
        guard let text else { return }
        model.inputText = text
        model.disinfact()
    }

    /// Ends the request, which is what takes the panel down — this is the x in the panel's top
    /// corner, and the only dismissal there is. The iOS sheet needs no equivalent: it has the
    /// system's own swipe.
    private func closePanel() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    /// TEMPORARY. The panel is presented — ShareKit logs `Service window did show` — but nothing is
    /// visible, and `NSLog` from this process does not reach the unified log. So the geometry goes to
    /// a file in the group container instead, which is known to be reachable.
    private func report(_ stage: String) {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "WJFG5784YR.group.app.disinfax") else { return }
        let window = view.window
        let host = view.subviews.first
        let line = "\(stage) window=\(window.map { NSStringFromRect($0.frame) } ?? "nil") content=\(window.map { NSStringFromRect($0.contentLayoutRect) } ?? "nil") view=\(NSStringFromRect(view.frame)) host=\(host.map { NSStringFromRect($0.frame) } ?? "none") subs=\(view.subviews.count) preferred=\(NSStringFromSize(preferredContentSize))\n"

        let file = container.appendingPathComponent("panel-diag.log")
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? line.write(to: file, atomically: true, encoding: .utf8)
        }
    }
}
#endif

/// The text out of whatever was shared.
///
/// Text only, and never a link: the activation rule offers this sheet for nothing else, the web is
/// already covered by the Safari extension, and the fact-check pipeline reads whatever it is sent
/// as prose — `FactCheckInput` has no notion of a URL, and the worker's `validTweetShape` only asks
/// for a non-empty string — so a URL let through here would be researched as a claim and billed.
///
/// Sources still disagree about which type identifier carries text — a selection arrives as
/// `public.plain-text` from one app and `public.text` from the next, and some hand back an
/// `NSAttributedString` on the item itself and attach nothing at all — so every one of them is
/// tried.
enum ShareItem {
    /// The shared text, or nil when the item carries none the sheet can use.
    nonisolated static func text(from context: NSExtensionContext?) async -> String? {
        guard let items = context?.inputItems as? [NSExtensionItem] else { return nil }

        for item in items {
            // Where most sources put the text, and the only one that needs no round trip through
            // the item provider.
            if let attributed = item.attributedContentText, let text = clean(attributed.string) {
                return text
            }
            for provider in item.attachments ?? [] {
                if let text = await load(provider, as: .plainText) { return text }
                if let text = await load(provider, as: .text) { return text }
            }
        }
        return nil
    }

    private nonisolated static func load(_ provider: NSItemProvider, as type: UTType) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(type.identifier) else { return nil }
        let loaded = await withCheckedContinuation { (continuation: CheckedContinuation<NSSecureCoding?, Never>) in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
                continuation.resume(returning: item)
            }
        }
        return loaded.flatMap(string(from:))
    }

    /// The shapes a text payload actually arrives in. `Data` is in the list because a provider
    /// that vends `public.plain-text` is within its rights to hand over the bytes.
    private nonisolated static func string(from item: NSSecureCoding) -> String? {
        switch item {
        case let value as String: return clean(value)
        case let value as NSString: return clean(value as String)
        case let value as NSAttributedString: return clean(value.string)
        case let value as Data: return clean(String(data: value, encoding: .utf8))
        default: return nil
        }
    }

    private nonisolated static func clean(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
